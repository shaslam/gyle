// Storage backend: a GitHub repo, through the GitHub contents API. Every save is a commit.
//   recipes/<id>.json   brews/<id>.json   settings.json
//
// Every backend has the same shape, so the store does not care which one it is talking to:
//   id          a string naming where the data lives (changes when you switch repo or account)
//   ready       can read        canWrite   can save
//   list(kind)                         -> Map of document id -> version
//   read(kind, id)                     -> { payload, version }
//   write(kind, id, payload, version, message) -> new version
//   remove(kind, id, version, message)

const API = 'https://api.github.com';
const LS = 'gyle.github.v1';
const pathOf = (kind, id) => (kind === 'settings' ? 'settings.json' : `${kind}/${id}.json`);
const b64 = s => {
  let bin = '';
  new TextEncoder().encode(s).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
};
const unb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));

export class GitBackend {
  auto = false; // saving is an explicit commit
  words = {
    save: 'Commit to repo', saved: 'In the repo', done: 'Committed to the repo.', all: 'All changes committed.',
    pending: n => `${n} to commit`, unsaved: 'uncommitted', need: 'Connect a repo and add a token in Settings to save to GitHub.',
  };
  config = { owner: '', repo: '', branch: 'main', token: '' };

  constructor() {
    try { Object.assign(this.config, JSON.parse(localStorage.getItem(LS)) || {}); } catch { /* no saved connection */ }
  }
  configure(c) {
    Object.assign(this.config, c);
    try { localStorage.setItem(LS, JSON.stringify(this.config)); } catch { /* not remembered */ }
  }
  get id() { return `git:${this.config.owner}/${this.config.repo}@${this.config.branch}`; }
  get ready() { return !!(this.config.owner && this.config.repo); }
  get canWrite() { return this.ready && !!this.config.token; }

  async #api(method, path, body) {
    const { owner, repo, branch, token } = this.config;
    const url = `${API}/repos/${owner}/${repo}${path}${method === 'GET' && path.startsWith('/contents') ? `?ref=${encodeURIComponent(branch)}` : ''}`;
    let res;
    try {
      res = await fetch(url, {
        method, cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Object.assign(new Error('Could not reach GitHub. Check your connection.'), { status: 0 });
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const msg = {
        401: 'GitHub rejected the token. Create a new one in Settings.',
        403: token ? `GitHub refused: ${detail.message || 'the token may lack Contents write access'}.` : 'GitHub rate limit reached. Add a token in Settings.',
        404: 'Not found on GitHub.',
      }[res.status] || `GitHub error ${res.status}: ${detail.message || res.statusText}`;
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return res.json();
  }

  // Check the repo exists and report whether the token can write to it.
  async verify() {
    try {
      const info = await this.#api('GET', '');
      return { ok: true, canPush: !!info.permissions?.push, defaultBranch: info.default_branch, private: info.private };
    } catch (e) {
      if (e.status === 404) throw new Error(`Repo ${this.config.owner}/${this.config.repo} not found. If it is private, the token needs access to it.`);
      throw e;
    }
  }

  async list(kind) {
    try {
      if (kind === 'settings') return new Map([['settings', (await this.#api('GET', '/contents/settings.json')).sha]]);
      const items = await this.#api('GET', `/contents/${kind}`);
      return new Map((Array.isArray(items) ? items : []).filter(f => f.type === 'file' && f.name.endsWith('.json')).map(f => [f.name.slice(0, -5), f.sha]));
    } catch (e) {
      if (e.status === 404) return new Map(); // folder or file not created yet
      throw e;
    }
  }
  async read(kind, id) {
    const meta = await this.#api('GET', `/contents/${pathOf(kind, id)}`);
    return { payload: JSON.parse(unb64(meta.content)), version: meta.sha };
  }
  async write(kind, id, payload, version, message) {
    const path = `/contents/${pathOf(kind, id)}`, { branch } = this.config;
    const put = sha => this.#api('PUT', path, { message, branch, content: b64(JSON.stringify(payload, null, 2) + '\n'), ...(sha ? { sha } : {}) });
    try {
      return (await put(version)).content.sha;
    } catch (e) {
      // The file changed in the repo since we last looked: take its current version and save over it.
      if (e.status !== 409 && e.status !== 422) throw e;
      let current;
      try { current = (await this.#api('GET', path)).sha; } catch (e2) { if (e2.status !== 404) throw e2; }
      return (await put(current)).content.sha;
    }
  }
  async remove(kind, id, version, message) {
    if (!version) return;
    try {
      await this.#api('DELETE', `/contents/${pathOf(kind, id)}`, { message, sha: version, branch: this.config.branch });
    } catch (e) {
      if (e.status !== 404) throw e; // already gone
    }
  }
}

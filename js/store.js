// Storage. Every document lives in two places:
//   1. a working copy in this browser (localStorage), so edits are never lost mid-brew;
//   2. a file in the GitHub repo, written through the GitHub contents API. Each save is a commit.
// Layout in the repo:  recipes/<id>.json (BeerJSON)   brews/<id>.json   settings.json

import { toBeerJSON, fromBeerJSON } from './beerjson.js';

const LS_CACHE = 'gyle.cache.v1';
const LS_GH = 'gyle.github.v1';
const KINDS = ['recipes', 'brews', 'settings'];
const API = 'https://api.github.com';

const pathOf = (kind, id) => (kind === 'settings' ? 'settings.json' : `${kind}/${id}.json`);
const serialize = (kind, data) => JSON.stringify(kind === 'recipes' ? toBeerJSON(data) : data, null, 2) + '\n';
const parse = (kind, text) => (kind === 'recipes' ? fromBeerJSON(JSON.parse(text))[0] : JSON.parse(text));
const b64 = s => {
  let bin = '';
  new TextEncoder().encode(s).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
};
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

function detectRepo() {
  const m = /^([\w-]+)\.github\.io$/.exec(location.hostname);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo && !repo.includes('.') ? { owner: m[1], repo } : {};
}

class Store {
  docs = { recipes: {}, brews: {}, settings: {} };  // id -> { data, sha, dirty, deleted }
  gh = { owner: '', repo: '', branch: 'main', token: '' };
  status = { state: 'local', message: '' };
  #listeners = new Set();
  #persistTimer = null;
  #busy = false;

  init() {
    const cached = ls.get(LS_CACHE);
    if (cached) for (const k of KINDS) this.docs[k] = cached[k] || {};
    this.gh = { ...this.gh, ...detectRepo(), ...(ls.get(LS_GH) || {}) };
    this.status.state = this.connected ? 'idle' : 'local';
  }

  get connected() { return !!(this.gh.owner && this.gh.repo); }
  get canWrite() { return this.connected && !!this.gh.token; }
  get dirtyCount() {
    return KINDS.reduce((n, k) => n + Object.values(this.docs[k]).filter(d => d.dirty).length, 0);
  }

  on(fn) { this.#listeners.add(fn); }
  #emit() { this.#listeners.forEach(fn => fn()); }
  #setStatus(state, message = '') { this.status = { state, message }; this.#emit(); }
  persist() { ls.set(LS_CACHE, this.docs); }

  // ---- working copy ----
  get(kind, id) { const d = this.docs[kind][id]; return d && !d.deleted ? d.data : undefined; }
  list(kind) {
    return Object.entries(this.docs[kind]).filter(([, d]) => !d.deleted).map(([id, d]) => ({ id, data: d.data, dirty: d.dirty }));
  }
  isDirty(kind, id) { return !!this.docs[kind][id]?.dirty; }
  put(kind, id, data) {
    const old = this.docs[kind][id];
    this.docs[kind][id] = { data, sha: old?.sha, dirty: true };
    this.persist();
    this.#emit();
  }
  // Mark an object you edited in place as changed. Writes to the browser after a short pause.
  touch(kind, id) {
    const d = this.docs[kind][id];
    if (!d) return;
    const was = d.dirty;
    d.dirty = true;
    clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => this.persist(), 400);
    if (!was) this.#emit();
  }
  remove(kind, id) {
    const d = this.docs[kind][id];
    if (!d) return;
    if (d.sha) { d.deleted = true; d.dirty = true; } else delete this.docs[kind][id];
    this.persist();
    this.#emit();
  }

  // ---- GitHub ----
  configure(gh) {
    this.gh = { ...this.gh, ...gh };
    ls.set(LS_GH, this.gh);
    this.#setStatus(this.connected ? 'idle' : 'local');
  }

  async #api(method, path, body, raw = false) {
    const { owner, repo, branch, token } = this.gh;
    const url = `${API}/repos/${owner}/${repo}${path}${method === 'GET' && path.startsWith('/contents') ? `?ref=${encodeURIComponent(branch)}` : ''}`;
    let res;
    try {
      res = await fetch(url, {
        method, cache: 'no-store',
        headers: {
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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
    return raw ? res.text() : res.json();
  }

  // Check the repo exists and report whether the token can write to it.
  async verify() {
    try {
      const info = await this.#api('GET', '');
      return { ok: true, canPush: !!info.permissions?.push, defaultBranch: info.default_branch, private: info.private };
    } catch (e) {
      if (e.status === 404) throw new Error(`Repo ${this.gh.owner}/${this.gh.repo} not found. If it is private, the token needs access to it.`);
      throw e;
    }
  }

  async #listDir(dir) {
    try {
      const items = await this.#api('GET', `/contents/${dir}`);
      return Array.isArray(items) ? items.filter(f => f.type === 'file' && f.name.endsWith('.json')) : [];
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  // Pull anything that changed in the repo. Local uncommitted edits are kept.
  async sync() {
    if (!this.connected || this.#busy) return;
    this.#busy = true;
    this.#setStatus('syncing');
    try {
      for (const kind of ['recipes', 'brews']) {
        const remote = new Map((await this.#listDir(kind)).map(f => [f.name.slice(0, -5), f.sha]));
        const docs = this.docs[kind];
        for (const [id, sha] of remote) {
          const d = docs[id];
          if (d?.dirty) { d.sha = sha; continue; }
          if (d?.sha === sha) continue;
          try {
            docs[id] = { data: parse(kind, await this.#api('GET', `/contents/${pathOf(kind, id)}`, null, true)), sha, dirty: false };
          } catch (e) {
            if (e.status !== undefined) throw e;
            console.warn(`Skipped ${pathOf(kind, id)}: ${e.message}`);
          }
        }
        for (const id of Object.keys(docs)) {
          if (remote.has(id)) continue;
          if (!docs[id].dirty) delete docs[id];
          else docs[id].sha = undefined;
        }
      }
      const s = this.docs.settings.settings;
      try {
        const meta = await this.#api('GET', '/contents/settings.json');
        if (s?.dirty) s.sha = meta.sha;
        else if (s?.sha !== meta.sha) {
          const bytes = Uint8Array.from(atob(meta.content.replace(/\s/g, '')), c => c.charCodeAt(0));
          this.docs.settings.settings = { data: JSON.parse(new TextDecoder().decode(bytes)), sha: meta.sha, dirty: false };
        }
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      this.persist();
      this.#setStatus('synced');
    } catch (e) {
      this.#setStatus('error', e.message);
    } finally {
      this.#busy = false;
    }
  }

  async #pushOne(kind, id, message) {
    const d = this.docs[kind][id];
    if (!d?.dirty) return;
    const path = `/contents/${pathOf(kind, id)}`;
    const { branch } = this.gh;
    const attempt = async () => {
      if (d.deleted) {
        if (d.sha) await this.#api('DELETE', path, { message, sha: d.sha, branch });
        delete this.docs[kind][id];
      } else {
        const res = await this.#api('PUT', path, { message, content: b64(serialize(kind, d.data)), branch, ...(d.sha ? { sha: d.sha } : {}) });
        d.sha = res.content.sha;
        d.dirty = false;
      }
    };
    try {
      await attempt();
    } catch (e) {
      // The file changed in the repo since we last looked: take its current sha and save over it.
      if (e.status !== 409 && e.status !== 422) throw e;
      try { d.sha = (await this.#api('GET', path)).sha; } catch (e2) { if (e2.status === 404) d.sha = undefined; else throw e2; }
      await attempt();
    }
  }

  #message(kind, id) {
    const d = this.docs[kind][id];
    const what = kind === 'settings' ? 'settings' : `${kind.slice(0, -1)}: ${d.data?.name || id}`;
    return `${d.deleted ? 'Delete' : d.sha ? 'Update' : 'Add'} ${what}`;
  }

  // Commit one document, or every uncommitted one when called with no arguments.
  async push(kind, id) {
    if (!this.canWrite) throw new Error('Connect a repo and add a token in Settings to save to GitHub.');
    if (this.#busy) throw new Error('Still syncing. Try again in a moment.');
    this.#busy = true;
    this.#setStatus('syncing');
    clearTimeout(this.#persistTimer);
    try {
      const targets = kind ? [[kind, id]] : KINDS.flatMap(k => Object.keys(this.docs[k]).filter(i => this.docs[k][i].dirty).map(i => [k, i]));
      for (const [k, i] of targets) await this.#pushOne(k, i, this.#message(k, i));
      this.persist();
      this.#setStatus('synced');
    } catch (e) {
      this.persist();
      this.#setStatus('error', e.message);
      throw e;
    } finally {
      this.#busy = false;
    }
  }

  // Throw away local edits to one document and take the repo's version.
  async revert(kind, id) {
    const d = this.docs[kind][id];
    if (!d) return;
    if (!d.sha) { delete this.docs[kind][id]; } else {
      const text = await this.#api('GET', `/contents/${pathOf(kind, id)}`, null, true);
      const meta = await this.#api('GET', `/contents/${pathOf(kind, id)}`);
      this.docs[kind][id] = { data: parse(kind, text), sha: meta.sha, dirty: false };
    }
    this.persist();
    this.#emit();
  }
}

export const store = new Store();

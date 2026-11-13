// Storage backend: a Supabase project ("Gyle account"). Sign-in is Supabase Auth; data is one
// table of JSON documents, and row-level security means each person only ever sees their own.
// It talks to Supabase's plain web API with fetch, so no extra library is loaded.
// Same shape as the git backend (see backend-git.js). Database setup is in supabase/setup.sql.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { native, APP_LINK } from './native.js';

const LS = 'gyle.supabase.v1';
const read = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
// Where a sign-in link brings the person back to: this page, or the Android or iOS app.
const comeBack = () => encodeURIComponent(native ? APP_LINK : location.origin + location.pathname);

export class SupabaseBackend {
  auto = true; // changes save themselves a moment after you stop typing
  words = {
    save: 'Save now', saved: 'Saved', done: 'Saved to your account.', all: 'Everything is saved.',
    pending: n => `${n} to save`, unsaved: 'not saved yet', need: 'Sign in to your Gyle account in Settings to save.',
  };
  #state = read(); // { url, key, session: { access_token, refresh_token, expires_at, user: { id, email } } }
  recovering = false; // true after arriving from a password-reset email

  get builtIn() { return !!(SUPABASE_URL && SUPABASE_KEY); }
  // The project's base address. A copied API address such as .../rest/v1/ is cut back to the base.
  get url() { return (SUPABASE_URL || this.#state.url || '').trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1$/, ''); }
  get key() { return SUPABASE_KEY || this.#state.key || ''; }
  get configured() { return !!(this.url && this.key); }
  get user() { return this.#state.session?.user || null; }
  get id() { return `supabase:${this.user?.id || ''}`; }
  get ready() { return this.configured && !!this.user; }
  get canWrite() { return this.ready; }

  #save() { try { localStorage.setItem(LS, JSON.stringify(this.#state)); } catch { /* not remembered */ } }
  configure({ url, key }) { this.#state.url = (url || '').trim(); this.#state.key = (key || '').trim(); this.#save(); }

  async #fetch(path, { method = 'GET', body, token, headers = {} } = {}) {
    if (!this.configured) throw new Error('Enter the Supabase project URL and public key first.');
    let res;
    try {
      res = await fetch(this.url + path, {
        method, cache: 'no-store',
        headers: { apikey: this.key, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Object.assign(new Error('Could not reach your Gyle account. Check your connection; if the Supabase project was paused for inactivity, restore it from the Supabase dashboard.'), { status: 0 });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = data?.msg || data?.error_description || data?.message || (typeof data?.error === 'string' ? data.error : '') || `Supabase error ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status, code: data?.error_code || data?.code });
    }
    return data;
  }

  // ---- sign-in ----
  #setSession(s, user) {
    this.#state.session = {
      access_token: s.access_token, refresh_token: s.refresh_token,
      expires_at: s.expires_at ? s.expires_at * 1000 : Date.now() + (s.expires_in || 3600) * 1000,
      user: { id: (s.user || user).id, email: (s.user || user).email },
    };
    this.#save();
  }
  async signIn(email, password) {
    this.#setSession(await this.#fetch('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
  }
  // Resolves 'signed-in', or 'confirm' when the project wants the email address confirmed first.
  async signUp(email, password) {
    const out = await this.#fetch(`/auth/v1/signup?redirect_to=${comeBack()}`, { method: 'POST', body: { email, password } });
    if (out?.access_token) { this.#setSession(out); return 'signed-in'; }
    return 'confirm';
  }
  async signOut() {
    const token = this.#state.session?.access_token;
    this.#state.session = null; this.recovering = false;
    this.#save();
    if (token) await this.#fetch('/auth/v1/logout', { method: 'POST', token }).catch(() => {});
  }
  // Send the browser to GitHub, Google etc. The provider must be switched on in the Supabase project.
  oauth(provider) {
    const go = `${this.url}/auth/v1/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${comeBack()}`;
    if (native) native.openExternal(go); else location.href = go; // the app signs in through the phone's browser
  }
  async recover(email) {
    await this.#fetch(`/auth/v1/recover?redirect_to=${comeBack()}`, { method: 'POST', body: { email } });
  }
  async setPassword(password) {
    await this.#fetch('/auth/v1/user', { method: 'PUT', body: { password }, token: await this.#token() });
    this.recovering = false;
  }

  // Sign-in links (email confirmation, password reset, GitHub or Google) come back to the app with the
  // session in the address after the #. Call once on load, before routing. Returns a message to show, if any.
  async takeRedirect() {
    const h = location.hash.slice(1);
    if (!/(^|&)(access_token|error_description)=/.test(h)) return null;
    const p = new URLSearchParams(h);
    history.replaceState(null, '', location.pathname + location.search + '#settings/storage');
    if (p.get('error_description')) return { error: p.get('error_description').replace(/\+/g, ' ') };
    try {
      const s = { access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: +p.get('expires_in') || 3600 };
      const user = await this.#fetch('/auth/v1/user', { token: s.access_token });
      this.#setSession(s, user);
      this.recovering = p.get('type') === 'recovery';
      return { ok: true, recovering: this.recovering };
    } catch (e) {
      return { error: e.message };
    }
  }

  // A valid access token, refreshed when it is about to run out.
  async #token() {
    const s = this.#state.session;
    if (!s) throw Object.assign(new Error('Sign in to your Gyle account in Settings.'), { status: 401 });
    if (s.expires_at - Date.now() > 60000) return s.access_token;
    try {
      const out = await this.#fetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } });
      this.#setSession(out, s.user);
      return out.access_token;
    } catch (e) {
      if (e.status === 400 || e.status === 401 || e.status === 403) { this.#state.session = null; this.#save(); throw Object.assign(new Error('Your sign-in has expired. Sign in again in Settings.'), { status: 401 }); }
      throw e;
    }
  }

  // ---- documents ----
  async #rest(query, opts = {}) {
    try {
      return await this.#fetch('/rest/v1/documents' + query, { ...opts, token: await this.#token() });
    } catch (e) {
      if (e.status === 404 || e.code === 'PGRST205' || e.code === '42P01') throw new Error('The Supabase project has no documents table yet. Run supabase/setup.sql in its SQL editor.');
      throw e;
    }
  }
  async list(kind) {
    const rows = await this.#rest(`?select=id,updated_at&kind=eq.${encodeURIComponent(kind)}`);
    return new Map((rows || []).map(r => [r.id, r.updated_at]));
  }
  async read(kind, id) {
    const rows = await this.#rest(`?select=data,updated_at&kind=eq.${encodeURIComponent(kind)}&id=eq.${encodeURIComponent(id)}`);
    if (!rows?.length) throw Object.assign(new Error('That document is no longer in your account.'), { status: 404 });
    return { payload: rows[0].data, version: rows[0].updated_at };
  }
  async write(kind, id, payload) {
    const rows = await this.#rest('?on_conflict=user_id,kind,id&select=updated_at', {
      method: 'POST', body: { kind, id, data: payload }, headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    });
    return rows?.[0]?.updated_at;
  }
  async remove(kind, id) {
    await this.#rest(`?kind=eq.${encodeURIComponent(kind)}&id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // ---- photos: Supabase Storage, bucket "photos", one folder per person ----
  async #storage(path, { method = 'GET', body, headers = {} } = {}) {
    const token = await this.#token();
    let res;
    try {
      res = await fetch(`${this.url}/storage/v1/object/${path}`, { method, cache: 'no-store', headers: { apikey: this.key, Authorization: `Bearer ${token}`, ...headers }, body });
    } catch {
      throw Object.assign(new Error('Could not reach your Gyle account to save photos. Check your connection.'), { status: 0 });
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const text = `${data.error || ''} ${data.message || ''}`;
      if (/bucket not found/i.test(text)) throw Object.assign(new Error('The Supabase project has no photos bucket yet. Run supabase/setup.sql again in its SQL editor.'), { status: 404 });
      const status = +data.statusCode || res.status;
      throw Object.assign(new Error(status === 404 ? 'That photo is not in your account.' : `Photo upload failed: ${data.message || data.error || res.status}`), { status });
    }
    return res;
  }
  #photoPath(name) { return `photos/${this.user.id}/${name}`; }
  async putFile(name, blob) {
    await this.#storage(this.#photoPath(name), { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true' } });
  }
  async getFile(name) {
    return (await this.#storage('authenticated/' + this.#photoPath(name))).blob();
  }
  async removeFile(name) {
    try { await this.#storage(this.#photoPath(name), { method: 'DELETE' }); }
    catch (e) { if (e.status !== 404) throw e; }
  }
}

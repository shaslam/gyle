// Storage. Every document lives in two places:
//   1. a working copy in this browser, so edits are never lost mid-brew and the app works offline;
//   2. a backend that keeps the real copy: a GitHub repo (each save is a commit) or a Gyle
//      account (a hosted database with sign-in, saved automatically).
// The store handles the working copy and the syncing; the backends only know how to list, read,
// write and remove documents. Recipes travel as BeerJSON whichever backend holds them.

import { toBeerJSON, fromBeerJSON } from './beerjson.js';
import { GitBackend } from './backend-git.js';
import { SupabaseBackend } from './backend-supabase.js';
import { photos } from './photos.js';
import { native } from './native.js';

const LS_CACHE = 'gyle.cache.v1';
const LS_MODE = 'gyle.storage.v1';
const KINDS = ['recipes', 'brews', 'settings'];

const encode = (kind, data) => (kind === 'recipes' ? toBeerJSON(data) : data);
const decode = (kind, payload) => (kind === 'recipes' ? fromBeerJSON(payload)[0] : payload);
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};
const LOCAL_WORDS = { save: 'Saved on this device', saved: 'Saved on this device', pending: () => 'This device only', unsaved: 'on this device only', need: 'Choose where to keep your recipes in Settings.' };

class Store {
  docs = { recipes: {}, brews: {}, settings: {} };  // id -> { data, sha (the backend's version), dirty, deleted }
  git = new GitBackend();
  account = new SupabaseBackend();
  mode = 'local';   // 'local' | 'git' | 'supabase'
  owner = 'local';  // which backend the working copy was last in step with
  status = { state: 'local', message: '' };
  #listeners = new Set();
  #persistTimer = null;
  #autoTimer = null;
  #busy = false;
  lastSync = 0; // when the backend was last asked for changes

  init() {
    const cached = ls.get(LS_CACHE);
    if (cached) for (const k of KINDS) this.docs[k] = cached[k] || {};
    const saved = ls.get(LS_MODE);
    if (saved) { this.mode = saved.mode || 'local'; this.owner = saved.owner || 'local'; }
    else if (this.git.ready) { this.mode = 'git'; this.owner = this.git.id; } // connections made before storage choices existed
    if (native) this.mode = 'supabase'; // the Android and iOS apps keep data in a Gyle account only
    this.status.state = this.connected ? 'idle' : 'local';
  }

  get backend() { return this.mode === 'git' ? this.git : this.mode === 'supabase' ? this.account : null; }
  get connected() { return !!this.backend?.ready; }
  get canWrite() { return !!this.backend?.canWrite; }
  get auto() { return !!this.backend?.auto; }
  get words() { return this.connected ? this.backend.words : LOCAL_WORDS; }
  get dirtyCount() {
    return KINDS.reduce((n, k) => n + Object.values(this.docs[k]).filter(d => d.dirty).length, 0);
  }

  on(fn) { this.#listeners.add(fn); }
  #emit() { this.#listeners.forEach(fn => fn()); }
  #setStatus(state, message = '') { this.status = { state, message }; this.#emit(); }
  persist() { ls.set(LS_CACHE, this.docs); }
  #saveMode() { ls.set(LS_MODE, { mode: this.mode, owner: this.owner }); }

  // ---- choosing where data lives ----
  setMode(mode) {
    this.mode = mode;
    this.#saveMode();
    this.#setStatus(this.connected ? 'idle' : 'local');
  }
  // Call after connecting a repo or signing in. If the working copy belonged somewhere else (this
  // device only, another repo, the other kind of backend), everything in it is queued to be saved
  // to the new place, so moving between backends carries your recipes with you.
  adopt() {
    if (!this.connected || this.owner === this.backend.id) return;
    for (const k of KINDS) {
      for (const [id, d] of Object.entries(this.docs[k])) {
        if (d.deleted) delete this.docs[k][id]; else { d.sha = undefined; d.dirty = true; }
      }
    }
    this.owner = this.backend.id;
    this.persist(); this.#saveMode();
    this.#setStatus('idle');
  }
  // Forget the working copy (after signing out, so the next person to sign in here starts clean).
  wipe() {
    this.docs = { recipes: {}, brews: {}, settings: {} };
    this.owner = 'local';
    photos.wipe();
    this.persist(); this.#saveMode();
    this.#setStatus(this.connected ? 'idle' : 'local');
  }
  // Keep the working copy but stop syncing it anywhere.
  detach() {
    this.owner = 'local';
    this.#saveMode();
    this.#setStatus(this.connected ? 'idle' : 'local');
  }

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
    this.#autoSave();
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
    this.#autoSave();
  }
  remove(kind, id) {
    const d = this.docs[kind][id];
    if (!d) return;
    if (d.sha) { d.deleted = true; d.dirty = true; } else delete this.docs[kind][id];
    this.persist();
    this.#emit();
    this.#autoSave();
  }
  // Backends that save by themselves (a Gyle account) do so a moment after the last change.
  #autoSave(delay = 2500) {
    if (!this.auto || !this.canWrite) return;
    clearTimeout(this.#autoTimer);
    this.#autoTimer = setTimeout(() => {
      if (!this.dirtyCount) return;
      if (this.#busy) return this.#autoSave(1000);
      this.push().catch(() => {}); // the status chip shows the error
    }, delay);
  }

  // ---- syncing ----
  // Pull anything that changed in the backend. Unsaved local edits are kept.
  async sync() {
    if (!this.connected || this.#busy) return;
    this.adopt();
    const backend = this.backend;
    this.#busy = true;
    this.lastSync = Date.now();
    this.#setStatus('syncing');
    try {
      for (const kind of KINDS) {
        const remote = await backend.list(kind);
        const docs = this.docs[kind];
        for (const [id, version] of remote) {
          const d = docs[id];
          if (d?.dirty) { d.sha = version; continue; }
          if (d?.sha === version) continue;
          try {
            const got = await backend.read(kind, id);
            docs[id] = { data: decode(kind, got.payload), sha: got.version, dirty: false };
          } catch (e) {
            if (e.status !== undefined && e.status !== 404) throw e;
            console.warn(`Skipped ${kind}/${id}: ${e.message}`);
          }
        }
        for (const id of Object.keys(docs)) {
          if (remote.has(id)) continue;
          if (!docs[id].dirty) delete docs[id]; else docs[id].sha = undefined;
        }
      }
      this.persist();
      this.#setStatus('synced');
    } catch (e) {
      this.#setStatus('error', e.message);
    } finally {
      this.#busy = false;
    }
    if (this.dirtyCount) this.#autoSave(500);
    else if (this.canWrite && this.status.state === 'synced') this.#photos(backend).catch(() => {}); // photos left over from an earlier save
  }

  // Upload new photos and remove deleted ones. A photo that fails does not stop the documents saving.
  async #photos(backend) {
    try {
      await photos.flush(backend);
    } catch (e) {
      this.#setStatus('error', `Photos not saved yet: ${e.message}`);
      throw e;
    }
  }

  #message(kind, id) {
    const d = this.docs[kind][id];
    const what = kind === 'settings' ? 'settings' : `${kind.slice(0, -1)}: ${d.data?.name || id}`;
    return `${d.deleted ? 'Delete' : d.sha ? 'Update' : 'Add'} ${what}`;
  }

  // Save one document, or every unsaved one when called with no arguments.
  async push(kind, id) {
    if (!this.canWrite) throw new Error(this.words.need);
    if (this.#busy) throw new Error('Still syncing. Try again in a moment.');
    const backend = this.backend;
    this.#busy = true;
    this.#setStatus('syncing');
    clearTimeout(this.#persistTimer);
    try {
      const targets = kind ? [[kind, id]] : KINDS.flatMap(k => Object.keys(this.docs[k]).filter(i => this.docs[k][i].dirty).map(i => [k, i]));
      for (const [k, i] of targets) {
        const d = this.docs[k][i];
        if (!d?.dirty) continue;
        const message = this.#message(k, i);
        if (d.deleted) {
          await backend.remove(k, i, d.sha, message);
          delete this.docs[k][i];
        } else {
          const sent = JSON.stringify(d.data);
          d.sha = await backend.write(k, i, encode(k, d.data), d.sha, message);
          d.dirty = JSON.stringify(d.data) !== sent; // still unsaved if it was edited while the save was in flight
        }
      }
      this.persist();
      this.#setStatus('synced');
      await this.#photos(backend).catch(() => {}); // the status shows a photo error; the documents are saved
    } catch (e) {
      this.persist();
      this.#setStatus('error', e.message);
      throw e;
    } finally {
      this.#busy = false;
      if (this.dirtyCount) this.#autoSave();
    }
  }

  // Throw away local edits to one document and take the backend's version.
  async revert(kind, id) {
    const d = this.docs[kind][id];
    if (!d) return;
    if (!d.sha) delete this.docs[kind][id];
    else {
      const got = await this.backend.read(kind, id);
      this.docs[kind][id] = { data: decode(kind, got.payload), sha: got.version, dirty: false };
    }
    this.persist();
    this.#emit();
  }
}

export const store = new Store();

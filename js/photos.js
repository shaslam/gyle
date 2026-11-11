// Photos for brew logs. A photo is too big for the working copy in localStorage, so each one is
// its own file. This browser keeps it in IndexedDB, and the store copies it to the backend the
// next time it saves: a file under photos/ in the GitHub repo, or Supabase Storage for a Gyle
// account. A brew log only holds each photo's id and size.
//
// A backend that holds photos has three more methods:
//   putFile(name, blob)   getFile(name) -> Blob   removeFile(name)
//
// Each record in IndexedDB: { id, blob, owner, deleted }. `owner` is the id of the backend that
// has a copy (null while only this browser has it). A deleted photo stays as a record without
// its blob until the backend copy is removed.

const DB = 'gyle-photos', OS = 'photos';
const fileName = id => `${id}.jpg`;
let dbPromise = null;
const urls = new Map(); // photo id -> object URL for <img>
const loading = new Map(); // photo id -> promise of its URL, so two <img> share one download

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OS, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(OS, mode), req = fn(t.objectStore(OS));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('The photo store refused the change. The device may be out of space.'));
  });
}
const getRec = id => run('readonly', s => s.get(id));
const putRec = rec => run('readwrite', s => s.put(rec));
const delRec = id => run('readwrite', s => s.delete(id));
const allRecs = () => run('readonly', s => s.getAll());

export const newPhotoId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Shrink a picked image to at most `max` pixels on its long side, as a JPEG.
// Phones take photos of 3 to 8 MB; this makes them about 150 to 400 kB.
export async function shrink(file, max = 1600) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('This file is not a picture that the browser can open.'); }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
  if (!blob) throw new Error('Could not make a copy of the picture.');
  return { blob, w, h };
}

export const photos = {
  // Keep a new photo in this browser. It goes to the backend on the next save.
  async add(id, blob) {
    await putRec({ id, blob, owner: null, deleted: false });
  },

  // An object URL to show the photo, fetched from the backend if this browser has no copy.
  // Resolves null when the photo is not here and cannot be fetched.
  url(id, backend) {
    if (!loading.has(id)) loading.set(id, this.load(id, backend).finally(() => loading.delete(id)));
    return loading.get(id);
  },
  async load(id, backend) {
    if (urls.has(id)) return urls.get(id);
    let rec = null;
    try { rec = await getRec(id); } catch { /* IndexedDB blocked: try the backend */ }
    let blob = rec?.blob;
    if (!blob && !rec?.deleted && backend?.ready && backend.getFile) {
      try {
        blob = await backend.getFile(fileName(id));
        await putRec({ id, blob, owner: backend.id, deleted: false }).catch(() => {});
      } catch { blob = null; }
    }
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    urls.set(id, u);
    return u;
  },

  // Forget a photo. When a backend may hold a copy, keep a marker so the next save removes it there.
  async remove(id, connected) {
    if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
    if (connected) await putRec({ id, blob: null, owner: null, deleted: true });
    else await delRec(id);
  },

  // Photos that the backend does not have yet, and removals it has not done yet.
  async pending(backend) {
    try { return (await allRecs()).filter(r => r.deleted || r.owner !== backend.id).length; } catch { return 0; }
  },

  // Bring the backend in step: upload new photos, remove deleted ones.
  async flush(backend) {
    if (!backend?.canWrite || !backend.putFile) return;
    let recs;
    try { recs = await allRecs(); } catch { return; }
    for (const r of recs) {
      if (r.deleted) {
        await backend.removeFile(fileName(r.id));
        await delRec(r.id);
      } else if (r.blob && r.owner !== backend.id) {
        await backend.putFile(fileName(r.id), r.blob);
        await putRec({ ...r, owner: backend.id });
      }
    }
  },

  // Forget every photo on this device (after signing out).
  async wipe() {
    urls.forEach(u => URL.revokeObjectURL(u));
    urls.clear();
    try { await run('readwrite', s => s.clear()); } catch { /* nothing stored */ }
  },
};

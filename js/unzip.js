// Reads the files out of a .zip archive, using the browser's own DecompressionStream for the
// compressed ones. Enough for exports such as Brewfather's backup: no encryption, no zip64.

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns [{ name, bytes }] for every file in the archive (folders are skipped).
export async function unzip(buffer) {
  const data = new Uint8Array(buffer), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The end-of-directory record sits in the last 22 bytes plus an optional comment of up to 64 KB.
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === END) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not a zip file.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const out = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('The zip file is damaged.');
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = names.decode(data.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`${name} in the zip file is encrypted.`);
    if (view.getUint32(offset, true) !== LOCAL) throw new Error('The zip file is damaged.');
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const raw = data.subarray(start, start + size);
    if (method === 0) out.push({ name, bytes: raw.slice() });
    else if (method === 8) out.push({ name, bytes: await inflate(raw) });
    else throw new Error(`${name} in the zip file uses a compression method Gyle cannot read.`);
  }
  return out;
}

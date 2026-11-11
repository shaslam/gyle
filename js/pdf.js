// A small PDF writer: text, lines, boxes and filled shapes on A4 pages, nothing else.
// It uses the two built-in PDF fonts Helvetica and Helvetica-Bold, so no font is embedded
// and the files stay small. Those fonts only cover Windows-1252 (Western European)
// characters; anything else is swapped for a close ASCII spelling or "?".
//
// Coordinates are in points (1/72 inch) from the TOP-left corner of the page, y down,
// which is easier for laying out a sheet. They are flipped when written out.

// Advance widths in 1/1000 em for bytes 32..255 in WinAnsiEncoding, from Adobe's AFM files.
const W_REG = '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500'.split(',').map(Number);
const W_BOLD = '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556'.split(',').map(Number);

// Unicode characters that Windows-1252 places outside Latin-1, and plain spellings for a few it lacks.
const CP1252 = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const SPELL = { '₂': '2', '→': '->', '←': '<-', '−': '-', 'α': 'alpha ', '≈': '~', '≤': '<=', '≥': '>=', '✓': 'x', ' ': ' ', ' ': ' ' };

// Text as a string of byte values 0..255 (one char per byte), ready for the PDF file.
export function toWinAnsi(s) {
  let out = '';
  for (const ch of String(s ?? '').normalize('NFC')) {
    if (SPELL[ch] != null) { out += SPELL[ch]; continue; }
    const c = ch.codePointAt(0);
    if (CP1252[ch]) out += String.fromCharCode(CP1252[ch]);
    else if (c >= 32 && c < 127) out += ch;
    else if (c >= 160 && c < 256) out += ch;
    else if (c === 9 || c === 10) out += ' ';
    else out += '?';
  }
  return out;
}

const num = v => (Math.round(v * 100) / 100).toString();
const rgb = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(x => num(x / 255)).join(' ');
};
const pdfString = s => '(' + s.replace(/[\\()]/g, c => '\\' + c) + ')';

export class Pdf {
  constructor({ width = 595.28, height = 841.89 } = {}) { // A4
    this.width = width; this.height = height;
    this.pages = [];
    this.addPage();
  }
  addPage() { this.page = []; this.pages.push(this.page); return this; }
  #y(y) { return num(this.height - y); }

  // Width of a string in points.
  measure(text, size = 10, bold = false) {
    const w = bold ? W_BOLD : W_REG;
    let t = 0;
    for (const ch of toWinAnsi(text)) t += w[ch.charCodeAt(0) - 32] || 500;
    return t * size / 1000;
  }
  // Split text into lines no wider than maxWidth. Long words are cut.
  wrap(text, maxWidth, size = 10, bold = false) {
    const lines = [];
    for (const para of String(text ?? '').split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? line + ' ' + word : word;
        if (this.measure(next, size, bold) <= maxWidth) { line = next; continue; }
        if (line) lines.push(line);
        line = word;
        while (this.measure(line, size, bold) > maxWidth && line.length > 1) { // a word wider than the line
          let k = line.length - 1;
          while (k > 1 && this.measure(line.slice(0, k), size, bold) > maxWidth) k--;
          lines.push(line.slice(0, k));
          line = line.slice(k);
        }
      }
      lines.push(line);
    }
    return lines;
  }
  // y is the baseline. align: 'left' | 'right' | 'center' relative to x.
  text(x, y, text, { size = 10, bold = false, color = '#000000', align = 'left' } = {}) {
    const s = toWinAnsi(text);
    if (!s) return this;
    const w = this.measure(text, size, bold);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.page.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${num(left)} ${this.#y(y)} Td ${pdfString(s)} Tj ET`);
    return this;
  }
  line(x1, y1, x2, y2, { width = 0.5, color = '#000000', dash = null } = {}) {
    this.page.push(`q ${num(width)} w ${rgb(color)} RG ${dash ? `[${dash.join(' ')}] 0 d ` : ''}${num(x1)} ${this.#y(y1)} m ${num(x2)} ${this.#y(y2)} l S Q`);
    return this;
  }
  rect(x, y, w, h, { fill = null, stroke = null, width = 0.5 } = {}) {
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.page.push(`q ${num(width)} w ${fill ? rgb(fill) + ' rg ' : ''}${stroke ? rgb(stroke) + ' RG ' : ''}${num(x)} ${this.#y(y + h)} ${num(w)} ${num(h)} re ${op} Q`);
    return this;
  }
  // A closed shape through the given [x, y] points.
  shape(points, { fill = null, stroke = null, width = 0.5 } = {}) {
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    const path = points.map(([x, y], i) => `${num(x)} ${this.#y(y)} ${i ? 'l' : 'm'}`).join(' ');
    this.page.push(`q ${num(width)} w ${fill ? rgb(fill) + ' rg ' : ''}${stroke ? rgb(stroke) + ' RG ' : ''}${path} h ${op} Q`);
    return this;
  }

  // The finished file.
  bytes({ title = '' } = {}) {
    const objs = []; // object bodies; object n is objs[n - 1]
    const add = body => { objs.push(body); return objs.length; };
    const catalog = add(''), pages = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = this.pages.map(ops => {
      const stream = ops.join('\n');
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      return add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`);
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
    objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title ${pdfString(toWinAnsi(title))} /Producer (Gyle) >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = objs.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
    return bytes;
  }
}

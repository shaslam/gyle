// Brew sheet: one description of the sheet, drawn two ways. sheetHtml() gives the page you see
// and print from the browser; sheetPdf() gives a PDF file with the same content.
//
// The description (built in app.js) looks like this:
//   { title, subtitle, colour: '#rrggbb', footer,
//     meta:  [[label, value]],             a value of null is a blank to write in
//     stats: [[label, value]],
//     sections: [{ title, half, note,
//       table: { cols: [{ h, w, right }], rows: [[cell]] },   w is a share of the width; a null cell is a blank
//       checklist: [{ text, done }],
//       text, lines }] }                    lines = number of ruled lines to write on
// Sections marked `half` sit side by side in pairs.

import { Pdf } from './pdf.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const blank = '<span class="bs-blank" aria-label="blank"></span>';
const cell = v => (v == null ? blank : esc(v));

// Pair up consecutive half-width sections.
function rows(sections) {
  const out = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s.half && sections[i + 1]?.half) { out.push([s, sections[i + 1]]); i++; } else out.push([s]);
  }
  return out;
}

// ---------- HTML ----------
function sectionHtml(s) {
  let body = '';
  if (s.table) {
    body += `<table class="bs-table"><colgroup>${s.table.cols.map(c => `<col style="width:${(c.w * 100).toFixed(1)}%">`).join('')}</colgroup>
      <thead><tr>${s.table.cols.map(c => `<th${c.right ? ' class="r"' : ''}>${esc(c.h)}</th>`).join('')}</tr></thead>
      <tbody>${s.table.rows.map(r => `<tr>${r.map((v, i) => `<td${s.table.cols[i].right ? ' class="r"' : ''}>${cell(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  if (s.checklist) body += `<ol class="bs-check">${s.checklist.map(c => `<li class="${c.done ? 'done' : ''}"><span class="bs-box" aria-hidden="true">${c.done ? '✓' : ''}</span><span>${esc(c.text)}</span></li>`).join('')}</ol>`;
  if (s.text) body += `<p class="bs-text">${esc(s.text).replace(/\n/g, '<br>')}</p>`;
  if (s.lines) body += `<div class="bs-lines">${'<span></span>'.repeat(s.lines)}</div>`;
  if (s.note) body += `<p class="bs-note">${esc(s.note)}</p>`;
  return `<section class="bs-sec"><h2>${esc(s.title)}</h2>${body}</section>`;
}

export function sheetHtml(m) {
  return `<article class="brewsheet">
    <header class="bs-head">
      <div><h1>${esc(m.title)}</h1><p class="bs-sub">${esc(m.subtitle)}</p></div>
      <svg class="bs-glass" viewBox="0 0 30 40" width="30" height="40" aria-hidden="true"><path d="M2 2h26l-3 34a3 3 0 0 1-3 2.6H8A3 3 0 0 1 5 36z" fill="${esc(m.colour)}" stroke="#333" stroke-width="1.2"/></svg>
    </header>
    <dl class="bs-meta">${m.meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${cell(v)}</dd></div>`).join('')}</dl>
    <dl class="bs-stats">${m.stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${rows(m.sections).map(r => (r.length === 2 ? `<div class="bs-pair">${r.map(sectionHtml).join('')}</div>` : sectionHtml(r[0]))).join('')}
    <footer class="bs-foot">${esc(m.footer)}</footer>
  </article>`;
}

// ---------- PDF ----------
const MARGIN = 36, GAP = 18;
const INK = '#111111', GREY = '#666666', RULE = '#bbbbbb', SHADE = '#eeeeee';
const SIZE = { body: 9, head: 7.5, line: 13 };

// Lays a section out at (x, y) in width w. With draw = false it only measures.
// Returns the height used. Tables and checklists can break across pages when `flow` is given.
function layoutSection(pdf, s, x, y, w, draw, flow) {
  const top = y;
  const need = h => { // start a new page if the next h points do not fit
    if (!flow || y + h <= flow.bottom) return;
    pdf.addPage(); y = MARGIN; flow.onPage?.();
  };
  // heading
  if (draw) {
    pdf.text(x, y + 9, s.title.toUpperCase(), { size: 8.5, bold: true, color: INK });
    pdf.line(x, y + 12.5, x + w, y + 12.5, { width: 1, color: INK });
  }
  y += 18;
  if (s.table) {
    const { cols } = s.table;
    const xs = []; let at = x;
    cols.forEach(c => { xs.push(at); at += c.w * w; });
    const pad = 3;
    const header = () => {
      if (draw) cols.forEach((c, i) => pdf.text(c.right ? xs[i] + c.w * w - pad : xs[i] + pad, y + 8, c.h, { size: SIZE.head, bold: true, color: GREY, align: c.right ? 'right' : 'left' }));
      y += 12;
    };
    header();
    for (const r of s.table.rows) {
      // wrap each cell; the row is as tall as its tallest cell
      const wrapped = r.map((v, i) => (v == null ? null : pdf.wrap(v, cols[i].w * w - 2 * pad, SIZE.body)));
      const h = Math.max(1, ...wrapped.map(l => (l ? l.length : 1))) * 11 + 4;
      if (flow && y + h > flow.bottom) { need(h + 12); header(); }
      if (draw) {
        wrapped.forEach((lines, i) => {
          const c = cols[i];
          if (lines == null) { pdf.line(xs[i] + pad, y + 11, xs[i] + c.w * w - pad, y + 11, { width: 0.6, color: GREY }); return; }
          lines.forEach((ln, k) => pdf.text(c.right ? xs[i] + c.w * w - pad : xs[i] + pad, y + 10 + k * 11, ln, { size: SIZE.body, color: INK, align: c.right ? 'right' : 'left' }));
        });
        pdf.line(x, y + h, x + w, y + h, { width: 0.4, color: RULE });
      }
      y += h;
    }
    y += 4;
  }
  if (s.checklist) {
    for (const c of s.checklist) {
      const lines = pdf.wrap(c.text, w - 16, SIZE.body);
      const h = lines.length * 11 + 4;
      need(h);
      if (draw) {
        pdf.rect(x, y + 2, 8, 8, { stroke: INK, width: 0.7 });
        if (c.done) { pdf.line(x + 1.5, y + 6, x + 3.5, y + 8.5, { width: 1.2 }); pdf.line(x + 3.5, y + 8.5, x + 7, y + 3, { width: 1.2 }); }
        lines.forEach((ln, k) => pdf.text(x + 14, y + 9 + k * 11, ln, { size: SIZE.body, color: INK }));
      }
      y += h;
    }
    y += 4;
  }
  if (s.text) {
    const lines = pdf.wrap(s.text, w, SIZE.body);
    for (const ln of lines) { need(11); if (draw) pdf.text(x, y + 9, ln, { size: SIZE.body, color: INK }); y += 11; }
    y += 6;
  }
  if (s.lines) {
    for (let i = 0; i < s.lines; i++) { need(20); y += 20; if (draw) pdf.line(x, y, x + w, y, { width: 0.4, color: RULE }); }
    y += 6;
  }
  if (s.note) {
    const lines = pdf.wrap(s.note, w, 7.5);
    for (const ln of lines) { need(10); if (draw) pdf.text(x, y + 8, ln, { size: 7.5, color: GREY }); y += 10; }
    y += 4;
  }
  return flow ? y : y - top; // with flow the caller wants the new y (the page may have changed)
}

export function sheetPdf(m) {
  const pdf = new Pdf();
  const W = pdf.width - 2 * MARGIN, bottom = pdf.height - MARGIN - 18;
  let y = MARGIN;

  // Title, subtitle and a glass of the beer's colour.
  const titleLines = pdf.wrap(m.title, W - 50, 18, true);
  titleLines.forEach((ln, i) => pdf.text(MARGIN, y + 16 + i * 21, ln, { size: 18, bold: true, color: INK }));
  y += 16 + (titleLines.length - 1) * 21;
  pdf.text(MARGIN, y + 15, m.subtitle, { size: 10, color: GREY });
  const gx = MARGIN + W - 26, gy = MARGIN;
  pdf.shape([[gx, gy], [gx + 26, gy], [gx + 23, gy + 34], [gx + 3, gy + 34]], { fill: m.colour, stroke: INK, width: 1 });
  y = Math.max(y + 28, gy + 44);

  // Meta: label above value, in up to four columns.
  const per = Math.min(4, m.meta.length), cw = W / per;
  m.meta.forEach(([k, v], i) => {
    const cx = MARGIN + (i % per) * cw, cy = y + Math.floor(i / per) * 26;
    pdf.text(cx, cy + 7, k.toUpperCase(), { size: 6.5, bold: true, color: GREY });
    if (v == null) pdf.line(cx, cy + 20, cx + cw - 10, cy + 20, { width: 0.6, color: GREY });
    else pdf.text(cx, cy + 18, pdf.wrap(v, cw - 10, 9.5)[0], { size: 9.5, color: INK });
  });
  y += Math.ceil(m.meta.length / per) * 26 + 6;

  // Stats: a row of boxes.
  const n = m.stats.length, perRow = Math.min(n, 7), sw = W / perRow;
  m.stats.forEach(([k, v], i) => {
    const sx = MARGIN + (i % perRow) * sw, sy = y + Math.floor(i / perRow) * 34;
    pdf.rect(sx, sy, sw, 34, { fill: SHADE, stroke: RULE, width: 0.5 });
    pdf.text(sx + sw / 2, sy + 11, k.toUpperCase(), { size: 6.5, bold: true, color: GREY, align: 'center' });
    pdf.text(sx + sw / 2, sy + 26, v, { size: 11, bold: true, color: INK, align: 'center' });
  });
  y += Math.ceil(n / perRow) * 34 + 16;

  // Sections. A pair of half sections must fit together; a full one may break across pages.
  for (const r of rows(m.sections)) {
    if (r.length === 2) {
      const hw = (W - GAP) / 2;
      const h = Math.max(...r.map(s => layoutSection(pdf, s, 0, 0, hw, false)));
      if (y + h > bottom) { pdf.addPage(); y = MARGIN; }
      r.forEach((s, i) => layoutSection(pdf, s, MARGIN + i * (hw + GAP), y, hw, true));
      y += h + 10;
    } else {
      const s = r[0];
      const h = layoutSection(pdf, s, 0, 0, W, false);
      // keep a short section in one piece, and never leave a heading alone at the foot of a page
      if (y + Math.min(h, 60) > bottom || (h < bottom - MARGIN && y + h > bottom)) { pdf.addPage(); y = MARGIN; }
      y = layoutSection(pdf, s, MARGIN, y, W, true, { bottom }) + 10;
    }
  }

  // Footer with page numbers on every page.
  pdf.pages.forEach((ops, i) => {
    pdf.page = ops;
    pdf.line(MARGIN, pdf.height - MARGIN - 8, MARGIN + W, pdf.height - MARGIN - 8, { width: 0.4, color: RULE });
    pdf.text(MARGIN, pdf.height - MARGIN + 2, m.footer, { size: 7, color: GREY });
    pdf.text(MARGIN + W, pdf.height - MARGIN + 2, `Page ${i + 1} of ${pdf.pages.length}`, { size: 7, color: GREY, align: 'right' });
  });
  return pdf.bytes({ title: m.title });
}

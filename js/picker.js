// In the Android and iOS apps a <select> opens the phone's own list of choices, which looks
// nothing like Gyle. pickSelects() shows the choices in a Gyle popup instead. The <select> stays
// the real field: the popup sets its value and sends the same `input` and `change` events, so no
// screen has to know about it. A browser keeps its own list (app.js calls this in the apps only).

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = el => (el?.matches?.('select') && !el.multiple && !el.disabled ? el : null);

function open(sel) {
  document.querySelector('dialog.choose')?.remove();
  sel.blur(); // iOS shows its own list for a field that has the cursor
  const title = sel.labels?.[0]?.querySelector('span')?.textContent || sel.getAttribute('aria-label') || '';
  const dlg = document.createElement('dialog');
  dlg.className = 'choose';
  dlg.innerHTML = `${title ? `<h2>${esc(title)}</h2>` : ''}<div class="picks" role="listbox"${title ? ` aria-label="${esc(title)}"` : ''}>${[...sel.options].map((o, i) =>
    `<button type="button" class="pick${i === sel.selectedIndex ? ' on' : ''}" role="option" aria-selected="${i === sel.selectedIndex}" data-i="${i}"${o.disabled ? ' disabled' : ''}>${esc(o.label || o.text) || '–'}</button>`).join('')}</div>`;
  document.body.append(dlg);
  dlg.addEventListener('click', e => {
    const btn = e.target.closest('.pick');
    if (!btn && e.target !== dlg) return; // a tap on the dark area around the popup closes it
    dlg.close();
    if (!btn || +btn.dataset.i === sel.selectedIndex) return;
    sel.selectedIndex = +btn.dataset.i;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  const on = dlg.querySelector('.pick.on');
  on?.scrollIntoView({ block: 'center' });
  (on || dlg.querySelector('.pick:not([disabled])'))?.focus({ preventScroll: true });
}

export function pickSelects() {
  // The system list opens on mousedown, and a tap sends one. Stop that, then answer the tap ourselves.
  document.addEventListener('mousedown', e => { if (plain(e.target)) e.preventDefault(); }, true);
  document.addEventListener('click', e => { const sel = plain(e.target); if (sel) { e.preventDefault(); open(sel); } }, true);
  // The same for a keyboard that is connected to the phone.
  document.addEventListener('keydown', e => {
    const sel = plain(e.target);
    if (sel && [' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(sel); }
  }, true);
}

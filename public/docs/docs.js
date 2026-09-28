// Aria docs: one section shown per hash "page", sidebar state, on-this-page TOC, search, copy buttons, theme.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sections = $$('.d-main > section');
const links = $$('.d-side a');
const menu = $('.d-menu'), side = $('#d-side');
function closeMenu() { side.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); }
const store = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { return null; } };

// Theme follows the app's choice (aria.theme), cycling system → light → dark.
const THEMES = ['system', 'light', 'dark'];
function applyTheme() {
  const t = store('aria.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  $('#d-theme').textContent = 'Theme: ' + (t || 'system');
}
$('#d-theme').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(store('aria.theme') || 'system') + 1) % 3];
  store('aria.theme', next === 'system' ? null : next); applyTheme();
});
applyTheme();

// Copy buttons on code blocks.
for (const pre of $$('.d-main pre')) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'd-copy', textContent: 'Copy' });
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pre.querySelector('code').textContent); b.textContent = 'Copied'; }
    catch { b.textContent = 'Press Ctrl+C'; }
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  });
  pre.append(b);
}

// Give every h2 an id so it can be linked and listed in the TOC.
for (const h of $$('.d-main h2')) if (!h.id) h.id = (h.closest('.ep')?.id) || h.textContent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let observer;
function show() {
  const target = decodeURIComponent(location.hash.slice(1)) || 'overview';
  const el = document.getElementById(target);
  const sec = (el && el.closest('.d-main > section')) || sections[0];
  for (const s of sections) s.classList.toggle('on', s === sec);
  for (const a of links) a.getAttribute('href') === '#' + sec.id ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  document.title = `${sec.dataset.title.replace(/&amp;/g, '&')} · Aria Docs`;

  // TOC for this page.
  const toc = $('#d-toc'); toc.textContent = '';
  const heads = $$('h2', sec);
  for (const h of heads) toc.append(Object.assign(document.createElement('a'), { href: '#' + h.id, textContent: h.textContent.replace(/^(GET|POST|PUT|PATCH|DELETE)+/, '').trim() }));
  observer?.disconnect();
  observer = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) for (const a of $$('a', toc)) a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id);
  }, { rootMargin: '-60px 0px -70% 0px' });
  heads.forEach((h) => observer.observe(h));

  // Previous / next.
  const i = sections.indexOf(sec), pager = $('.d-pager'); pager.textContent = '';
  const mk = (s, cls, label) => { const a = document.createElement('a'); a.href = '#' + s.id; a.className = cls;
    a.append(Object.assign(document.createElement('small'), { textContent: label }), s.dataset.title.replace(/&amp;/g, '&')); pager.append(a); };
  if (sections[i - 1]) mk(sections[i - 1], 'prev', 'Previous'); else pager.append(document.createElement('span'));
  if (sections[i + 1]) mk(sections[i + 1], 'next', 'Next');

  if (el && el !== sec) el.scrollIntoView(); else { window.scrollTo(0, 0); $('#d-content').focus({ preventScroll: true }); }
  closeMenu();
}
window.addEventListener('hashchange', () => (location.hash === '#d-content' ? $('#d-content').focus() : show()));
show();

// Search: filters sidebar pages by title and body text; Enter opens the first match.
const q = $('#d-q'), text = new Map(sections.map((s) => [s.id, s.textContent.toLowerCase()]));
q.addEventListener('input', () => {
  const v = q.value.trim().toLowerCase();
  let any = false;
  for (const a of links) {
    const id = a.getAttribute('href').slice(1), hit = !v || a.textContent.toLowerCase().includes(v) || text.get(id)?.includes(v);
    a.hidden = !hit; any ||= hit;
  }
  for (const g of $$('.d-group', $('.d-side'))) { let n = g.nextElementSibling, vis = false; while (n && n.tagName === 'A') { vis ||= !n.hidden; n = n.nextElementSibling; } g.hidden = !vis; }
  $('.d-empty')?.remove();
  if (!any) $('.d-side').append(Object.assign(document.createElement('p'), { className: 'd-empty', textContent: 'No pages match.' }));
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const a = links.find((l) => !l.hidden); if (a) location.hash = a.getAttribute('href'); }
  if (e.key === 'Escape') { q.value = ''; q.dispatchEvent(new Event('input')); q.blur(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
});

// Mobile menu.
menu.addEventListener('click', () => { const open = side.classList.toggle('open'); menu.setAttribute('aria-expanded', String(open)); if (open) links.find((a) => !a.hidden)?.focus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

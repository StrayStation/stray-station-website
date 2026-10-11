import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { normalizeIsbn, isbnFromBarcode, findIsbnsInText } from './isbn.js';
import { lookupIsbn, searchOnline, fetchWorkDescription } from './lookup.js';
import { DEFAULT_CATEGORIES, suggestCategories, norm } from './categories.js';
import { startScanner, stopScanner, cameraErrorMessage } from './scan.js';
import { readText, fileToJpeg } from './ocr.js';

/* ---------- constants ---------- */

const STATUSES = [
  { value: 'unread', label: 'On the shelf' },
  { value: 'reading', label: 'Reading' },
  { value: 'read', label: 'Read' },
  { value: 'dnf', label: "Didn't finish" },
  { value: 'wishlist', label: 'Wishlist' },
];
const statusLabel = (v) => STATUSES.find((s) => s.value === v)?.label || v;
const FORMATS = ['Hardcover', 'Paperback', 'Mass-market paperback', 'Leather/cloth binding', 'Ebook', 'Audiobook', 'Other'];
const CONDITIONS = ['Fine', 'Very good', 'Good', 'Fair', 'Poor'];
const CLOTH = ['#2F5D62', '#6B2D2D', '#2E4A33', '#7A5C1E', '#3B4A63', '#4E3557', '#5A3B2E', '#24485E', '#5C5A2A'];
const BOOK_FIELDS = [
  'title', 'subtitle', 'authors', 'isbn13', 'isbn10', 'publisher', 'published', 'pages', 'description',
  'cover_url', 'categories', 'subjects', 'format', 'condition', 'location', 'acquired_on', 'acquired_from',
  'loaned_to', 'status', 'rating', 'review', 'started_on', 'finished_on', 'notes', 'source',
];

const configured = !SUPABASE_URL.includes('YOUR-') && !SUPABASE_ANON_KEY.includes('YOUR-');
const sb = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const state = {
  user: null,
  books: [],
  categories: [],
  loaded: false,
  draft: null,
  filter: { q: '', status: 'all', category: null },
  sort: 'recent',
  libScroll: 0,
  lastView: null,
};

/* ---------- DOM helpers ---------- */

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && (tag === 'input' || tag === 'textarea')) el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const ICONS = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>',
};
function icon(name, cls = 'icon') {
  const s = h('span', { class: cls });
  s.innerHTML = ICONS[name];
  return s;
}

const $view = () => document.getElementById('view');
function mount(...nodes) {
  const v = $view();
  v.replaceChildren(...nodes);
  return v;
}

let toastTimer;
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

function busy(msg) {
  const el = h('div', { class: 'busy', role: 'status' }, h('div', { class: 'spinner' }), h('p', {}, msg));
  document.body.append(el);
  return () => el.remove();
}

const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const authorsText = (b) => (b.authors || []).join(', ');
const hashCode = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

/* ---------- covers ---------- */

function coverSrc(book) {
  if (book.cover_path) return sb.storage.from('covers').getPublicUrl(book.cover_path).data.publicUrl;
  return book.cover_url || null;
}

/** Books without cover art (common for older books) get a cloth binding with foil lettering. */
function cloth(book) {
  const color = CLOTH[Math.abs(hashCode(book.title || '?')) % CLOTH.length];
  return h('div', { class: 'cloth', style: { '--cloth': color } },
    h('span', { class: 'cloth-title' }, book.title || 'Untitled'),
    book.authors?.[0] ? h('span', { class: 'cloth-author' }, book.authors[0]) : null,
  );
}

function cover(book, { previewUrl } = {}) {
  const wrap = h('div', { class: 'cover' });
  const src = previewUrl || coverSrc(book);
  if (!src) { wrap.append(cloth(book)); return wrap; }
  const img = h('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
  const fallback = () => wrap.replaceChildren(cloth(book));
  img.addEventListener('error', fallback);
  img.addEventListener('load', () => { if (img.naturalWidth < 10) fallback(); });
  wrap.append(img);
  return wrap;
}

/* ---------- data ---------- */

async function loadData() {
  const books = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('books').select('*').order('created_at', { ascending: false }).range(from, from + 999);
    if (error) throw error;
    books.push(...data);
    if (data.length < 1000) break;
  }
  state.books = books;

  let { data: cats, error } = await sb.from('categories').select('id,name').order('name');
  if (error) throw error;
  if (!cats.length) {
    const seed = DEFAULT_CATEGORIES.map((c) => ({ name: c.name }));
    const ins = await sb.from('categories').upsert(seed, { onConflict: 'user_id,name', ignoreDuplicates: true });
    if (ins.error) throw ins.error;
    ({ data: cats, error } = await sb.from('categories').select('id,name').order('name'));
    if (error) throw error;
  }
  state.categories = cats;
  state.loaded = true;
}

function upsertLocal(book) {
  const i = state.books.findIndex((b) => b.id === book.id);
  if (i >= 0) state.books[i] = book;
  else state.books.unshift(book);
}

async function patchBook(id, changes) {
  const { data, error } = await sb.from('books').update(changes).eq('id', id).select().single();
  if (error) throw error;
  upsertLocal(data);
  return data;
}

async function saveBook(draft, coverFile) {
  const row = {};
  for (const f of BOOK_FIELDS) if (f in draft) row[f] = draft[f];
  const q = draft.id
    ? sb.from('books').update(row).eq('id', draft.id).select().single()
    : sb.from('books').insert(row).select().single();
  const { data, error } = await q;
  if (error) throw error;
  let book = data;

  if (coverFile) {
    const blob = await fileToJpeg(coverFile, 1000, 0.82);
    const path = `${state.user.id}/${book.id}-${Date.now()}.jpg`;
    const up = await sb.storage.from('covers').upload(path, blob, { contentType: 'image/jpeg' });
    if (up.error) throw up.error;
    const old = book.cover_path;
    book = await patchBook(book.id, { cover_path: path });
    if (old) sb.storage.from('covers').remove([old]);
  } else if (draft.removeCoverPhoto && book.cover_path) {
    const old = book.cover_path;
    book = await patchBook(book.id, { cover_path: null });
    sb.storage.from('covers').remove([old]);
  }
  upsertLocal(book);
  return book;
}

async function deleteBook(book) {
  const { error } = await sb.from('books').delete().eq('id', book.id);
  if (error) throw error;
  if (book.cover_path) sb.storage.from('covers').remove([book.cover_path]);
  state.books = state.books.filter((b) => b.id !== book.id);
}

async function addCategory(name) {
  name = name.trim();
  if (!name) return null;
  const existing = state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const { data, error } = await sb.from('categories').insert({ name }).select('id,name').single();
  if (error) throw error;
  state.categories.push(data);
  state.categories.sort((a, b) => a.name.localeCompare(b.name));
  return data;
}

/* ---------- search & sort ---------- */

function haystack(b) {
  return norm([
    b.title, b.subtitle, authorsText(b), b.publisher, b.published, b.isbn13, b.isbn10,
    (b.categories || []).join(' '), b.location, b.notes, b.review, b.loaned_to,
  ].join(' '));
}

function filteredBooks() {
  const tokens = norm(state.filter.q).split(' ').filter(Boolean);
  const list = state.books.filter((b) => {
    if (state.filter.status !== 'all' && b.status !== state.filter.status) return false;
    if (state.filter.category && !(b.categories || []).includes(state.filter.category)) return false;
    if (!tokens.length) return true;
    const hay = haystack(b);
    return tokens.every((t) => hay.includes(t));
  });
  const lastName = (b) => norm((b.authors?.[0] || '').split(' ').pop());
  const byTitle = (a, b) => norm(a.title).replace(/^(the|a|an) /, '').localeCompare(norm(b.title).replace(/^(the|a|an) /, ''));
  const sorters = {
    recent: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
    title: byTitle,
    author: (a, b) => lastName(a).localeCompare(lastName(b)) || byTitle(a, b),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0) || byTitle(a, b),
    year: (a, b) => (parseInt(a.published) || 9999) - (parseInt(b.published) || 9999),
  };
  return list.sort(sorters[state.sort]);
}

/* ---------- views: auth ---------- */

function renderSetup() {
  setNav(false);
  mount(h('section', { class: 'panel narrow' },
    h('h1', { class: 'display' }, 'Almost ready'),
    h('p', {}, 'Add your Supabase project URL and anon key to config.js, then reload. The README walks through it in about ten minutes.'),
  ));
}

function renderSignIn() {
  setNav(false);
  let email = '';
  const emailInput = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true, inputmode: 'email', placeholder: 'you@example.com' });
  const codeInput = h('input', { type: 'text', id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6,10}', maxlength: '10', required: true });
  const msg = h('p', { class: 'form-msg', role: 'alert' });

  const codeForm = h('form', { class: 'stack', hidden: true, onsubmit: async (e) => {
    e.preventDefault();
    msg.textContent = '';
    const done = busy('Signing in…');
    const { error } = await sb.auth.verifyOtp({ email, token: codeInput.value.trim(), type: 'email' });
    done();
    if (error) msg.textContent = 'That code did not work. Check the latest email, or send a new code.';
  } },
    h('label', { for: 'code' }, 'Code from the email'),
    codeInput,
    h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { codeForm.hidden = true; emailForm.hidden = false; } }, 'Use a different email'),
  );

  const emailForm = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    msg.textContent = '';
    email = emailInput.value.trim();
    const done = busy('Sending code…');
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    done();
    if (error) { msg.textContent = error.message; return; }
    emailForm.hidden = true;
    codeForm.hidden = false;
    codeInput.focus();
  } },
    h('label', { for: 'email' }, 'Email'),
    emailInput,
    h('button', { class: 'btn primary', type: 'submit' }, 'Email me a sign-in code'),
  );

  mount(h('section', { class: 'panel narrow signin' },
    h('h1', { class: 'display' }, 'Dewey'),
    h('p', { class: 'lede' }, 'Your personal library, catalogued. Every book you own, findable in seconds. Sign in with a one-time code; no password needed.'),
    emailForm, codeForm, msg,
  ));
}

/* ---------- views: library ---------- */

function renderLibrary() {
  const count = h('p', { class: 'lib-count' });
  const grid = h('div', { class: 'grid' });
  const statusRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by status' });
  const catRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by category' });

  const search = h('input', {
    type: 'search', class: 'search', value: state.filter.q, placeholder: 'Search titles, authors, ISBNs, notes',
    'aria-label': 'Search your library', autocomplete: 'off', enterkeyhint: 'search',
  });
  search.addEventListener('input', debounce(() => { state.filter.q = search.value; draw(); }, 100));

  const sort = h('select', { class: 'sort', 'aria-label': 'Sort by', onchange: (e) => { state.sort = e.target.value; draw(); } },
    [['recent', 'Recently added'], ['title', 'Title'], ['author', 'Author'], ['rating', 'Rating'], ['year', 'Year published']]
      .map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l)));

  function chip(label, active, onclick, n) {
    return h('button', { class: `chip${active ? ' on' : ''}`, type: 'button', 'aria-pressed': String(active), onclick },
      label, n != null ? h('span', { class: 'n' }, n) : null);
  }

  function draw() {
    const counts = {};
    const catCounts = {};
    for (const b of state.books) {
      counts[b.status] = (counts[b.status] || 0) + 1;
      for (const c of b.categories || []) catCounts[c] = (catCounts[c] || 0) + 1;
    }
    statusRow.replaceChildren(
      chip('All', state.filter.status === 'all', () => { state.filter.status = 'all'; draw(); }),
      ...STATUSES.filter((s) => counts[s.value]).map((s) =>
        chip(s.label, state.filter.status === s.value, () => { state.filter.status = state.filter.status === s.value ? 'all' : s.value; draw(); }, counts[s.value])),
    );
    const cats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
    catRow.hidden = !cats.length;
    catRow.replaceChildren(...cats.map(([name, n]) =>
      chip(name, state.filter.category === name, () => { state.filter.category = state.filter.category === name ? null : name; draw(); }, n)));

    const list = filteredBooks();
    const filtering = state.filter.q || state.filter.status !== 'all' || state.filter.category;
    count.textContent = filtering
      ? `${list.length} of ${state.books.length} ${state.books.length === 1 ? 'book' : 'books'}`
      : `${state.books.length} ${state.books.length === 1 ? 'book' : 'books'}`;

    if (!state.books.length) {
      grid.replaceChildren(h('div', { class: 'empty' },
        h('p', { class: 'empty-title' }, 'No books yet'),
        h('p', {}, 'Scan a barcode to add your first one. Older books without a barcode can be added from a photo of the copyright page or by searching the title.'),
        h('a', { class: 'btn primary', href: '#/add/barcode' }, 'Scan a book'),
      ));
      return;
    }
    if (!list.length) {
      grid.replaceChildren(h('div', { class: 'empty' },
        h('p', { class: 'empty-title' }, 'No matches'),
        h('p', {}, 'Nothing in your library matches this search and filter.'),
        h('button', { class: 'btn', type: 'button', onclick: () => {
          state.filter = { q: '', status: 'all', category: null };
          search.value = '';
          draw();
        } }, 'Clear search and filters'),
      ));
      return;
    }
    grid.replaceChildren(...list.map((b) =>
      h('a', { class: 'tile', href: `#/book/${b.id}` },
        cover(b),
        h('span', { class: 'tile-title' }, b.title),
        h('span', { class: 'tile-author' }, b.authors?.[0] || ''),
        b.rating ? h('span', { class: 'tile-rating', 'aria-label': `${b.rating} of 5 stars` }, '★'.repeat(b.rating)) : null,
      )));
  }

  mount(
    h('header', { class: 'lib-head' },
      h('h1', { class: 'display' }, 'Library'),
      h('div', { class: 'lib-meta' }, count, sort),
    ),
    h('div', { class: 'filters' }, search, statusRow, catRow),
    grid,
  );
  draw();
  requestAnimationFrame(() => window.scrollTo(0, state.libScroll));
}

/* ---------- views: add ---------- */

const ADD_MODES = [
  ['barcode', 'Barcode'],
  ['photo', 'Photo'],
  ['search', 'Search'],
  ['manual', 'Type it in'],
];

function addShell(mode, ...body) {
  return [
    h('header', { class: 'page-head' }, h('h1', { class: 'display' }, 'Add a book')),
    h('nav', { class: 'segments', 'aria-label': 'How to add' },
      ADD_MODES.map(([m, label]) => h('a', { href: `#/add/${m}`, class: m === mode ? 'on' : '', 'aria-current': m === mode ? 'page' : null }, label))),
    ...body,
  ];
}

async function openIsbn(ids) {
  const existing = state.books.find((b) => b.isbn13 === ids.isbn13);
  if (existing && !confirm(`"${existing.title}" is already in your library. Add another copy?`)) {
    location.hash = `#/book/${existing.id}`;
    return;
  }
  const done = busy(`Looking up ISBN ${ids.isbn13}…`);
  try {
    const rec = await lookupIsbn(ids);
    if (rec) {
      startDraft(rec);
    } else {
      startDraft({ isbn13: ids.isbn13, isbn10: ids.isbn10, source: 'manual' }, {
        notice: `No online record for ISBN ${ids.isbn13}. Fill in what you know, or search by title and author instead.`,
      });
    }
  } catch (err) {
    toast(err.message, 'error');
    if (location.hash.startsWith('#/add')) route(); // restart the scanner or photo view
  } finally {
    done();
  }
}

function startDraft(rec, { notice } = {}) {
  const names = state.categories.map((c) => c.name);
  state.draft = {
    status: 'unread',
    authors: [],
    subjects: [],
    ...rec,
    categories: rec.categories || suggestCategories(rec, names),
    notice,
  };
  delete state.draft.thumb;
  delete state.draft.ol_key;
  if (location.hash === '#/new') route();
  else if (location.hash === '#/add/manual') location.replace('#/new');
  else location.hash = '#/new';
}

function isbnEntry() {
  const input = h('input', { type: 'text', inputmode: 'numeric', id: 'isbn-entry', autocomplete: 'off', placeholder: 'ISBN-10 or ISBN-13' });
  const form = h('form', { class: 'inline-form', onsubmit: (e) => {
    e.preventDefault();
    const ids = normalizeIsbn(input.value);
    if (!ids) { toast('That is not a valid ISBN. Check the digits, including a final X if there is one.', 'error'); return; }
    openIsbn(ids);
  } },
    h('label', { for: 'isbn-entry' }, 'Or type an ISBN'),
    h('div', { class: 'row' }, input, h('button', { class: 'btn', type: 'submit' }, 'Look up')),
  );
  return form;
}

function renderAddBarcode() {
  const video = h('video', { autoplay: true, muted: true, playsinline: true });
  const status = h('p', { class: 'scan-status', role: 'status' }, 'Starting camera…');
  const retry = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => begin() }, 'Try the camera again');
  let lastWarn = 0;

  const onCode = (raw) => {
    const ids = isbnFromBarcode(raw);
    if (!ids) {
      if (Date.now() - lastWarn > 2500) {
        lastWarn = Date.now();
        status.textContent = 'That barcode is a store code, not an ISBN. Look for a barcode starting with 978 or 979, often inside the front cover.';
      }
      return false;
    }
    navigator.vibrate?.(60);
    status.textContent = `Found ${ids.isbn13}`;
    openIsbn(ids);
    return true;
  };

  async function begin() {
    retry.hidden = true;
    status.textContent = 'Starting camera…';
    try {
      await startScanner(video, onCode);
      status.textContent = 'Hold the barcode inside the frame.';
    } catch (err) {
      status.textContent = cameraErrorMessage(err);
      retry.hidden = false;
    }
  }

  mount(...addShell('barcode',
    h('div', { class: 'viewfinder' }, video, h('div', { class: 'aim', 'aria-hidden': 'true' })),
    status, retry,
    isbnEntry(),
    h('p', { class: 'hint' }, 'No barcode? Books from before the 1980s often print an ISBN on the copyright page instead. Type it above, or use Photo to read it for you.'),
  ));
  begin();
}

function renderAddPhoto() {
  const out = h('div', { class: 'ocr-out' });
  const progress = h('progress', { max: '1', value: '0', hidden: true });
  const file = h('input', { type: 'file', accept: 'image/*', id: 'ocr-file', class: 'visually-hidden' });

  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    out.replaceChildren(h('p', { class: 'scan-status' }, 'Reading the text…'));
    progress.hidden = false;
    progress.value = 0;
    try {
      const text = await readText(f, (p) => (progress.value = p));
      progress.hidden = true;
      showText(text);
    } catch (err) {
      progress.hidden = true;
      out.replaceChildren(h('p', { class: 'form-msg' }, err.message));
    }
  });

  function showText(text) {
    const isbns = findIsbnsInText(text);
    if (isbns.length === 1) { openIsbn(isbns[0]); out.replaceChildren(); return; }

    const parts = [];
    if (isbns.length > 1) {
      parts.push(h('p', { class: 'scan-status' }, 'Found more than one ISBN. Often one is the hardcover and one the paperback; pick yours.'),
        h('div', { class: 'stack' }, isbns.map((ids) =>
          h('button', { class: 'btn', type: 'button', onclick: () => openIsbn(ids) }, `ISBN ${ids.isbn13}${ids.isbn10 ? ` (${ids.isbn10})` : ''}`))));
    }

    const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 2 && /[a-z]/i.test(l)).slice(0, 30);
    const title = h('input', { type: 'text', id: 'ocr-title' });
    const author = h('input', { type: 'text', id: 'ocr-author' });
    let target = title;
    title.addEventListener('focus', () => (target = title));
    author.addEventListener('focus', () => (target = author));

    parts.push(
      h('p', { class: 'scan-status' }, isbns.length ? 'Or search by title and author:' : 'No ISBN found. Tap the lines that hold the title and author, then search.'),
      h('div', { class: 'ocr-lines' }, lines.map((l) => h('button', { type: 'button', class: 'line', onclick: () => {
        target.value = target.value ? `${target.value} ${l}` : l;
        if (target === title) { target = author; author.focus({ preventScroll: true }); }
      } }, l))),
      h('form', { class: 'stack', onsubmit: (e) => {
        e.preventDefault();
        state.pendingSearch = { title: title.value, author: author.value };
        location.hash = '#/add/search';
      } },
        h('label', { for: 'ocr-title' }, 'Title'), title,
        h('label', { for: 'ocr-author' }, 'Author'), author,
        h('button', { class: 'btn primary', type: 'submit' }, 'Search'),
      ),
    );
    out.replaceChildren(...parts);
  }

  mount(...addShell('photo',
    h('p', { class: 'lede' }, 'Photograph the copyright page, where most books printed after 1970 list their ISBN. For older books, photograph the title page instead.'),
    h('label', { for: 'ocr-file', class: 'btn primary big' }, 'Take or choose a photo'),
    file, progress, out,
    h('p', { class: 'hint' }, 'Text is read on your phone, so photos are never uploaded. Fill the frame with the page and keep it flat and well lit.'),
  ));
}

function renderAddSearch() {
  const pending = state.pendingSearch || {};
  state.pendingSearch = null;
  const title = h('input', { type: 'text', id: 's-title', value: pending.title || '', autocomplete: 'off', enterkeyhint: 'search' });
  const author = h('input', { type: 'text', id: 's-author', value: pending.author || '', autocomplete: 'off', enterkeyhint: 'search' });
  const results = h('div', { class: 'results', 'aria-live': 'polite' });

  async function run() {
    if (!title.value.trim() && !author.value.trim()) { toast('Enter a title, an author, or both.'); return; }
    results.replaceChildren(h('div', { class: 'spinner small' }));
    try {
      const list = await searchOnline({ title: title.value, author: author.value });
      if (!list.length) {
        results.replaceChildren(h('p', { class: 'scan-status' }, 'No matches. Try fewer words, just the surname, or type the book in yourself.'), manualLink());
        return;
      }
      results.replaceChildren(...list.map((r) => h('button', { type: 'button', class: 'result', onclick: async () => {
        const rec = { ...r };
        if (r.ol_key && !r.description) {
          const done = busy('Getting details…');
          rec.description = await fetchWorkDescription(r.ol_key);
          done();
        }
        startDraft(rec);
      } },
        cover({ ...r, cover_url: r.thumb }),
        h('span', { class: 'result-text' },
          h('span', { class: 'result-title' }, r.title, r.subtitle ? h('span', { class: 'sub' }, `: ${r.subtitle}`) : null),
          h('span', { class: 'result-meta' }, [authorsText(r), r.published].filter(Boolean).join(', ')),
          h('span', { class: 'result-src' }, r.source),
        ),
      )), manualLink());
    } catch (err) {
      results.replaceChildren(h('p', { class: 'form-msg' }, err.message));
    }
  }

  function manualLink() {
    return h('button', { type: 'button', class: 'btn ghost', onclick: () =>
      startDraft({ title: title.value.trim(), authors: author.value.trim() ? [author.value.trim()] : [], source: 'manual' }) }, 'Not listed? Type it in yourself');
  }

  mount(...addShell('search',
    h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); run(); } },
      h('label', { for: 's-title' }, 'Title'), title,
      h('label', { for: 's-author' }, 'Author'), author,
      h('button', { class: 'btn primary', type: 'submit' }, 'Search'),
    ),
    results,
  ));
  if (pending.title || pending.author) run();
  else title.focus({ preventScroll: true });
}

/* ---------- views: edit form ---------- */

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
}
function textInput(id, value, attrs = {}) {
  return h('input', { type: 'text', id, name: id, value: value ?? '', ...attrs });
}
function selectInput(id, value, options, blank = 'Not set') {
  return h('select', { id, name: id },
    blank ? h('option', { value: '' }, blank) : null,
    options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: value === v }, l);
    }));
}

function starInput(initial, onChange) {
  let value = initial || 0;
  const wrap = h('div', { class: 'stars', role: 'radiogroup', 'aria-label': 'Rating' });
  const draw = () => wrap.replaceChildren(...[1, 2, 3, 4, 5].map((n) => {
    const btn = h('button', {
      type: 'button', class: `star${n <= value ? ' on' : ''}`, role: 'radio', 'aria-checked': String(n === value),
      'aria-label': `${n} star${n > 1 ? 's' : ''}`,
      onclick: () => { value = value === n ? 0 : n; draw(); onChange?.(value || null); },
    });
    btn.append(icon('star', 'star-icon'));
    return btn;
  }));
  draw();
  return { el: wrap, get: () => value || null };
}

function renderForm(draft) {
  const isNew = !draft.id;
  let coverFile = null;
  let previewUrl = null;
  let removeCoverPhoto = false;
  const chosen = new Set(draft.categories || []);

  const coverBox = h('div', { class: 'form-cover' });
  const drawCover = () => coverBox.replaceChildren(cover({ ...draft, title: titleIn.value || draft.title, cover_path: removeCoverPhoto ? null : draft.cover_path }, { previewUrl }));
  const coverFileIn = h('input', { type: 'file', accept: 'image/*', id: 'cover-file', class: 'visually-hidden', onchange: () => {
    const f = coverFileIn.files?.[0];
    if (!f) return;
    coverFile = f;
    removeCoverPhoto = false;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    drawCover();
  } });

  const titleIn = textInput('title', draft.title, { required: true, autocomplete: 'off' });
  const authorsIn = textInput('authors', (draft.authors || []).join('; '), { autocomplete: 'off' });
  const statusIn = selectInput('status', draft.status || 'unread', STATUSES.map((s) => [s.value, s.label]), null);
  const finishedIn = h('input', { type: 'date', id: 'finished_on', name: 'finished_on', value: draft.finished_on || '' });
  statusIn.addEventListener('change', () => { if (statusIn.value === 'read' && !finishedIn.value) finishedIn.value = today(); });
  const stars = starInput(draft.rating);

  const chosenBox = h('div', { class: 'chips wrap' });
  const otherBox = h('div', { class: 'chips wrap' });
  const catPicker = h('details', { class: 'cat-picker', open: !chosen.size }, h('summary', {}, 'Add or change categories'), otherBox);
  const catChip = (name) => h('button', {
    type: 'button', class: `chip${chosen.has(name) ? ' on' : ''}`, 'aria-pressed': String(chosen.has(name)),
    onclick: () => { chosen.has(name) ? chosen.delete(name) : chosen.add(name); drawCats(); },
  }, name);
  const drawCats = () => {
    const names = [...new Set([...state.categories.map((c) => c.name), ...chosen])].sort();
    chosenBox.replaceChildren(...(chosen.size ? names.filter((n) => chosen.has(n)).map(catChip) : [h('p', { class: 'hint' }, 'No categories yet.')]));
    otherBox.replaceChildren(...names.filter((n) => !chosen.has(n)).map(catChip));
  };
  const newCat = h('input', { type: 'text', id: 'new-cat', placeholder: 'New category', autocomplete: 'off' });
  const addCat = async () => {
    try {
      const c = await addCategory(newCat.value);
      if (c) { chosen.add(c.name); newCat.value = ''; drawCats(); }
    } catch (err) { toast(err.message, 'error'); }
  };
  newCat.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCat(); } });

  const msg = h('p', { class: 'form-msg', role: 'alert' });

  const form = h('form', { class: 'book-form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    msg.textContent = '';
    const fd = new FormData(form);
    const val = (k) => String(fd.get(k) || '').trim() || null;
    if (!val('title')) { msg.textContent = 'A title is needed to save the book.'; titleIn.focus(); return; }

    let isbn13 = val('isbn13');
    let isbn10 = null;
    const isbnSrc = isbn13 || isbn10;
    if (isbnSrc) {
      const ids = normalizeIsbn(isbnSrc);
      if (!ids) { msg.textContent = 'The ISBN does not check out. Fix the digits or clear the field.'; return; }
      ({ isbn13, isbn10 } = ids);
    }
    const pages = parseInt(val('pages'), 10);

    const out = {
      id: draft.id,
      title: val('title'),
      subtitle: val('subtitle'),
      authors: (val('authors') || '').split(';').map((s) => s.trim()).filter(Boolean),
      publisher: val('publisher'),
      published: val('published'),
      pages: Number.isFinite(pages) && pages > 0 ? pages : null,
      isbn13, isbn10,
      description: val('description'),
      cover_url: draft.cover_url || null,
      subjects: draft.subjects || [],
      categories: [...chosen],
      format: val('format'),
      condition: val('condition'),
      location: val('location'),
      acquired_on: val('acquired_on'),
      acquired_from: val('acquired_from'),
      loaned_to: val('loaned_to'),
      status: val('status') || 'unread',
      rating: stars.get(),
      review: val('review'),
      started_on: val('started_on'),
      finished_on: val('finished_on'),
      notes: val('notes'),
      source: draft.source || 'manual',
      removeCoverPhoto,
    };

    if (isNew && isbn13) {
      const dup = state.books.find((b) => b.isbn13 === isbn13);
      if (dup && !confirm(`"${dup.title}" with this ISBN is already in your library. Save another copy?`)) return;
    }

    const done = busy('Saving…');
    try {
      const book = await saveBook(out, coverFile);
      state.draft = null;
      toast(isNew ? 'Added to your library' : 'Changes saved', 'ok');
      location.hash = `#/book/${book.id}`;
    } catch (err) {
      msg.textContent = `Could not save: ${err.message}`;
    } finally {
      done();
    }
  } },

    draft.notice ? h('p', { class: 'notice' }, draft.notice, ' ', h('a', { href: '#/add/search' }, 'Search by title')) : null,

    h('div', { class: 'cover-row' },
      coverBox,
      h('div', { class: 'stack' },
        h('label', { for: 'cover-file', class: 'btn' }, 'Use my own photo'),
        draft.cover_path ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { removeCoverPhoto = true; coverFile = null; previewUrl = null; drawCover(); } }, 'Remove my photo') : null,
        draft.source && draft.source !== 'manual' ? h('p', { class: 'hint' }, `Details from ${draft.source}. Check them against your copy; older editions often differ.`) : null,
      ),
      coverFileIn,
    ),

    h('fieldset', {},
      h('legend', {}, 'The book'),
      field('Title', titleIn),
      field('Subtitle', textInput('subtitle', draft.subtitle)),
      field('Authors', authorsIn, 'Separate multiple authors with a semicolon.'),
      h('div', { class: 'two' },
        field('Publisher', textInput('publisher', draft.publisher)),
        field('Year', textInput('published', draft.published, { inputmode: 'numeric' })),
      ),
      h('div', { class: 'two' },
        field('ISBN', textInput('isbn13', draft.isbn13 || draft.isbn10, { inputmode: 'numeric', autocomplete: 'off' }), 'ISBN-10 or 13. Leave blank for books without one.'),
        field('Pages', textInput('pages', draft.pages, { inputmode: 'numeric' })),
      ),
      field('Description', h('textarea', { id: 'description', name: 'description', rows: '4' }, draft.description || '')),
    ),

    h('fieldset', {},
      h('legend', {}, 'Categories'),
      (isNew && (draft.categories || []).length) ? h('p', { class: 'hint' }, 'Suggested from the book’s subject headings. Tap to change.') : null,
      chosenBox,
      catPicker,
      h('div', { class: 'row' }, newCat, h('button', { type: 'button', class: 'btn', onclick: addCat }, 'Add')),
    ),

    h('fieldset', {},
      h('legend', {}, 'Reading'),
      field('Status', statusIn),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Your rating'), stars.el),
      h('div', { class: 'two' },
        field('Started', h('input', { type: 'date', id: 'started_on', name: 'started_on', value: draft.started_on || '' })),
        field('Finished', finishedIn),
      ),
      field('Review', h('textarea', { id: 'review', name: 'review', rows: '5', placeholder: 'What stayed with you?' }, draft.review || '')),
    ),

    h('fieldset', {},
      h('legend', {}, 'Your copy'),
      h('div', { class: 'two' },
        field('Format', selectInput('format', draft.format, FORMATS)),
        field('Condition', selectInput('condition', draft.condition, CONDITIONS)),
      ),
      field('Shelf or location', textInput('location', draft.location, { placeholder: 'Den, shelf 3' })),
      h('div', { class: 'two' },
        field('Acquired', h('input', { type: 'date', id: 'acquired_on', name: 'acquired_on', value: draft.acquired_on || '' })),
        field('From', textInput('acquired_from', draft.acquired_from, { placeholder: 'Library sale, gift…' })),
      ),
      field('Loaned to', textInput('loaned_to', draft.loaned_to)),
      field('Notes', h('textarea', { id: 'notes', name: 'notes', rows: '3', placeholder: 'Inscriptions, edition details, provenance' }, draft.notes || '')),
    ),

    msg,
    h('div', { class: 'form-actions' },
      h('a', { class: 'btn ghost', href: isNew ? '#/add/barcode' : `#/book/${draft.id}` }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Save to library' : 'Save changes'),
    ),
  );

  titleIn.addEventListener('input', debounce(drawCover, 300));
  drawCover();
  drawCats();

  mount(
    h('header', { class: 'page-head' },
      isNew ? null : h('a', { class: 'back', href: `#/book/${draft.id}` }, icon('back'), 'Book'),
      h('h1', { class: 'display' }, isNew ? 'Check the details' : 'Edit book'),
    ),
    form,
  );
  if (state.focusReview) {
    state.focusReview = false;
    document.getElementById('review')?.scrollIntoView({ block: 'center' });
    document.getElementById('review')?.focus({ preventScroll: true });
  }
}

/* ---------- views: book detail ---------- */

function renderBook(id) {
  const b = state.books.find((x) => x.id === id);
  if (!b) {
    mount(h('section', { class: 'panel narrow' }, h('p', {}, 'This book is not in your library.'), h('a', { class: 'btn', href: '#/library' }, 'Back to library')));
    return;
  }

  const stars = starInput(b.rating, async (rating) => {
    try { await patchBook(b.id, { rating }); toast(rating ? 'Rating saved' : 'Rating cleared', 'ok'); }
    catch (err) { toast(`Could not save rating: ${err.message}`, 'error'); }
  });
  const status = selectInput('quick-status', b.status, STATUSES.map((s) => [s.value, s.label]), null);
  status.setAttribute('aria-label', 'Reading status');
  status.addEventListener('change', async () => {
    const changes = { status: status.value };
    if (status.value === 'read' && !b.finished_on) changes.finished_on = today();
    if (status.value === 'reading' && !b.started_on) changes.started_on = today();
    try { Object.assign(b, await patchBook(b.id, changes)); toast(`Marked ${statusLabel(status.value).toLowerCase()}`, 'ok'); }
    catch (err) { toast(`Could not update: ${err.message}`, 'error'); }
  });

  const meta = [
    ['Publisher', b.publisher], ['Year', b.published], ['Pages', b.pages],
    ['ISBN', [b.isbn13, b.isbn10].filter(Boolean).join(' / ')], ['Format', b.format], ['Condition', b.condition],
    ['Location', b.location], ['Acquired', [b.acquired_on, b.acquired_from].filter(Boolean).join(', ')],
    ['Loaned to', b.loaned_to], ['Started', b.started_on], ['Finished', b.finished_on],
  ].filter(([, v]) => v != null && v !== '');

  mount(h('article', { class: 'book' },
    h('a', { class: 'back', href: '#/library' }, icon('back'), 'Library'),
    h('div', { class: 'book-hero' },
      cover(b),
      h('div', { class: 'book-id' },
        h('h1', { class: 'book-title' }, b.title),
        b.subtitle ? h('p', { class: 'book-sub' }, b.subtitle) : null,
        h('p', { class: 'book-authors' }, authorsText(b) || 'Unknown author'),
        b.loaned_to ? h('p', { class: 'loan' }, `On loan to ${b.loaned_to}`) : null,
      ),
    ),
    h('div', { class: 'quick' }, stars.el, status),
    (b.categories || []).length ? h('div', { class: 'chips wrap' }, b.categories.map((c) =>
      h('button', { type: 'button', class: 'chip', onclick: () => { state.filter = { q: '', status: 'all', category: c }; state.libScroll = 0; location.hash = '#/library'; } }, c))) : null,

    h('section', { class: 'review' },
      h('h2', {}, 'Your review'),
      b.review ? h('p', { class: 'review-text' }, b.review) : null,
      h('a', { class: 'btn', href: `#/edit/${b.id}`, onclick: () => (state.focusReview = true) }, b.review ? 'Edit review' : 'Write a review'),
    ),

    meta.length ? h('dl', { class: 'meta' }, meta.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])) : null,
    b.description ? h('details', { class: 'desc' }, h('summary', {}, 'Description'), h('p', {}, b.description)) : null,
    b.notes ? h('section', { class: 'notes' }, h('h2', {}, 'Notes'), h('p', {}, b.notes)) : null,

    h('div', { class: 'form-actions' },
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!confirm(`Delete "${b.title}" from your library? This cannot be undone.`)) return;
        try { await deleteBook(b); toast('Book deleted'); location.hash = '#/library'; }
        catch (err) { toast(`Could not delete: ${err.message}`, 'error'); }
      } }, 'Delete'),
      h('a', { class: 'btn', href: `#/edit/${b.id}` }, 'Edit details'),
    ),
  ));
}

/* ---------- views: settings ---------- */

function csvCell(v) {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const cols = ['title', 'subtitle', 'authors', 'isbn13', 'isbn10', 'publisher', 'published', 'pages', 'categories', 'status',
    'rating', 'review', 'started_on', 'finished_on', 'format', 'condition', 'location', 'acquired_on', 'acquired_from', 'loaned_to', 'notes', 'created_at'];
  const rows = [cols.join(','), ...state.books.map((b) => cols.map((c) => csvCell(b[c])).join(','))];
  const blob = new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `dewey-library-${today()}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
}

function renderSettings() {
  const used = {};
  for (const b of state.books) for (const c of b.categories || []) used[c] = (used[c] || 0) + 1;
  const list = h('ul', { class: 'cat-list' });
  const drawList = () => list.replaceChildren(...state.categories.map((c) =>
    h('li', {}, h('span', {}, c.name, used[c.name] ? h('span', { class: 'n' }, used[c.name]) : null),
      h('button', { type: 'button', class: 'btn ghost small', 'aria-label': `Remove ${c.name}`, onclick: async () => {
        const n = used[c.name] || 0;
        if (n && !confirm(`Remove "${c.name}" from the category list? The ${n} book${n > 1 ? 's' : ''} tagged with it keep the tag.`)) return;
        const { error } = await sb.from('categories').delete().eq('id', c.id);
        if (error) { toast(error.message, 'error'); return; }
        state.categories = state.categories.filter((x) => x.id !== c.id);
        drawList();
      } }, 'Remove'))));
  drawList();
  const newCat = h('input', { type: 'text', id: 'settings-cat', placeholder: 'New category', autocomplete: 'off' });

  mount(
    h('header', { class: 'page-head' }, h('h1', { class: 'display' }, 'Settings')),
    h('section', { class: 'panel' },
      h('h2', {}, 'Account'),
      h('p', {}, `Signed in as ${state.user.email}. Your library is private to this account.`),
      h('button', { class: 'btn', type: 'button', onclick: () => sb.auth.signOut() }, 'Sign out'),
    ),
    h('section', { class: 'panel' },
      h('h2', {}, 'Backup'),
      h('p', {}, `Download all ${state.books.length} books as a spreadsheet file (CSV).`),
      h('button', { class: 'btn', type: 'button', onclick: exportCsv, disabled: !state.books.length }, 'Download CSV'),
    ),
    h('section', { class: 'panel' },
      h('h2', {}, 'Categories'),
      list,
      h('form', { class: 'row', onsubmit: async (e) => {
        e.preventDefault();
        try { await addCategory(newCat.value); newCat.value = ''; drawList(); } catch (err) { toast(err.message, 'error'); }
      } }, newCat, h('button', { class: 'btn', type: 'submit' }, 'Add')),
    ),
    h('section', { class: 'panel' },
      h('h2', {}, 'Install on your phone'),
      h('p', {}, 'iPhone: open this page in Safari, tap Share, then Add to Home Screen.'),
      h('p', {}, 'Android: open this page in Chrome, tap the ⋮ menu, then Install app.'),
    ),
  );
}

/* ---------- routing ---------- */

function setNav(show, tab) {
  const nav = document.getElementById('tabbar');
  nav.hidden = !show;
  document.body.classList.toggle('has-nav', show);
  for (const a of nav.querySelectorAll('a')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function route() {
  stopScanner();
  if (!configured) return renderSetup();
  if (!state.user) return renderSignIn();
  if (!state.loaded) return;

  const [, view = 'library', id] = (location.hash || '#/library').split('/');
  if (state.lastView === 'library' && view !== 'library') state.libScroll = window.scrollY;
  state.lastView = view;
  const tab = view === 'add' || view === 'new' ? 'add' : view === 'settings' ? 'settings' : 'library';
  setNav(true, tab);
  if (view !== 'library') window.scrollTo(0, 0);

  switch (view) {
    case 'library': return renderLibrary();
    case 'book': return renderBook(id);
    case 'edit': {
      const b = state.books.find((x) => x.id === id);
      return b ? renderForm({ ...b }) : renderBook(id);
    }
    case 'new':
      if (!state.draft) { location.replace('#/add/barcode'); return; }
      return renderForm(state.draft);
    case 'add':
      if (id === 'photo') return renderAddPhoto();
      if (id === 'search') return renderAddSearch();
      if (id === 'manual') { startDraft({ source: 'manual' }); return; }
      return renderAddBarcode();
    case 'settings': return renderSettings();
    default: location.replace('#/library');
  }
}

async function boot() {
  if (!state.user) {
    state.books = [];
    state.categories = [];
    state.loaded = false;
    return route();
  }
  setNav(false);
  mount(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('p', {}, 'Opening Dewey…')));
  try {
    await loadData();
  } catch (err) {
    mount(h('section', { class: 'panel narrow' },
      h('h1', { class: 'display' }, 'Could not open your library'),
      h('p', {}, err.message),
      h('p', { class: 'hint' }, 'If this is a new setup, check that schema.sql ran in the Supabase SQL editor. If the project was idle for a week, it may be paused; restore it from the Supabase dashboard.'),
      h('button', { class: 'btn', type: 'button', onclick: boot }, 'Try again'),
    ));
    return;
  }
  route();
}

window.addEventListener('hashchange', route);

if (!configured) {
  renderSetup();
} else {
  let bootedFor;
  sb.auth.onAuthStateChange((_event, session) => {
    state.user = session?.user ?? null;
    const uid = state.user?.id ?? null;
    if (uid === bootedFor) return;
    bootedFor = uid;
    setTimeout(boot, 0); // run outside the auth callback, per Supabase guidance
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

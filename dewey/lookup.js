// Free book metadata lookups. Open Library first (strongest for older and out-of-print books),
// Google Books second (better descriptions). Neither needs an API key.

const TIMEOUT_MS = 9000;

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const https = (u) => (u ? String(u).replace(/^http:/, 'https:') : null);
const stripHtml = (s) => (s ? String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null);
const hasValue = (v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0);

export function yearOf(s) {
  if (s == null) return null;
  const m = String(s).match(/\b(1[4-9]\d\d|20\d\d)\b/);
  return m ? m[1] : String(s).trim() || null;
}

export const olCover = (id, size = 'L') => `https://covers.openlibrary.org/b/id/${id}-${size}.jpg`;

function uniq(list) {
  const seen = new Set();
  return list.filter((x) => {
    const k = String(x).toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function gbCover(links) {
  const u = links?.thumbnail || links?.smallThumbnail;
  return u ? https(u).replace('&edge=curl', '').replace(/zoom=\d/, 'zoom=1') : null;
}

function gbIsbns(v) {
  const ids = v.industryIdentifiers || [];
  return {
    isbn13: ids.find((i) => i.type === 'ISBN_13')?.identifier || null,
    isbn10: ids.find((i) => i.type === 'ISBN_10')?.identifier || null,
  };
}

function fromGoogle(v) {
  return {
    title: v.title || null,
    subtitle: v.subtitle || null,
    authors: v.authors || [],
    publisher: v.publisher || null,
    published: yearOf(v.publishedDate),
    pages: v.pageCount || null,
    subjects: v.categories || [],
    description: stripHtml(v.description),
    cover_url: gbCover(v.imageLinks),
    ...gbIsbns(v),
  };
}

async function openLibraryByIsbn(isbn) {
  const j = await fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  const d = j[`ISBN:${isbn}`];
  if (!d) return null;
  return {
    title: d.title || null,
    subtitle: d.subtitle || null,
    authors: (d.authors || []).map((a) => a.name),
    publisher: d.publishers?.[0]?.name || null,
    published: yearOf(d.publish_date),
    pages: d.number_of_pages || null,
    subjects: (d.subjects || []).map((s) => s.name),
    cover_url: d.cover ? https(d.cover.large || d.cover.medium) : null,
  };
}

async function googleByIsbn(isbn) {
  const j = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`);
  const v = j.items?.[0]?.volumeInfo;
  return v ? fromGoogle(v) : null;
}

function merge(primary, secondary) {
  const p = primary || {};
  const s = secondary || {};
  const pick = (k) => (hasValue(p[k]) ? p[k] : hasValue(s[k]) ? s[k] : null);
  return {
    title: pick('title'),
    subtitle: pick('subtitle'),
    authors: pick('authors') || [],
    publisher: pick('publisher'),
    published: pick('published'),
    pages: pick('pages'),
    description: s.description || p.description || null,
    cover_url: pick('cover_url'),
    subjects: uniq([...(p.subjects || []), ...(s.subjects || [])]).slice(0, 40),
  };
}

/**
 * Look up a book by ISBN. `ids` is { isbn13, isbn10 } from normalizeIsbn().
 * Returns a draft-shaped record, or null when neither source knows the book.
 */
export async function lookupIsbn(ids) {
  const [ol, gb] = await Promise.allSettled([openLibraryByIsbn(ids.isbn13), googleByIsbn(ids.isbn13)]);
  let a = ol.status === 'fulfilled' ? ol.value : null;
  let b = gb.status === 'fulfilled' ? gb.value : null;

  // Some older records are only indexed under the ISBN-10.
  if (!a && ids.isbn10) a = await openLibraryByIsbn(ids.isbn10).catch(() => null);
  if (!b && ids.isbn10) b = await googleByIsbn(ids.isbn10).catch(() => null);

  if (!a && !b) {
    if (ol.status === 'rejected' && gb.status === 'rejected') {
      throw new Error('Book lookups are not responding. Check your connection and try again.');
    }
    return null;
  }
  const rec = merge(a, b);
  if (!rec.cover_url) rec.cover_url = `https://covers.openlibrary.org/b/isbn/${ids.isbn13}-L.jpg?default=false`;
  rec.source = a && b ? 'Open Library + Google Books' : a ? 'Open Library' : 'Google Books';
  return { ...rec, isbn13: ids.isbn13, isbn10: ids.isbn10 };
}

/** Search by title and/or author across both sources. Returns a list of draft-shaped records. */
export async function searchOnline({ title = '', author = '' }) {
  title = title.trim();
  author = author.trim();
  if (!title && !author) return [];

  const olParams = new URLSearchParams({
    limit: '15',
    fields: 'key,title,subtitle,author_name,first_publish_year,cover_i,subject,publisher,number_of_pages_median',
  });
  if (title) olParams.set('title', title);
  if (author) olParams.set('author', author);

  const gbQuery = [title && `intitle:${title}`, author && `inauthor:${author}`].filter(Boolean).join(' ');

  const [ol, gb] = await Promise.allSettled([
    fetchJson(`https://openlibrary.org/search.json?${olParams}`),
    fetchJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(gbQuery)}&maxResults=12&printType=books`),
  ]);

  if (ol.status === 'rejected' && gb.status === 'rejected') {
    throw new Error('Book search is not responding. Check your connection and try again.');
  }

  const olResults = ol.status === 'fulfilled'
    ? (ol.value.docs || []).map((d) => ({
        title: d.title || null,
        subtitle: d.subtitle || null,
        authors: d.author_name || [],
        publisher: d.publisher?.[0] || null,
        published: d.first_publish_year ? String(d.first_publish_year) : null,
        pages: d.number_of_pages_median || null,
        subjects: (d.subject || []).slice(0, 40),
        cover_url: d.cover_i ? olCover(d.cover_i, 'L') : null,
        thumb: d.cover_i ? olCover(d.cover_i, 'M') : null,
        ol_key: d.key,
        source: 'Open Library',
      }))
    : [];

  const gbResults = gb.status === 'fulfilled'
    ? (gb.value.items || []).map((it) => {
        const r = fromGoogle(it.volumeInfo || {});
        return { ...r, thumb: r.cover_url, source: 'Google Books' };
      })
    : [];

  // Interleave so both sources show near the top, then drop exact duplicates.
  const out = [];
  const seen = new Set();
  for (let i = 0; i < Math.max(olResults.length, gbResults.length); i++) {
    for (const r of [olResults[i], gbResults[i]]) {
      if (!r || !r.title) continue;
      const key = `${r.title}|${r.authors[0] || ''}|${r.published || ''}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out.slice(0, 24);
}

/** Open Library search results don't include descriptions; fetch one from the work record. */
export async function fetchWorkDescription(olKey) {
  if (!olKey) return null;
  try {
    const w = await fetchJson(`https://openlibrary.org${olKey}.json`);
    const d = w.description;
    return stripHtml(typeof d === 'string' ? d : d?.value) || null;
  } catch {
    return null;
  }
}

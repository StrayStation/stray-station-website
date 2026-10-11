// ISBN helpers: validate, convert between ISBN-10 and ISBN-13, and pull ISBNs out of OCR text.

export function cleanIsbn(s) {
  return String(s || '').toUpperCase().replace(/[^0-9X]/g, '');
}

export function validIsbn10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : +s[i]) * (10 - i);
  return sum % 11 === 0;
}

export function validIsbn13(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += +s[i] * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}

export function isbn10to13(s) {
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +core[i] * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}

export function isbn13to10(s) {
  if (!s.startsWith('978')) return null; // 979 ISBNs have no ISBN-10 form
  const core = s.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += +core[i] * (10 - i);
  const c = (11 - (sum % 11)) % 11;
  return core + (c === 10 ? 'X' : String(c));
}

/** Returns { isbn13, isbn10 } for any valid ISBN-10 or ISBN-13 string, else null. */
export function normalizeIsbn(s) {
  const c = cleanIsbn(s);
  if (validIsbn13(c)) return { isbn13: c, isbn10: isbn13to10(c) };
  if (validIsbn10(c)) return { isbn10: c, isbn13: isbn10to13(c) };
  return null;
}

/** Barcodes: only "Bookland" EAN-13 (978/979) codes are ISBNs. */
export function isbnFromBarcode(raw) {
  const c = String(raw || '').replace(/\D/g, '');
  return c.length === 13 ? normalizeIsbn(c) : null;
}

/** Find valid ISBNs in OCR text, tolerating spaces, hyphens and common misreads (O→0, I/l→1). */
export function findIsbnsInText(text) {
  const found = new Map();
  const candidates = String(text || '').match(/[0-9IlO][0-9IlOo\s\-–—.]{8,24}[0-9Xx]/g) || [];
  for (const cand of candidates) {
    const digits = cand
      .replace(/[Il]/g, '1')
      .replace(/[Oo]/g, '0')
      .toUpperCase()
      .replace(/[^0-9X]/g, '');
    const tries = [];
    for (const len of [13, 10]) {
      for (let i = 0; i + len <= digits.length; i++) tries.push(digits.slice(i, i + len));
    }
    for (const t of tries) {
      if (t.slice(0, -1).includes('X')) continue;
      const n = normalizeIsbn(t);
      if (n && !found.has(n.isbn13)) found.set(n.isbn13, n);
    }
  }
  return [...found.values()];
}


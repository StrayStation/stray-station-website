// Default categories each new library starts with, plus keywords used to suggest
// categories from the subject headings Open Library and Google Books return.
// Edit freely: names here only seed a brand-new library; after that, categories live in the database.

export const DEFAULT_CATEGORIES = [
  { name: 'Fiction', kw: ['fiction', 'novel', 'novels', 'short stories', 'stories'] },
  { name: 'Mystery & Crime', kw: ['mystery', 'mysteries', 'detective', 'detectives', 'crime', 'murder', 'thriller', 'thrillers', 'suspense', 'police', 'spy', 'espionage', 'noir'] },
  { name: 'Science Fiction', kw: ['science fiction', 'sci fi', 'dystopia', 'dystopias', 'time travel', 'robots', 'extraterrestrial', 'space opera', 'cyberpunk'] },
  { name: 'Fantasy', kw: ['fantasy', 'magic', 'wizards', 'dragons', 'fairy tales', 'elves'] },
  { name: 'Historical Fiction', kw: ['historical fiction', 'fiction historical'] },
  { name: 'Classics', kw: ['classics', 'classic literature', 'english literature', 'american literature', 'literature'] },
  { name: 'Biography & Memoir', kw: ['biography', 'biographies', 'autobiography', 'memoir', 'memoirs', 'diaries', 'correspondence'] },
  { name: 'History', kw: ['history', 'civil war', 'world war', 'military', 'ancient', 'medieval', 'revolution', 'wars'] },
  { name: 'Business & Leadership', kw: ['business', 'management', 'leadership', 'economics', 'finance', 'marketing', 'entrepreneurship', 'investing', 'supply chain', 'operations', 'manufacturing', 'strategy', 'lean'] },
  { name: 'Science & Nature', kw: ['science', 'physics', 'biology', 'chemistry', 'astronomy', 'nature', 'natural history', 'evolution', 'mathematics', 'ecology', 'animals', 'birds', 'geology'] },
  { name: 'Technology', kw: ['computers', 'technology', 'programming', 'software', 'engineering', 'internet', 'artificial intelligence'] },
  { name: 'Philosophy & Religion', kw: ['philosophy', 'religion', 'christianity', 'bible', 'theology', 'spirituality', 'buddhism', 'ethics', 'islam', 'judaism', 'spiritual life'] },
  { name: 'Self-Help & Psychology', kw: ['self help', 'psychology', 'personal development', 'motivation', 'success', 'happiness', 'habits', 'mindfulness'] },
  { name: 'Poetry', kw: ['poetry', 'poems', 'verse'] },
  { name: 'Art & Design', kw: ['art', 'painting', 'photography', 'design', 'architecture', 'music'] },
  { name: 'Travel', kw: ['travel', 'guidebooks', 'description and travel', 'voyages'] },
  { name: 'Food & Drink', kw: ['cooking', 'cookery', 'recipes', 'food', 'wine', 'baking', 'cookbooks'] },
  { name: 'Reference', kw: ['reference', 'dictionaries', 'encyclopedias', 'atlases', 'handbooks', 'manuals'] },
  { name: "Children's & Young Adult", kw: ['juvenile', 'juvenile fiction', 'juvenile literature', 'children', 'young adult', 'picture books'] },
  { name: 'Humor', kw: ['humor', 'humour', 'comedy', 'satire', 'wit and humor'] },
  { name: 'Politics & Society', kw: ['politics', 'government', 'sociology', 'law', 'political science', 'current events', 'social conditions'] },
  { name: 'Sports & Outdoors', kw: ['sports', 'baseball', 'football', 'golf', 'fishing', 'hunting', 'hiking', 'outdoor'] },
  { name: 'Home & Hobbies', kw: ['gardening', 'crafts', 'woodworking', 'antiques', 'collecting', 'games', 'puzzles'] },
];

const FICTION_GENRES = new Set(['Mystery & Crime', 'Science Fiction', 'Fantasy', 'Historical Fiction']);

export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const hits = (padded, kw) => padded.includes(` ${norm(kw)} `);

/**
 * Suggest up to two of the user's categories for a book draft.
 * Subjects count double; title and description count once.
 */
export function suggestCategories(draft, userCategoryNames) {
  const subj = ` ${norm((draft.subjects || []).join(' | '))} `;
  const text = ` ${norm(`${draft.title || ''} ${draft.subtitle || ''} ${draft.description || ''}`)} `;
  const scores = [];

  for (const name of userCategoryNames) {
    const def = DEFAULT_CATEGORIES.find((c) => c.name === name);
    const kws = def ? def.kw : [name];
    let score = 0;
    for (const kw of kws) {
      if (hits(subj, kw)) score += 2;
      if (hits(text, kw)) score += 1;
    }
    if (score > 0) scores.push({ name, score });
  }

  scores.sort((a, b) => b.score - a.score);
  let picks = scores.map((s) => s.name);
  if (picks.some((p) => FICTION_GENRES.has(p))) picks = picks.filter((p) => p !== 'Fiction');
  return picks.slice(0, 2);
}

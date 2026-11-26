/** Búsqueda global: lógica pura (sin DOM ni base de datos). */

export type SearchKind = 'book' | 'note' | 'entry' | 'quote' | 'character' | 'chat';

export const SEARCH_KINDS: SearchKind[] = ['book', 'note', 'entry', 'quote', 'character', 'chat'];

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  book: 'Libros',
  note: 'Notas finales',
  entry: 'Anotaciones',
  quote: 'Citas',
  character: 'Personajes',
  chat: 'Charlas con la IA',
};

export interface SearchDoc {
  kind: SearchKind;
  id: string;
  bookId: string;
  bookTitle: string;
  title: string;
  /** Textos donde se busca, además del título. */
  fields: Array<string | null | undefined>;
}

export interface SearchHit {
  doc: SearchDoc;
  /** Fragmento alrededor de la coincidencia, dividido para resaltarla sin armar HTML acá. */
  snippet: Array<{ text: string; mark: boolean }>;
  score: number;
}

/** Minúsculas sin tildes, recordando a qué posición del original corresponde cada carácter. */
function fold(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let at = 0;
  for (const char of text) {
    const plain = char.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (let i = 0; i < plain.length; i++) map.push(at);
    folded += plain;
    at += char.length;
  }
  map.push(at);
  return { folded, map };
}

export function searchTerms(query: string): string[] {
  return [...new Set(fold(query).folded.split(/\s+/).filter(Boolean))];
}

function snippetFor(text: string, terms: string[], max = 150): SearchHit['snippet'] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const { folded, map } = fold(clean);
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    for (let i = folded.indexOf(term); i >= 0; i = folded.indexOf(term, i + term.length)) {
      ranges.push([map[i], map[i + term.length]]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(first - 40, clean.length - max));
  const end = Math.min(clean.length, start + max);
  const parts: SearchHit['snippet'] = [];
  let cursor = start;
  for (const [from, to] of ranges) {
    if (from < cursor || from >= end) continue;
    if (from > cursor) parts.push({ text: clean.slice(cursor, from), mark: false });
    parts.push({ text: clean.slice(from, Math.min(to, end)), mark: true });
    cursor = Math.min(to, end);
  }
  if (cursor < end) parts.push({ text: clean.slice(cursor, end), mark: false });
  if (start > 0 && parts.length) parts.unshift({ text: '…', mark: false });
  if (end < clean.length) parts.push({ text: '…', mark: false });
  return parts;
}

/**
 * Devuelve los registros que contienen todas las palabras (en cualquier campo, sin distinguir
 * tildes ni mayúsculas). Primero las coincidencias en el título; el resto conserva su orden.
 */
export function searchDocs(docs: SearchDoc[], query: string): SearchHit[] {
  const terms = searchTerms(query);
  if (terms.join('').length < 2) return [];
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const fields = doc.fields.map((f) => String(f ?? '')).filter(Boolean);
    const title = fold(doc.title).folded;
    const folded = fields.map((f) => fold(f).folded);
    const everything = [title, ...folded].join('\n');
    if (!terms.every((term) => everything.includes(term))) continue;
    const best = folded.findIndex((f) => terms.some((term) => f.includes(term)));
    hits.push({
      doc,
      snippet: snippetFor(fields[best >= 0 ? best : 0] ?? '', terms),
      score: terms.filter((term) => title.includes(term)).length,
    });
  }
  return hits.sort((a, b) => b.score - a.score);
}

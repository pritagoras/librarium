import { prepareCharacterBackup, safeId } from './characters-model';

export function slug(s: string) {
  return (s || 'librarium')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function download(obj: unknown, name: string) {
  const a = document.createElement('a');
  const u = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.href = u;
  a.download = name;
  a.click();
  URL.revokeObjectURL(u);
}

function decodePastedJSON(raw: string) {
  const s = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return JSON.parse(s);
  } catch {}
  const cleaned = s
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) =>
      String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10)),
    )
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\\\s*(\r?\n)/g, '$1')
    .replace(/\\\s*$/g, '');
  return JSON.parse(cleaned);
}

export function validateNotesJSON(raw: string) {
  const obj = decodePastedJSON(raw);
  if (!obj || !Array.isArray(obj.notes) || !obj.notes.length) {
    throw Error("El JSON debe incluir un arreglo 'notes' con al menos una nota.");
  }
  let section = 1;
  let lastNumber = 0;
  const seen = new Set<string>();
  const notes = obj.notes.map((n: any, i: number) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      throw Error(`La nota ${i + 1} debe ser un objeto.`);
    }
    const number = Number(n.number);
    if (!Number.isInteger(number) || number < 1) {
      throw Error(`La nota ${i + 1} necesita un número entero mayor que cero.`);
    }
    if (n.section != null) {
      const explicit = Number(n.section);
      if (!Number.isInteger(explicit) || explicit < 1) {
        throw Error(`La sección de la nota ${number} debe ser un entero positivo.`);
      }
      section = explicit;
    } else if (i > 0 && number <= lastNumber) {
      section++;
    }
    lastNumber = number;
    const key = `${section}:${number}`;
    if (seen.has(key)) {
      throw Error(`El número ${number} aparece más de una vez en la sección ${section}.`);
    }
    seen.add(key);
    if (typeof n.text !== 'string' || !n.text.trim()) {
      throw Error(`La nota ${number} necesita texto.`);
    }
    const page = (v: unknown, label: string) => {
      if (v == null || v === '') return null;
      const x = Number(v);
      if (!Number.isInteger(x) || x < 0) {
        throw Error(`La página ${label} de la nota ${number} debe ser un entero igual o mayor que cero, o null.`);
      }
      return x;
    };
    return {
      number,
      section,
      referencePage: page(n.reference_page ?? n.referencePage, 'de referencia'),
      endPage: page(n.end_page ?? n.endPage, 'de nota'),
      text: n.text,
      comment: typeof n.comment === 'string' ? n.comment : '',
      read: Boolean(n.read),
    };
  });
  return { obj, notes };
}

export interface BackupData {
  books: Record<string, any>[];
  notes: Record<string, any>[];
  entries: Record<string, any>[];
  quotes: Record<string, any>[];
  analyses: Record<string, any>[];
  characters: Record<string, any>[];
  characterRelations: Record<string, any>[];
  conversations: Record<string, any>[];
}

const BACKUP_COLLECTIONS = [
  'books', 'notes', 'entries', 'quotes', 'analyses', 'characters', 'characterRelations', 'conversations',
] as const;

export function parseBackupJSON(raw: string): BackupData {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Error('La copia debe ser un objeto JSON.');
  }
  for (const required of ['books', 'notes', 'entries'] as const) {
    if (!Array.isArray(parsed[required])) throw Error(`La copia no contiene una lista válida de ${required}.`);
  }
  const backup = {} as BackupData;
  for (const collection of BACKUP_COLLECTIONS) {
    const records = parsed[collection] ?? [];
    if (!Array.isArray(records)) throw Error(`La lista de ${collection} no es válida.`);
    if (records.some((record: any) => !record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string' || !record.id)) {
      throw Error(`La lista de ${collection} contiene un registro sin ID válido.`);
    }
    backup[collection] = records;
  }
  return backup;
}

export interface BackupRestoreWriters {
  book: (book: Record<string, any>) => Promise<unknown>;
  note: (note: Record<string, any>) => Promise<unknown>;
  entry: (entry: Record<string, any>) => Promise<unknown>;
  quote: (quote: Record<string, any>) => Promise<unknown>;
  analysis: (analysis: Record<string, any>) => Promise<unknown>;
  character: (character: Record<string, any>) => Promise<unknown>;
  characterRelation: (relation: Record<string, any>) => Promise<unknown>;
  conversation: (conversation: Record<string, any>) => Promise<unknown>;
}

export interface RestoreOptions {
  /** IDs de libros que ya existen en este dispositivo (además de los de la copia). */
  existingBookIds?: ReadonlySet<string>;
  /** IDs de personajes que ya existen en este dispositivo, para aceptar relaciones hacia ellos. */
  existingCharacterIds?: ReadonlySet<string>;
}

export async function restoreBackupData(
  backup: BackupData,
  writers: BackupRestoreWriters,
  options: RestoreOptions = {},
): Promise<number> {
  let restored = 0;
  for (const book of backup.books) {
    await writers.book({
      ...book,
      tags: Array.isArray(book.tags) ? book.tags : [],
      rating: book.rating ?? null,
      review: book.review || '',
    });
    restored++;
  }
  for (const note of backup.notes) { await writers.note(note); restored++; }
  for (const entry of backup.entries) { await writers.entry(entry); restored++; }
  for (const quote of backup.quotes) { await writers.quote(quote); restored++; }
  for (const analysis of backup.analyses) { await writers.analysis(analysis); restored++; }
  // Personajes antes que relaciones; los IDs de relación se derivan de su clave lógica, así que restaurar
  // dos veces (o desde dos copias) actualiza en lugar de duplicar.
  const bookIds = new Set<string>();
  for (const id of [...backup.books.map((book) => String(book.id)), ...(options.existingBookIds ?? [])]) {
    bookIds.add(id);
    bookIds.add(safeId(id));
  }
  const prepared = prepareCharacterBackup(backup, { bookIds, existingCharacterIds: options.existingCharacterIds });
  for (const character of prepared.characters) { await writers.character(character); restored++; }
  for (const relation of prepared.relations) { await writers.characterRelation(relation); restored++; }
  for (const conversation of backup.conversations) {
    if (!conversation.bookId) continue;
    await writers.conversation(conversation);
    restored++;
  }
  return restored;
}


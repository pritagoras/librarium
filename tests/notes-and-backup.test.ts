import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseBackupJSON,
  restoreBackupData,
  validateNotesJSON,
} from '../src/app/data-transfer.ts';

test('imports notes with camelCase page fields and section resets', () => {
  const result = validateNotesJSON(JSON.stringify({
    book: { title: 'Lecturas' },
    notes: [
      { number: 1, referencePage: 12, endPage: 100, text: 'Primera sección' },
      { number: 2, text: 'Sigue la primera sección' },
      { number: 1, text: 'La numeración se reinició' },
    ],
  }));

  assert.deepEqual(result.notes.map((note: any) => note.section), [1, 1, 2]);
  assert.equal(result.notes[0].referencePage, 12);
  assert.equal(result.notes[0].endPage, 100);
});

test('rejects duplicate note numbers and invalid pages', () => {
  assert.throws(
    () => validateNotesJSON(JSON.stringify({ notes: [
      { number: 1, section: 1, text: 'Una' }, { number: 1, section: 1, text: 'Duplicada' },
    ] })),
    /aparece más de una vez/,
  );
  assert.throws(
    () => validateNotesJSON(JSON.stringify({ notes: [
      { number: 1, reference_page: -2, text: 'Página inválida' },
    ] })),
    /entero igual o mayor que cero/,
  );
});

test('parses current and older backups, defaulting collections absent from older files', () => {
  const backup = parseBackupJSON(JSON.stringify({
    books: [{ id: 'book-1', title: 'Libro' }],
    notes: [],
    entries: [],
  }));

  assert.deepEqual(backup.quotes, []);
  assert.deepEqual(backup.analyses, []);
  assert.deepEqual(backup.conversations, []);
});

test('preserves subannotations through backup parsing and restoration', async () => {
  const phrase = { id: 'sub-1', phrase: 'La idea central queda clara.', question: '¿Qué sostiene?', createdAt: '2026-11-27T10:00:00Z' };
  const backup = parseBackupJSON(JSON.stringify({ books: [], notes: [], entries: [{ id: 'entry-1', bookId: 'b', subannotations: [phrase] }] }));
  let restored: any;
  await restoreBackupData(backup, {
    book: async () => {}, note: async () => {}, entry: async (entry) => { restored = entry; },
    quote: async () => {}, analysis: async () => {}, character: async () => {}, characterRelation: async () => {}, conversation: async () => {},
  });
  assert.deepEqual(restored.subannotations, [phrase]);
});

test('rejects malformed backup collections before restoring any records', () => {
  assert.throws(() => parseBackupJSON('{'), SyntaxError);
  assert.throws(() => parseBackupJSON(JSON.stringify({ books: [], notes: [], entries: 'bad' })), /entries/);
  assert.throws(() => parseBackupJSON(JSON.stringify({ books: [{ title: 'Sin ID' }], notes: [], entries: [] })), /ID válido/);
});

test('restores records in dependency order, applies book defaults, and skips orphan conversations', async () => {
  const backup = parseBackupJSON(JSON.stringify({
    books: [{ id: 'book-1', title: 'Libro' }],
    notes: [{ id: 'note-1', bookId: 'book-1' }],
    entries: [{ id: 'entry-1', bookId: 'book-1' }],
    quotes: [{ id: 'quote-1', bookId: 'book-1' }],
    analyses: [{ id: 'analysis-1', bookId: 'book-1' }],
    conversations: [
      { id: 'conversation-1', bookId: 'book-1' },
      { id: 'orphan-conversation' },
    ],
  }));
  const calls: string[] = [];
  let restoredBook: any;
  const writers = Object.fromEntries(
    ['book', 'note', 'entry', 'quote', 'analysis', 'conversation'].map((kind) => [
      kind,
      async (record: any) => {
        calls.push(`${kind}:${record.id}`);
        if (kind === 'book') restoredBook = record;
      },
    ]),
  ) as any;

  const count = await restoreBackupData(backup, writers);
  assert.equal(count, 6);
  assert.deepEqual(calls, [
    'book:book-1', 'note:note-1', 'entry:entry-1', 'quote:quote-1',
    'analysis:analysis-1', 'conversation:conversation-1',
  ]);
  assert.deepEqual(restoredBook.tags, []);
  assert.equal(restoredBook.rating, null);
  assert.equal(restoredBook.review, '');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_SYSTEM_RULES,
  applyAnswerToCharacter,
  applyAnswerToRelation,
  buildCharacterAIRequest,
  buildEgoGraph,
  makeRelationId,
  neighborsOf,
  normalizeCharacter,
  prepareCharacterBackup,
  removeCharacterCascade,
  searchCharacters,
  validateCharacter,
  validateRelation,
} from '../src/app/characters-model.ts';
import { parseBackupJSON, restoreBackupData } from '../src/app/data-transfer.ts';
import type { Character, CharacterRelation } from '../src/types.ts';
import { parsePastedJSON } from '../src/app/characters.ts';

const BOOK = 'book-1';

test('manual Gemini reply parser accepts fenced JSON inside explanatory text', () => {
  const parsed = parsePastedJSON('Resultado:\n```json\n{"candidates":[{"name":"Pierre Bezújov"}]}\n```\nFin.');
  assert.equal(parsed.candidates[0].name, 'Pierre Bezújov');
});

test('manual Gemini reply parser rejects incomplete JSON with an actionable message', () => {
  assert.throws(() => parsePastedJSON('{"candidates": ['), /JSON de Gemini quedó incompleto/);
});

function character(id: string, name: string, extra: Partial<Character> = {}): Character {
  return {
    id, bookId: BOOK, name, aliases: [], age: '', description: '', traits: [], occupation: '',
    affiliation: '', comments: '', evidence: [], certainty: {}, ...extra,
  };
}

function relation(fromId: string, toId: string, type = 'Amistad', extra: Partial<CharacterRelation> = {}): CharacterRelation {
  return {
    id: makeRelationId(BOOK, type, fromId, toId), bookId: BOOK, fromId, toId, type,
    description: '', evidence: [], certainty: 'unknown', ...extra,
  };
}

// ---------------------------------------------------------------------------
// Validación de fichas
// ---------------------------------------------------------------------------

test('a character needs a name and does not invent values for empty fields', () => {
  const missing = validateCharacter({ name: '   ' }, { bookId: BOOK, existing: [] });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /nombre es obligatorio/);

  const result = validateCharacter({ name: ' Ana ' }, { bookId: BOOK, existing: [] });
  assert.equal(result.ok, true);
  const value = result.value!;
  assert.equal(value.name, 'Ana');
  assert.equal(value.age, '');
  assert.equal(value.occupation, '');
  assert.deepEqual(value.certainty, {});
  assert.match(value.id, /^char_[a-z0-9]+_[a-z0-9]+$/);
});

test('a filled field must say whether it is explicit or inferred; empty fields drop their certainty', () => {
  const noCertainty = validateCharacter({ name: 'Ana', age: '30' }, { bookId: BOOK, existing: [] });
  assert.equal(noCertainty.ok, false);
  assert.match(noCertainty.errors.join(' '), /explícito en el libro o inferido/);

  const unknownWithValue = validateCharacter(
    { name: 'Ana', age: '30', certainty: { age: 'unknown' } },
    { bookId: BOOK, existing: [] },
  );
  assert.equal(unknownWithValue.ok, false);

  const ok = validateCharacter(
    { name: 'Ana', age: '30', occupation: '', certainty: { age: 'inferred', occupation: 'explicit' } },
    { bookId: BOOK, existing: [] },
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value!.certainty, { age: 'inferred' });
});

test('rejects duplicate names in a book, warns about alias clashes, and dedupes aliases', () => {
  const existing = [character('c1', 'Ana María', { aliases: ['Anita'] })];
  const duplicate = validateCharacter({ name: 'ana maria' }, { bookId: BOOK, existing });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors[0], /Ya existe un personaje/);

  const editingSelf = validateCharacter({ id: 'c1', name: 'Ana María' }, { bookId: BOOK, existing, editingId: 'c1' });
  assert.equal(editingSelf.ok, true);

  const other = validateCharacter(
    { name: 'Luis', aliases: ['Anita', 'anita', ' Lu ', 'Luis', ''] },
    { bookId: BOOK, existing },
  );
  assert.equal(other.ok, true);
  assert.deepEqual(other.value!.aliases, ['Anita', 'Lu']);
  assert.match(other.warnings[0], /Anita/);

  // El mismo nombre en otro libro no choca.
  const otherBook = validateCharacter({ name: 'Ana María' }, { bookId: 'book-2', existing });
  assert.equal(otherBook.ok, true);
});

test('enforces length limits and normalizes evidence', () => {
  const tooLong = validateCharacter({ name: 'x'.repeat(201) }, { bookId: BOOK, existing: [] });
  assert.equal(tooLong.ok, false);

  const result = validateCharacter(
    {
      name: 'Ana',
      evidence: [
        { kind: 'page', ref: ' 12 ', text: '' },
        { kind: 'page', ref: '12', text: '' },
        { kind: 'quote', ref: '', text: '' },
        { kind: 'bogus' as any, ref: 'cap. 3', text: 'Texto' },
      ],
    },
    { bookId: BOOK, existing: [] },
  );
  assert.deepEqual(result.value!.evidence, [
    { kind: 'page', ref: '12', text: '' },
    { kind: 'other', ref: 'cap. 3', text: 'Texto' },
  ]);
});

test('normalizeCharacter is tolerant with stored data but never invents certainty', () => {
  const normalized = normalizeCharacter({
    id: 'a:b', bookId: BOOK, name: 'Ana', age: '30', certainty: { age: 'unknown', occupation: 'explicit' }, aliases: 'no-list',
  })!;
  assert.equal(normalized.id, 'a__b');
  assert.deepEqual(normalized.aliases, []);
  assert.deepEqual(normalized.certainty, {});
  assert.equal(normalizeCharacter({ id: 'x', name: '' }), null);
  assert.equal(normalizeCharacter({ name: 'Sin id', bookId: BOOK }), null);
});

// ---------------------------------------------------------------------------
// Relaciones
// ---------------------------------------------------------------------------

const people = [character('a', 'Ana'), character('b', 'Beto'), character('c', 'Carla'), character('z', 'Otro libro', { bookId: 'book-2' })];

test('creates a relation with a deterministic id and rejects duplicates in either direction', () => {
  const first = validateRelation(
    { fromId: 'a', toId: 'b', type: 'Amistad', certainty: 'explicit' },
    { bookId: BOOK, characters: people, relations: [] },
  );
  assert.equal(first.ok, true);
  assert.equal(first.value!.record.id, makeRelationId(BOOK, 'Amistad', 'a', 'b'));
  assert.equal(first.value!.record.id, makeRelationId(BOOK, ' amistad ', 'b', 'a'));

  const reverse = validateRelation(
    { fromId: 'b', toId: 'a', type: 'amistad' },
    { bookId: BOOK, characters: people, relations: [first.value!.record] },
  );
  assert.equal(reverse.ok, false);
  assert.match(reverse.errors[0], /Ya existe una relación/);

  const differentType = validateRelation(
    { fromId: 'a', toId: 'b', type: 'Rivalidad' },
    { bookId: BOOK, characters: people, relations: [first.value!.record] },
  );
  assert.equal(differentType.ok, true);
  assert.equal(differentType.value!.record.certainty, 'unknown');
});

test('directed types (mentoría) distinguish who is the mentor', () => {
  const ab = relation('a', 'b', 'Mentoría');
  const ba = validateRelation({ fromId: 'b', toId: 'a', type: 'Mentoría' }, { bookId: BOOK, characters: people, relations: [ab] });
  assert.equal(ba.ok, true);
  assert.notEqual(ba.value!.record.id, ab.id);
});

test('validates endpoints, self relations, type and certainty', () => {
  const ctx = { bookId: BOOK, characters: people, relations: [] };
  assert.match(validateRelation({ fromId: 'a', toId: 'a', type: 'Amistad' }, ctx).errors.join(' '), /consigo mismo/);
  assert.match(validateRelation({ fromId: 'a', toId: 'zzz', type: 'Amistad' }, ctx).errors.join(' '), /otro personaje/);
  assert.match(validateRelation({ fromId: 'a', toId: 'z', type: 'Amistad' }, ctx).errors.join(' '), /otro personaje/);
  assert.match(validateRelation({ fromId: 'a', toId: 'b', type: ' ' }, ctx).errors.join(' '), /tipo de vínculo/);
  assert.equal(validateRelation({ fromId: 'a', toId: 'b', type: 'X', certainty: 'seguro' as any }, ctx).ok, false);
});

test('editing a relation keeps it unique and reports the old id when the key changes', () => {
  const original = relation('a', 'b', 'Amistad', { createdAt: '2026-01-01T00:00:00Z', description: 'vieja' });
  const other = relation('a', 'c', 'Rivalidad');
  const ctx = { bookId: BOOK, characters: people, relations: [original, other], editing: original };

  const sameKey = validateRelation({ fromId: 'a', toId: 'b', type: 'Amistad', description: 'nueva' }, ctx);
  assert.equal(sameKey.ok, true);
  assert.equal(sameKey.value!.replacesId, undefined);
  assert.equal(sameKey.value!.record.createdAt, '2026-01-01T00:00:00Z');

  const renamed = validateRelation({ fromId: 'a', toId: 'b', type: 'Alianza' }, ctx);
  assert.equal(renamed.ok, true);
  assert.equal(renamed.value!.replacesId, original.id);

  const collision = validateRelation({ fromId: 'a', toId: 'c', type: 'Rivalidad' }, ctx);
  assert.equal(collision.ok, false);
});

test('removing a character removes its relations and leaves the rest', () => {
  const chars = [character('a', 'Ana'), character('b', 'Beto'), character('c', 'Carla')];
  const rels = [relation('a', 'b'), relation('b', 'c'), relation('a', 'c', 'Rivalidad')];
  const result = removeCharacterCascade(chars, rels, 'a');
  assert.deepEqual(result.characters.map((c) => c.id), ['b', 'c']);
  assert.deepEqual(result.relations.map((r) => r.id), [rels[1].id]);
  assert.deepEqual(result.removedRelationIds.sort(), [rels[0].id, rels[2].id].sort());
  assert.equal(neighborsOf(rels, 'a').length, 2);
});

test('search ignores accents and case and looks at aliases, traits and occupation', () => {
  const chars = [
    character('a', 'Álvaro', { aliases: ['El Zorro'], occupation: 'Médico' }),
    character('b', 'Beto', { traits: ['Tímido'] }),
  ];
  assert.deepEqual(searchCharacters(chars, 'alvaro').map((c) => c.id), ['a']);
  assert.deepEqual(searchCharacters(chars, 'zorro').map((c) => c.id), ['a']);
  assert.deepEqual(searchCharacters(chars, 'medico').map((c) => c.id), ['a']);
  assert.deepEqual(searchCharacters(chars, 'timido').map((c) => c.id), ['b']);
  assert.deepEqual(searchCharacters(chars, '').map((c) => c.id), ['a', 'b']);
  assert.deepEqual(searchCharacters(chars, 'nadie'), []);
});

test('the relation network expands by parts and caps neighbors per node', () => {
  const chars = [character('hub', 'Hub'), ...Array.from({ length: 25 }, (_, i) => character(`n${i}`, `Nodo ${String(i).padStart(2, '0')}`)), character('far', 'Lejano')];
  const rels = [...chars.slice(1, 26).map((c) => relation('hub', c.id)), relation('n0', 'far')];

  const initial = buildEgoGraph(chars, rels, 'hub', new Set(), 10);
  assert.equal(initial.nodes.length, 11);
  assert.equal(initial.omittedAtFocus, 15);
  assert.equal(initial.nodes.find((n) => n.id === 'hub')!.hiddenNeighbors, 15);
  assert.ok(!initial.nodes.some((n) => n.id === 'far'));

  const visibleSecond = initial.nodes.find((n) => n.depth === 1)!;
  assert.equal(visibleSecond.depth, 1);

  const expanded = buildEgoGraph(chars, rels, 'hub', new Set(['n0']), 10);
  assert.ok(expanded.nodes.some((n) => n.id === 'far' && n.depth === 2));
  assert.equal(buildEgoGraph(chars, rels, 'missing').nodes.length, 0);
});

test('network adds edges between visible nodes without adding new nodes', () => {
  const chars = [character('a', 'Ana'), character('b', 'Beto'), character('c', 'Carla')];
  const rels = [relation('a', 'b'), relation('a', 'c'), relation('b', 'c', 'Alianza')];
  const graph = buildEgoGraph(chars, rels, 'a');
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 3);
});

// ---------------------------------------------------------------------------
// Respaldo y restauración
// ---------------------------------------------------------------------------

test('older backups without characters still parse and restore', async () => {
  const backup = parseBackupJSON(JSON.stringify({ books: [{ id: BOOK, title: 'Libro' }], notes: [], entries: [] }));
  assert.deepEqual(backup.characters, []);
  assert.deepEqual(backup.characterRelations, []);
  const count = await restoreBackupData(backup, memoryWriters(new Map()).writers);
  assert.equal(count, 1);
});

test('rejects character records without an id before restoring anything', () => {
  assert.throws(
    () => parseBackupJSON(JSON.stringify({ books: [], notes: [], entries: [], characters: [{ name: 'Sin ID' }] })),
    /ID válido/,
  );
});

function memoryWriters(store: Map<string, any>, order: string[] = []) {
  const kinds = ['book', 'note', 'entry', 'quote', 'analysis', 'character', 'characterRelation', 'conversation'];
  const writers = Object.fromEntries(
    kinds.map((kind) => [kind, async (record: any) => { store.set(`${kind}:${record.id}`, record); order.push(kind); }]),
  ) as any;
  return { writers, order };
}

const backupJson = JSON.stringify({
  books: [{ id: BOOK, title: 'Libro' }],
  notes: [], entries: [],
  characters: [
    { id: 'a', bookId: BOOK, name: 'Ana', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'a', bookId: BOOK, name: 'Ana (nueva)', updatedAt: '2026-02-01T00:00:00Z' },
    { id: 'b', bookId: BOOK, name: 'Beto' },
    { id: 'lost', bookId: 'missing-book', name: 'Huérfano' },
  ],
  characterRelations: [
    { id: 'old-random-id-1', bookId: BOOK, fromId: 'a', toId: 'b', type: 'Amistad', updatedAt: '2026-01-01T00:00:00Z', description: 'vieja' },
    { id: 'old-random-id-2', bookId: BOOK, fromId: 'b', toId: 'a', type: ' amistad', updatedAt: '2026-03-01T00:00:00Z', description: 'nueva' },
    { id: 'r3', bookId: BOOK, fromId: 'a', toId: 'ghost', type: 'Amistad' },
    { id: 'r4', bookId: BOOK, fromId: 'a', toId: 'a', type: 'Amistad' },
    { id: 'r5', bookId: BOOK, fromId: 'a', toId: 'lost', type: 'Amistad' },
  ],
  conversations: [],
});

test('restore writes characters before relations, collapses duplicate relations and skips broken references', async () => {
  const store = new Map<string, any>();
  const { writers, order } = memoryWriters(store);
  const count = await restoreBackupData(parseBackupJSON(backupJson), writers);

  assert.deepEqual(order, ['book', 'character', 'character', 'characterRelation']);
  assert.equal(count, 4);
  const relationId = makeRelationId(BOOK, 'Amistad', 'a', 'b');
  assert.equal(store.get(`characterRelation:${relationId}`).description, 'nueva');
  assert.equal(store.get('character:a').name, 'Ana (nueva)');
  assert.equal(store.has('character:lost'), false);
});

test('restoring the same backup twice does not duplicate characters or relations', async () => {
  const store = new Map<string, any>();
  const { writers } = memoryWriters(store);
  await restoreBackupData(parseBackupJSON(backupJson), writers);
  const firstKeys = [...store.keys()].sort();
  await restoreBackupData(parseBackupJSON(backupJson), writers);
  assert.deepEqual([...store.keys()].sort(), firstKeys);
  assert.equal([...store.keys()].filter((key) => key.startsWith('characterRelation:')).length, 1);
});

test('relations may point to characters that already exist on the device, but only for known books', async () => {
  const raw = {
    characters: [],
    characterRelations: [{ id: 'x', bookId: BOOK, fromId: 'local-1', toId: 'local-2', type: 'Familiar' }],
  };
  const withLocal = prepareCharacterBackup(raw, { bookIds: new Set([BOOK]), existingCharacterIds: new Set(['local-1', 'local-2']) });
  assert.equal(withLocal.relations.length, 1);
  const withoutLocal = prepareCharacterBackup(raw, { bookIds: new Set([BOOK]) });
  assert.equal(withoutLocal.relations.length, 0);
  assert.equal(withoutLocal.skipped.relations, 1);
  const unknownBook = prepareCharacterBackup(raw, { bookIds: new Set(['other']), existingCharacterIds: new Set(['local-1', 'local-2']) });
  assert.equal(unknownBook.relations.length, 0);
});

test('a backup relation across two books is dropped', () => {
  const result = prepareCharacterBackup(
    {
      characters: [
        { id: 'a', bookId: BOOK, name: 'Ana' },
        { id: 'z', bookId: 'book-2', name: 'Zeta' },
      ],
      characterRelations: [{ id: 'r', bookId: BOOK, fromId: 'a', toId: 'z', type: 'Amistad' }],
    },
    { bookIds: new Set([BOOK, 'book-2']) },
  );
  assert.equal(result.relations.length, 0);
});

// ---------------------------------------------------------------------------
// Contexto para la IA
// ---------------------------------------------------------------------------

const book = { id: BOOK, title: 'La casa grande', author: 'A. Autora', publisher: 'Editorial X', year: '1999', edition: '', currentPage: 100 };
const notes: any[] = [
  { id: 'n1', bookId: BOOK, number: 3, section: 1, referencePage: null, endPage: 40, text: 'Ana abre la puerta del almacén.', read: false },
  { id: 'n2', bookId: BOOK, number: 4, section: 1, referencePage: null, endPage: 41, text: 'Una nota sobre otra cosa.', read: false },
];
const quotes: any[] = [
  { id: 'q1', bookId: BOOK, text: '“Beto era el único que sabía callar”', page: 77, createdAt: '', updatedAt: '', photos: [] },
  { id: 'q2', bookId: BOOK, text: 'Texto sin personajes', page: 80, createdAt: '', updatedAt: '', photos: [] },
];
const entries: any[] = [{ id: 'e1', bookId: BOOK, page: 12, text: 'Anita llega tarde', comment: 'raro', createdAt: '' }];

test('the AI request includes the book, the sheet, links and only the notes that mention the character', () => {
  const ana = character('a', 'Ana', { aliases: ['Anita'], age: '30', certainty: { age: 'inferred' }, occupation: '' });
  const beto = character('b', 'Beto');
  const rels = [relation('a', 'b', 'Amistad', { certainty: 'explicit', description: 'Se conocen de chicos' })];
  const plan = buildCharacterAIRequest({
    book, character: ana, characters: [ana, beto], relations: rels, scope: { kind: 'character' }, notes, entries, quotes,
  });

  assert.match(plan.prompt, /La casa grande/);
  assert.match(plan.prompt, /A\. Autora/);
  assert.match(plan.prompt, /Nombre: Ana/);
  assert.match(plan.prompt, /Edad: 30 \[Inferido\]/);
  assert.match(plan.prompt, /Ocupación: \(sin dato\)/);
  assert.match(plan.prompt, /Amistad con Beto \[Explícito en el libro\]: Se conocen de chicos/);
  assert.match(plan.prompt, /\[N1\] Nota 3 \(p\. 40\)/);
  assert.match(plan.prompt, /\[E1\] Anotación \(p\. 12\)/);
  assert.doesNotMatch(plan.prompt, /otra cosa/);
  assert.doesNotMatch(plan.prompt, /sin personajes/);
  assert.doesNotMatch(plan.prompt, /Beto era el único/);
  assert.deepEqual(plan.sourceCount, { notes: 1, entries: 1, quotes: 0 });
  assert.match(plan.contextSummary, /El texto completo del libro no se envía/);
});

test('a field query asks only about that field and a relation query includes both sheets and their quotes', () => {
  const ana = character('a', 'Ana');
  const beto = character('b', 'Beto', { affiliation: 'La banda' , certainty: { affiliation: 'explicit' } });
  const field = buildCharacterAIRequest({
    book, character: ana, characters: [ana, beto], relations: [], scope: { kind: 'field', field: 'age' }, notes, quotes,
  });
  assert.match(field.prompt, /DATO QUE SE INVESTIGA: Edad/);
  assert.match(field.prompt, /PERSONAJE: Ana/);
  assert.match(field.systemInstruction, /exclusivamente tu conocimiento general aprendido/);
  assert.doesNotMatch(field.prompt, /Consulta puntual sobre/);
  assert.match(field.prompt, /No consultes ni cites las notas, anotaciones, citas, fuentes o documentos del usuario/);

  const pair = buildCharacterAIRequest({
    book, character: ana, characters: [ana, beto], relations: [], scope: { kind: 'relation', otherId: 'b' }, notes, quotes,
  });
  assert.match(pair.prompt, /FICHA DE «Beto»/);
  assert.match(pair.prompt, /Grupo o pertenencia: La banda \[Explícito en el libro\]/);
  assert.match(pair.prompt, /VÍNCULOS YA REGISTRADOS ENTRE AMBOS: ninguno/);
  assert.match(pair.prompt, /Beto era el único/);
  assert.match(pair.prompt, /Ana abre la puerta/);
  assert.throws(
    () => buildCharacterAIRequest({ book, character: ana, characters: [ana], relations: [], scope: { kind: 'relation', otherId: 'nope' } }),
    /otro personaje/,
  );
});

test('with no saved material the prompt says there is no text and the rules forbid inventing', () => {
  const ana = character('a', 'Ana');
  const plan = buildCharacterAIRequest({ book, character: ana, characters: [ana], relations: [], scope: { kind: 'character' } });
  assert.match(plan.prompt, /no hay notas, anotaciones ni citas/);
  assert.match(plan.prompt, /No tenés texto del libro/);
  for (const rule of [/NO tenés el texto completo/, /Nunca afirmes haber leído/, /Datos explícitos/, /Inferencias/, /Sin información suficiente/, /No inventes edades, parentescos, escenas/]) {
    assert.match(AI_SYSTEM_RULES, rule);
  }
  assert.equal(plan.systemInstruction, AI_SYSTEM_RULES);

  const styled = buildCharacterAIRequest({ book, character: ana, characters: [ana], relations: [], scope: { kind: 'character' }, styleInstruction: 'Sé breve.' });
  assert.match(styled.systemInstruction, /no anulan ninguna regla anterior\): Sé breve\./);
});

test('short or ambiguous names do not pull unrelated material and the context is bounded', () => {
  const al = character('a', 'Al');
  const many: any[] = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, bookId: BOOK, number: i, section: 1, referencePage: null, endPage: i, text: `Alberto número ${i} ${'x'.repeat(2000)}`, read: false }));
  const none = buildCharacterAIRequest({ book, character: al, characters: [al], relations: [], scope: { kind: 'character' }, notes: many });
  assert.equal(none.sourceCount.notes, 0);

  const albert = character('b', 'Alberto');
  const bounded = buildCharacterAIRequest({ book, character: albert, characters: [albert], relations: [], scope: { kind: 'character' }, notes: many });
  assert.equal(bounded.sourceCount.notes, 12);
  assert.ok(bounded.prompt.length < 20000);
});

// ---------------------------------------------------------------------------
// Guardar respuestas de la IA
// ---------------------------------------------------------------------------

test('saving an AI answer as a field requires an explicit certainty and respects limits', () => {
  const ana = character('a', 'Ana');
  assert.throws(() => applyAnswerToCharacter(ana, { target: 'field', field: 'age', text: '30' }), /explícito en el libro o inferido/);
  assert.throws(() => applyAnswerToCharacter(ana, { target: 'field', field: 'age', text: '30', certainty: 'unknown' }), /explícito en el libro o inferido/);
  assert.throws(() => applyAnswerToCharacter(ana, { target: 'field', field: 'age', text: 'x'.repeat(61), certainty: 'inferred' }), /máximo de 60/);
  assert.throws(() => applyAnswerToCharacter(ana, { target: 'field', text: 'x', certainty: 'inferred' }), /no se puede completar/);
  assert.throws(() => applyAnswerToCharacter(ana, { target: 'comments', text: '  ' }), /No hay texto/);

  const saved = applyAnswerToCharacter(ana, { target: 'field', field: 'age', text: ' Unos 30 ', certainty: 'inferred' });
  assert.equal(saved.age, 'Unos 30');
  assert.deepEqual(saved.certainty, { age: 'inferred' });
  assert.equal(ana.age, '');
});

test('saving an AI answer as a comment or evidence keeps what was already there', () => {
  const ana = character('a', 'Ana', { comments: 'Mi nota', evidence: [{ kind: 'page', ref: '12', text: '' }] });
  const withComment = applyAnswerToCharacter(ana, { target: 'comments', text: 'Respuesta', date: '2026-11-24T10:00:00Z' });
  assert.equal(withComment.comments, 'Mi nota\n\n[IA · 2026-11-24] Respuesta');

  const withEvidence = applyAnswerToCharacter(ana, { target: 'evidence', text: 'Respuesta', date: '2026-11-24T10:00:00Z' });
  assert.equal(withEvidence.evidence.length, 2);
  assert.deepEqual(withEvidence.evidence[1], { kind: 'other', ref: 'Consulta a la IA · 2026-11-24', text: 'Respuesta' });

  const full = character('a', 'Ana', { comments: 'x'.repeat(4990) });
  assert.throws(() => applyAnswerToCharacter(full, { target: 'comments', text: 'y'.repeat(50) }), /superarían el máximo/);
});

test('saving an AI answer on a relation updates its description, comment or evidence', () => {
  const rel = relation('a', 'b', 'Amistad', { description: 'Previa' });
  assert.equal(applyAnswerToRelation(rel, { target: 'field', text: 'Nueva', certainty: 'explicit' }).certainty, 'explicit');
  assert.throws(() => applyAnswerToRelation(rel, { target: 'field', text: 'Nueva' }), /explícito en el libro o inferido/);
  assert.match(applyAnswerToRelation(rel, { target: 'comments', text: 'Más', date: '2026-11-24' }).description, /^Previa\n\n\[IA · 2026-11-24\] Más$/);
  assert.equal(applyAnswerToRelation(rel, { target: 'evidence', text: 'Más' }).evidence.length, 1);
});

test('a field query asks for a concise context and a concrete editable value without certainty labels', () => {
  const ana = character('a', 'Ana');
  const age = buildCharacterAIRequest({ book, character: ana, characters: [ana], relations: [], scope: { kind: 'field', field: 'age' } });
  assert.match(age.systemInstruction, /CONTEXTO_BREVE:/);
  assert.match(age.systemInstruction, /VALOR_SUGERIDO:/);
  assert.doesNotMatch(age.systemInstruction, /CERTEZA_SUGERIDA:/);
  assert.match(age.systemInstruction, /No escribas explicaciones dentro del valor/);
  assert.match(age.systemInstruction, /exclusivamente tu conocimiento general aprendido/);
  assert.match(age.prompt, /No consultes ni cites las notas, anotaciones, citas, fuentes o documentos del usuario/);
});

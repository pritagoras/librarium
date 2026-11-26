import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDocs, searchTerms, type SearchDoc } from '../src/app/search-model';

const doc = (id: string, title: string, ...fields: string[]): SearchDoc =>
  ({ kind: 'note', id, bookId: 'b', bookTitle: 'Guerra y paz', title, fields });

test('ignora tildes y mayúsculas y resalta el texto original', () => {
  const [hit] = searchDocs([doc('1', 'Nota 1', 'La batalla de Borodinó fue decisiva.')], 'borodino');
  assert.deepEqual(hit.snippet.find((p) => p.mark), { text: 'Borodinó', mark: true });
  assert.equal(hit.snippet.map((p) => p.text).join(''), 'La batalla de Borodinó fue decisiva.');
});

test('exige todas las palabras, aunque estén en campos distintos', () => {
  const docs = [doc('1', 'Pierre', 'conde', 'masón'), doc('2', 'Andréi', 'príncipe')];
  assert.deepEqual(searchDocs(docs, 'mason conde').map((h) => h.doc.id), ['1']);
  assert.equal(searchDocs(docs, 'conde principe').length, 0);
});

test('prioriza el título y descarta consultas de una sola letra', () => {
  const docs = [doc('1', 'Nota', 'habla de Natasha'), doc('2', 'Natasha', 'Rostova')];
  assert.deepEqual(searchDocs(docs, 'natasha').map((h) => h.doc.id), ['2', '1']);
  assert.equal(searchDocs(docs, 'n').length, 0);
  assert.deepEqual(searchTerms('  Paz   paz '), ['paz']);
});

test('recorta los textos largos alrededor de la coincidencia', () => {
  const [hit] = searchDocs([doc('1', 'Nota', `${'a '.repeat(200)}Kutúzov ${'b '.repeat(200)}`)], 'kutuzov');
  const text = hit.snippet.map((p) => p.text).join('');
  assert.ok(text.startsWith('…') && text.endsWith('…') && text.includes('Kutúzov'));
  assert.ok(text.length <= 152);
});

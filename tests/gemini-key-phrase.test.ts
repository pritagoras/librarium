import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractKeyPhrase, mergeSubannotations, visibleStreamingAnswer } from '../src/app/gemini-key-phrase.ts';

test('extracts marker split between stream chunks without rendering it', () => {
  const chunks = ['Respuesta suficiente. [[FRASE_', 'CLAVE]] **La respuesta es suficiente.**'];
  assert.equal(visibleStreamingAnswer(chunks[0]), 'Respuesta suficiente.');
  assert.deepEqual(extractKeyPhrase(chunks.join('')), { answer: 'Respuesta suficiente.', phrase: 'La respuesta es suficiente.' });
});

test('rejects absent and overlong key phrases', () => {
  assert.equal(extractKeyPhrase('Respuesta común').phrase, null);
  assert.equal(extractKeyPhrase(`Body [[FRASE_CLAVE]] ${Array(26).fill('word').join(' ')}`).phrase, null);
});

test('merges subannotations by ID without duplicates', () => {
  assert.deepEqual(mergeSubannotations([{ id: 'a', phrase: 'x' }], [{ id: 'a', phrase: 'x' }, { id: 'b', phrase: 'y' }]), [
    { id: 'a', phrase: 'x' }, { id: 'b', phrase: 'y' },
  ]);
});

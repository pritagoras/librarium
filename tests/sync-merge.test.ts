import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeConflictId, reconcileRecords, recordsHaveSameContent } from '../src/sync-merge.ts';

test('accepts a remote record when no local copy exists', () => {
  const remote = { id: 'book-1', title: 'Libro', updatedAt: '2026-11-24T12:00:00Z' };
  assert.deepEqual(reconcileRecords(undefined, remote), { kind: 'accept-remote', record: remote });
});

test('keeps subannotations added independently on two devices', () => {
  const decision = reconcileRecords(
    { id: 'entry', subannotations: [{ id: 'local', phrase: 'Local' }], updatedAt: '2026-11-26' },
    { id: 'entry', subannotations: [{ id: 'remote', phrase: 'Remota' }], updatedAt: '2026-11-27' },
  );
  assert.equal(decision.kind, 'accept-remote');
  if (decision.kind === 'accept-remote') assert.deepEqual((decision.record as any).subannotations.map((item: any) => item.id), ['local', 'remote']);
});

test('treats timestamp-only differences as the same content', () => {
  assert.equal(recordsHaveSameContent(
    { id: 'book-1', title: 'Libro', userId: 'u1', createdAt: 'a', updatedAt: 'b' },
    { updatedAt: 'c', createdAt: 'd', title: 'Libro', id: 'book-1', userId: 'u1' },
  ), true);
});

test('detects image-only edits without serializing image data into the comparison payload', () => {
  assert.equal(recordsHaveSameContent(
    { id: 'entry-1', text: 'Igual', photo: 'data:image/jpeg;base64,AAA' },
    { id: 'entry-1', text: 'Igual', photo: 'data:image/jpeg;base64,BBB' },
  ), false);
});

test('reports divergent versions and prefers the newer edit without dropping either copy', () => {
  const local = { id: 'note-1', text: 'Edición local', updatedAt: '2026-11-24T12:02:00Z' };
  const remote = { id: 'note-1', text: 'Edición remota', updatedAt: '2026-11-24T12:01:00Z' };
  const decision = reconcileRecords(local, remote);

  assert.equal(decision.kind, 'conflict');
  if (decision.kind === 'conflict') {
    assert.equal(decision.winner, 'local');
    assert.equal(decision.local.text, 'Edición local');
    assert.equal(decision.remote.text, 'Edición remota');
  }
});

test('uses the remote copy for equal timestamps and creates stable conflict keys', () => {
  const local = { id: 'quote-1', text: 'Local', updatedAt: '2026-11-24T12:00:00Z' };
  const remote = { id: 'quote-1', text: 'Remota', updatedAt: '2026-11-24T12:00:00Z' };
  const decision = reconcileRecords(local, remote);
  assert.equal(decision.kind, 'conflict');
  if (decision.kind === 'conflict') assert.equal(decision.winner, 'remote');

  assert.equal(
    makeConflictId('quotes', 'quote-1', 'local-time', 'remote-time'),
    'quotes:quote-1:local-time:remote-time',
  );
});

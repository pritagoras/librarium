import assert from 'node:assert/strict';
import test from 'node:test';
import { computeLayout, growthOrder } from '../src/app/network-layout';
import { GifEncoder, buildPalette } from '../src/app/gif-encoder';
import { readGrowth } from '../src/app/network-growth';

const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
const edges = [1, 2, 3, 4, 5].map((i) => ({ fromId: 'c0', toId: `c${i}` })).concat({ fromId: 'c5', toId: 'c6' });

test('la distribución es determinista, queda dentro de la caja y no encima nodos', () => {
  const box = { width: 1000, height: 700, padding: 80, minDistance: 110 };
  const layout = computeLayout(ids, edges, box);
  assert.deepEqual(layout, computeLayout(ids, edges, box));
  const points = [...layout.values()];
  assert.equal(points.length, ids.length);
  for (const p of points) assert.ok(p.x >= 80 && p.x <= 920 && p.y >= 80 && p.y <= 620);
  points.forEach((a, i) => points.slice(i + 1).forEach((b) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 108)));
  assert.equal(computeLayout([], [], box).size, 0);
});

test('la red crece desde el más conectado y cada nodo sale de uno ya visible', () => {
  const order = growthOrder(ids, edges);
  assert.equal(order[0].id, 'c0');
  assert.equal(new Set(order.map((s) => s.id)).size, ids.length);
  const seen = new Set<string>();
  for (const step of order) {
    if (step.parentId) assert.ok(seen.has(step.parentId));
    seen.add(step.id);
  }
});

test('el GIF tiene cabecera, repetición y cierre', () => {
  const frame = new Uint8ClampedArray(8 * 8 * 4).fill(200);
  const gif = new GifEncoder(8, 8, buildPalette([frame]));
  gif.addFrame(frame, 100);
  gif.addFrame(frame, 100);
  const bytes = gif.finish();
  assert.equal(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
  assert.ok(Buffer.from(bytes).includes('NETSCAPE2.0'));
  assert.equal(bytes[bytes.length - 1], 0x3b);
});

test('el crecimiento de la red no repite personajes ni vínculos y descarta los sueltos', () => {
  const base = { bookId: 'b', aliases: [] as string[], age: '', description: '', traits: [], occupation: '', affiliation: '', comments: '', evidence: [], certainty: {} };
  const characters = [{ ...base, id: 'p', name: 'Pierre', aliases: ['Piotr'] }, { ...base, id: 'a', name: 'Andrei' }];
  const relations = [{ id: 'r', bookId: 'b', fromId: 'p', toId: 'a', type: 'Amistad', description: '', certainty: 'explicit' as const, evidence: [] }];
  const result = readGrowth({
    characters: [{ name: 'Piotr' }, { name: 'María', occupation: ' Noble ', age: 20 }, { name: 'Suelto' }, { name: 'maria' }],
    relations: [{ from: 'Andrei', to: 'Pierre', type: 'amistad' }, { from: 'maria', to: 'Andrei', type: 'Hermano/a de' }, { from: 'María', to: 'Nadie', type: 'Amistad' }],
  }, characters, relations);
  assert.deepEqual(result.characters.map((c) => c.name), ['María']);
  assert.equal(result.characters[0].occupation, 'Noble');
  assert.equal(result.characters[0].age, '');
  assert.deepEqual(result.relations, [{ from: 'María', to: 'Andrei', type: 'Hermano/a de', certainty: 'inferred' }]);
});

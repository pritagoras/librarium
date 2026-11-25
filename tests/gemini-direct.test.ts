import test from 'node:test';
import assert from 'node:assert/strict';
import { directGeminiRequest } from '../src/gemini-direct';

const ok = (text: string, withSources = false) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text }] }, ...(withSources ? { groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.org/a', title: 'A' } }] } } : {}) }],
}), { status: 200 });

test('json-task usa la búsqueda de Google y devuelve las fuentes', async () => {
  const realFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: any, init: any) => { body = JSON.parse(init.body); return ok('{"a":1}', true); }) as any;
  try {
    const res = await directGeminiRequest('json-task', { prompt: 'hola', grounding: true }, 'k');
    const json: any = await res.json();
    assert.deepEqual(body.tools, [{ googleSearch: {} }]);
    assert.equal(json.groundingUsed, true);
    assert.equal(json.sources[0].url, 'https://example.org/a');
  } finally { globalThis.fetch = realFetch; }
});

test('json-task reintenta sin búsqueda si la clave no la permite', async () => {
  const realFetch = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body); calls.push(body);
    return body.tools ? new Response(JSON.stringify({ error: { message: 'grounding no disponible' } }), { status: 400 }) : ok('{"a":1}');
  }) as any;
  try {
    const res = await directGeminiRequest('json-task', { prompt: 'hola', grounding: true }, 'k');
    const json: any = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.groundingUsed, false);
    assert.equal(calls.at(-1).generationConfig.responseMimeType, 'application/json');
  } finally { globalThis.fetch = realFetch; }
});

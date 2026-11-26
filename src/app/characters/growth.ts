/** Personajes · «Hacer crecer con IA». */
import { isDirectedType, normalizeText, validateRelation } from '../characters-model';
import { growthPrompt, readGrowth } from '../network-growth';
import { openNetworkShare } from '../network-share';
import { parsePastedJSON, promptBookContext } from './character-search';
import { api, book, data, esc, host, state } from './context';
import { autoAbort, autoNote, autoRunningHTML, beginAuto, runJSONTask, setAutoAbort, setAutoNote } from './gemini';
import { paint, reload } from './render';

export function growthHTML(): string {
  const { status, error, result } = state.growth;
  if (status === 'running') return autoRunningHTML('Buscando quiénes rodean a tus personajes…');
  if (status === 'saving') return '<section class="chr-research" role="status"><h3>Agregando a la red…</h3></section>';
  if (status === 'idle') return error ? `<p class="chr-ai-error" role="alert">${esc(error)}</p>` : '';
  const chosen = result!;
  return `<section class="chr-research chr-growth"><h3>Esto encontró la IA</h3><p class="muted">Pensado hasta la página ${Math.max(0, Number(book?.currentPage) || 0)}, pero la IA puede equivocarse con la página o con los hechos. Destildá lo que no quieras.</p>
    <div class="chr-growth-list">${chosen.characters.map((c, i) => `<label><input type="checkbox" data-growth-character="${i}" checked/> <span>${esc(c.name)}</span></label>`).join('') || '<p class="muted">Sin personajes nuevos, solo vínculos.</p>'}</div>
    <details><summary>${chosen.relations.length} vínculo${chosen.relations.length === 1 ? '' : 's'} (puede haber spoilers)</summary><ul>${chosen.relations.map((r) => `<li>${esc(r.from)} ${isDirectedType(r.type) ? '→' : '↔'} ${esc(r.to)} · ${esc(r.type)}</li>`).join('')}</ul></details>
    ${error ? `<p class="chr-ai-error" role="alert">${esc(error)}</p>` : ''}
    <div class="chr-row-actions"><button type="button" class="primary" data-chr="apply-growth">Agregar y ver cómo se forma</button><button type="button" class="secondary" data-chr="cancel-growth">Descartar</button></div></section>`;
}

export async function startGrowth() {
  const page = Math.max(0, Number(book?.currentPage) || 0);
  const fail = (error: string) => { state.growth = { status: 'idle', error, result: null }; paint(); };
  if (!api().ai.hasKey()) { fail('Primero guardá tu clave de Gemini en Ajustes de IA.'); return api().ai.openSettings(); }
  if (!page) return fail('Primero registrá en qué página vas: así la IA no se adelanta.');
  const notes = [
    ...data.notes.filter((n) => n.endPage != null && n.endPage <= page).map((n) => `[p. ${n.endPage}] ${String(n.text || '').slice(0, 500)}`),
    ...data.entries.filter((e) => e.page != null && e.page <= page).map((e) => `[p. ${e.page}] ${String(e.text || '').slice(0, 500)}`),
    ...data.quotes.filter((q) => q.page != null && q.page <= page).map((q) => `[p. ${q.page}] ${String(q.text || '').slice(0, 500)}`),
  ].slice(-60);
  const bookId = state.bookId;
  const controller = beginAuto();
  setAutoNote(`Hasta la página ${page}.`);
  state.growth = { status: 'running', error: '', result: null };
  paint();
  try {
    const response = await runJSONTask(growthPrompt({ bookContext: promptBookContext(), page, totalPages: Number(book?.totalPages) || 0, characters: data.characters, relations: data.relations, notes }), controller.signal);
    if (controller.signal.aborted || state.bookId !== bookId) return;
    const result = readGrowth(parsePastedJSON(response.text), data.characters, data.relations);
    if (!result.relations.length) return fail('La IA no encontró nada nuevo hasta esta página.');
    state.growth = { status: 'review', error: '', result };
    paint();
  } catch (err: any) {
    if (!controller.signal.aborted && state.bookId === bookId) fail(String(err?.message || err));
  } finally {
    if (autoAbort === controller) setAutoAbort(null);
  }
}

export async function applyGrowth() {
  const result = state.growth.result;
  if (!result || state.growth.status !== 'review') return;
  const chosen = result.characters.filter((_c, i) => host?.querySelector<HTMLInputElement>(`[data-growth-character="${i}"]`)?.checked);
  const bookId = state.bookId;
  state.growth = { status: 'saving', error: '', result };
  paint();
  let failed = '';
  try {
    const characters = [...data.characters];
    const relations = [...data.relations];
    const now = new Date().toISOString();
    const find = (name: string) => characters.find((c) => [c.name, ...c.aliases].some((value) => normalizeText(value) === normalizeText(name)));
    for (const item of chosen) {
      if (find(item.name)) continue;
      characters.push(await api().saveCharacter({ id: crypto.randomUUID(), bookId, name: item.name, aliases: item.aliases, age: item.age, description: item.description, traits: [], occupation: item.occupation, affiliation: '', comments: 'Sugerido por la IA; revisar.', evidence: [], certainty: Object.fromEntries((['age', 'description', 'occupation'] as const).filter((key) => item[key]).map((key) => [key, 'inferred'])), createdAt: now, updatedAt: now }));
    }
    for (const item of result.relations) {
      const from = find(item.from), to = find(item.to);
      if (!from || !to) continue;
      const checked = validateRelation({ fromId: from.id, toId: to.id, type: item.type, description: '', certainty: item.certainty }, { bookId, characters, relations });
      if (checked.value) relations.push(await api().saveRelation(checked.value.record));
    }
  } catch (err: any) {
    failed = `No se pudo guardar todo: ${String(err?.message || err)}`;
  }
  if (state.bookId !== bookId) return;
  state.growth = { status: 'idle', error: failed, result: null };
  await reload();
  state.netFocus = null;
  state.netReveal = true;
  paint();
  if (!failed) openNetworkShare({ bookTitle: book?.title || 'Mi libro', characters: data.characters, relations: data.relations });
}

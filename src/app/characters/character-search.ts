/** Personajes · Búsqueda e investigación de un personaje con IA. */
import type { CharacterFieldKey } from '../../types';
import { FIELD_KEYS, FIELD_LABELS, LIMITS } from '../characters-model';
import { api, book, characterById, data, esc, host, state } from './context';
import { showFormErrors } from './forms';
import { autoAbort, autoNote, autoRunningHTML, beginAuto, groundingNoteFor, runJSONTask, setAutoAbort, setAutoNote } from './gemini';
import { paint } from './render';

export function characterSearchHTML(): string {
  const search = state.characterSearch;
  if (search.status === 'idle') return '<div id="chrResearchPanel"></div>';
  if (search.status === 'running') return autoRunningHTML('Consultando a Gemini…');
  const promptPanel = (title: string, explanation: string, responseLabel: string, responseId: string, action: string, actionLabel: string) => `<section class="chr-research" id="chrResearchPanel"><h3>${title}</h3><p class="muted">${explanation}</p><label for="chrResearchPrompt">Prompt contextual para Gemini</label><textarea id="chrResearchPrompt" readonly rows="12">${esc(search.prompt)}</textarea><div class="chr-row-actions"><button type="button" class="secondary" data-chr="copy-research-prompt">Copiar prompt</button><a class="secondary" href="https://gemini.google.com/app" target="_blank" rel="noopener noreferrer">Abrir Gemini</a></div><label for="${responseId}">${responseLabel}</label><textarea id="${responseId}" rows="8" placeholder="Pegá aquí la respuesta de Gemini…">${esc(search.responseText)}</textarea>${search.error ? `<p class="chr-ai-error" role="alert">${esc(search.error)}</p>` : ''}<button type="button" class="primary" data-chr="${action}">${actionLabel}</button><p class="muted">Copiá la respuesta completa. Librarium puede leer el JSON aunque Gemini lo haya encerrado en un bloque de código. Los enlaces los devuelve Gemini; abrilos para comprobar la fuente.</p></section>`;
  if (search.status === 'candidate-prompt') return promptPanel('Paso 1 de 2 · Buscar candidatos en Gemini', `Investigá «${esc(search.name)}» en «${esc(book?.title || '')}». El avance registrado es la página ${Math.max(0, Number(book?.currentPage) || 0)}; el prompt pide una identificación introductoria sin spoilers.`, 'Respuesta de Gemini con candidatos', 'chrCandidateResponse', 'parse-candidates', 'Mostrar coincidencias');
  if (search.status === 'profile-prompt') return `${search.candidates.length ? `<section class="chr-research"><h3>Elegiste «${esc(search.name)}»</h3><p class="muted">Fuentes compartidas por Gemini en la búsqueda:</p>${characterSourcesHTML(search.sources)}</section>` : ''}${promptPanel('Paso 2 de 2 · Preparar la ficha', `Pedile a Gemini datos del personaje en «${esc(book?.title || '')}». El prompt limita la respuesta a la página ${Math.max(0, Number(book?.currentPage) || 0)} y solicita omitir cualquier dato externo que pueda revelar la trama.`, 'Respuesta de Gemini con los datos sugeridos', 'chrProfileResponse', 'parse-profile', 'Revisar sugerencias')}`;
  if (search.status === 'candidates') return `<section class="chr-research" id="chrResearchPanel"><h3>${search.candidates.length ? 'Encontré posibles coincidencias' : 'No encontré coincidencias confiables'}</h3><p class="muted">Revisá las opciones para «${esc(search.name)}» en ${esc(book?.title || '')}. Avance registrado: página ${Math.max(0, Number(book?.currentPage) || 0)}. ${esc(autoNote || 'La búsqueda fue realizada en Gemini; Librarium no puede verificar independientemente sus resultados.')}</p>${search.candidates.length && !search.sources.length ? '<p class="chr-ambiguity" role="status">Gemini no incluyó enlaces de fuentes. Considerá repetir la búsqueda y pedirle URLs verificables.</p>' : ''}${search.candidates.length ? `${search.candidates.length > 1 ? '<p class="chr-ambiguity" role="status">Hay varias coincidencias posibles. Elegí una; no se seleccionó ninguna automáticamente.</p>' : ''}<fieldset class="chr-candidates"><legend>Elegí explícitamente el personaje</legend>${search.candidates.map((c, i) => `<label class="chr-candidate"><input type="radio" name="chrCandidate" value="${i}"/><span><strong>${esc(c.name)}</strong><span>También: ${esc(c.aliases.join(', ') || 'sin variantes informadas')}</span><span>${esc(c.description || 'Sin descripción introductoria.')}</span><small>Coincidencia ${esc(c.confidence === 'high' ? 'alta' : c.confidence === 'medium' ? 'media' : 'baja')}</small></span></label>`).join('')}</fieldset><button type="button" class="primary" data-chr="investigate-character" disabled>Completar con este</button>` : '<p class="muted">Podés volver a buscar o conservar el nombre y completar la ficha manualmente.</p>'}<button type="button" class="secondary" data-chr="none-candidate">Ninguno de estos</button>${characterSourcesHTML(search.sources)}</section>`;
  if (search.status === 'ready') return `<section class="chr-research" id="chrResearchPanel"><h3>Sugerencias para «${esc(search.name)}»</h3><p class="muted">Revisá cada dato. Solo se aplicarán campos vacíos; los que ya escribiste permanecerán intactos. Los datos se generaron con conocimiento general y se marcarán como inferidos. Los enlaces de abajo respaldan la identificación, no los datos de esta ficha.</p>${autoNote ? `<p class="muted">${esc(autoNote)}</p>` : ''}${characterSourcesHTML(search.sources)}<div class="chr-row-actions"><button type="button" class="primary" data-chr="apply-research-and-save">Aplicar y ${state.editingCharacterId ? 'guardar cambios' : 'crear ficha'}</button><button type="button" class="secondary" data-chr="apply-research">Solo aplicar sugerencias</button><button type="button" class="secondary" data-chr="none-candidate">Descartar sugerencias</button></div></section>`;
  return '<div id="chrResearchPanel"></div>';
}

function characterSourcesHTML(sources: Array<{ title: string; url: string }>): string {
  if (!sources.length) return '<p class="muted">Gemini no incluyó enlaces de fuentes.</p>';
  return `<details class="chr-research-sources"><summary>Fuentes citadas por Gemini (${sources.length})</summary><ul>${sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a></li>`).join('')}</ul></details>`;
}

export function promptBookContext(): string {
  if (!book) return '';
  return [
    `Título: ${book.title}`,
    book.author ? `Autor: ${book.author}` : '',
    book.publisher ? `Editorial: ${book.publisher}` : '',
    book.year ? `Año: ${book.year}` : '',
    book.edition ? `Edición: ${book.edition}` : '',
    book.isbn ? `ISBN: ${book.isbn}` : '',
    `Página actual registrada: ${Math.max(0, Number(book.currentPage) || 0)}`,
  ].filter(Boolean).join('\n');
}

function buildCandidatePrompt(name: string): string {
  const registered = data.characters.map((c) => `- ${c.name}${c.aliases.length ? ` (alias: ${c.aliases.join(', ')})` : ''}`).join('\n') || 'Ninguno.';
  return [
    'Usá la búsqueda web de Gemini para identificar personajes literarios que puedan corresponder al nombre escrito. Considerá tildes, transliteraciones, nombres traducidos y posibles errores ortográficos. La obra es esencial para desambiguar.',
    `OBRA:\n${promptBookContext()}`,
    `NOMBRE INGRESADO: ${name}`,
    `PERSONAJES YA REGISTRADOS EN ESTE LIBRO:\n${registered}`,
    'MODO SIN SPOILERS: devolvé solo una identificación introductoria y neutral que permita distinguir candidatos. No menciones sucesos, relaciones reveladoras, giros, muertes, destino ni transformaciones posteriores. No afirmes que una fuente web corresponde a la página actual de mi edición.',
    'Devolvé únicamente JSON válido, sin Markdown, con esta forma: {"candidates":[{"name":"nombre canónico","aliases":["otros nombres o transliteraciones"],"description":"breve identificación no argumental","confidence":"high|medium|low"}],"sources":[{"title":"título de la fuente","url":"https://..."}]}. Ofrecé hasta 6 candidatos; si no encontrás coincidencias fiables, devolvé candidates vacío. Incluí solo fuentes consultadas de verdad y URLs completas.',
  ].join('\n\n');
}

function buildProfilePrompt(candidate: { name: string; aliases: string[] }): string {
  const currentPage = Math.max(0, Number(book?.currentPage) || 0);
  const existing = characterById(state.editingCharacterId);
  const currentFields = FIELD_KEYS.map((key) => {
    const current = host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${key}"]`)?.value || existing?.[key] || '';
    return `${FIELD_LABELS[key]}: ${current || '(vacío)'}`;
  }).join('\n');
  return [
    'Completá la ficha de este personaje usando exclusivamente tu conocimiento general aprendido sobre la obra. No uses búsqueda web, documentos externos, notas, citas ni fuentes del usuario.',
    `OBRA: «${promptBookContext()}»`,
    `PERSONAJE: ${candidate.name}`,
    `ALIAS CONOCIDOS: ${candidate.aliases.join(', ') || 'ninguno informado'}`,
    `FICHA ACTUAL (conservá los datos ya escritos; no los reemplaces):\n${currentFields}`,
    `MODO SIN SPOILERS: la persona llegó hasta la página ${currentPage}. No reveles trama posterior, giros ni destinos. Priorizá datos introductorios y estables. Si la edad cambia, indicá la edad al comienzo.`,
    'Completá edad, descripción introductoria, entre 3 y 6 rasgos, ocupación y pertenencia. Ofrecé tu mejor dato concreto y probable; no incluyas explicaciones dentro de los campos. Dejá vacío solo aquello que realmente no puedas establecer. No agregues familiares ni relaciones en esta consulta.',
    'Devolvé únicamente JSON válido, sin Markdown, con esta forma: {"name":"","aliases":[],"age":"","description":"","traits":[],"occupation":"","affiliation":""}.',
  ].join('\n\n');
}

export function parsePastedJSON(text: string): any {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf('{');
  if (start < 0) throw Error('No encontré un objeto JSON en la respuesta. Copiá la respuesta completa de Gemini.');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
  }
  throw Error('El JSON de Gemini quedó incompleto. Copiá la respuesta completa e intentá otra vez.');
}

export function normalizePastedSources(raw: unknown): Array<{ title: string; url: string }> {
  if (!Array.isArray(raw)) return [];
  const sources = raw.slice(0, 30).flatMap((source: any) => {
    const url = typeof source?.url === 'string' ? source.url.trim() : '';
    if (!/^https?:\/\//i.test(url) || url.length > 2000) return [];
    return [{ title: String(source.title || url).trim().slice(0, 180), url }];
  });
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}

export function startCharacterSearch() {
  const name = host?.querySelector<HTMLInputElement>('#chr_name')?.value.trim() || '';
  if (!name) return showFormErrors(['Escribí el nombre antes de preparar la búsqueda.']);
  if (api().ai.hasKey()) return void runAutoCandidates(name);
  setAutoNote('');
  state.characterSearch = { status: 'candidate-prompt', name, candidates: [], sources: [], error: '', suggestion: null, prompt: buildCandidatePrompt(name), responseText: '' };
  paint();
}

function candidatesFromParsed(parsed: any) {
  return Array.isArray(parsed?.candidates) ? parsed.candidates.slice(0, 6).flatMap((c: any) => {
    if (typeof c?.name !== 'string' || !c.name.trim()) return [];
    return [{ name: c.name.trim().slice(0, LIMITS.name), aliases: Array.isArray(c.aliases) ? c.aliases.map((a: unknown) => String(a).trim().slice(0, LIMITS.alias)).filter(Boolean).slice(0, 12) : [], description: String(c.description || '').trim().slice(0, 600), confidence: ['high', 'medium', 'low'].includes(c.confidence) ? c.confidence : 'low' }];
  }) : [];
}

export function parseCandidateResponse() {
  const search = state.characterSearch;
  try {
    const parsed = parsePastedJSON(host?.querySelector<HTMLTextAreaElement>('#chrCandidateResponse')?.value || '');
    state.characterSearch = { ...search, status: 'candidates', candidates: candidatesFromParsed(parsed), sources: normalizePastedSources(parsed.sources), error: '', responseText: '' };
  } catch (err: any) { state.characterSearch = { ...search, error: String(err?.message || err), responseText: host?.querySelector<HTMLTextAreaElement>('#chrCandidateResponse')?.value || '' }; }
  paint();
}

async function runAutoCandidates(name: string) {
  const controller = beginAuto();
  setAutoNote(`Buscando coincidencias para «${name}»…`);
  state.characterSearch = { status: 'running', name, candidates: [], sources: [], error: '', suggestion: null, prompt: '', responseText: '' };
  paint();
  try {
    const result = await runJSONTask(buildCandidatePrompt(name), controller.signal);
    if (controller.signal.aborted) return;
    const parsed = parsePastedJSON(result.text);
    setAutoNote(groundingNoteFor(result));
    // En modo automático mostramos solo fuentes devueltas por Google Search, no URLs que el modelo escriba en su JSON.
    state.characterSearch = { status: 'candidates', name, candidates: candidatesFromParsed(parsed), sources: result.sources, error: '', suggestion: null, prompt: '', responseText: '' };
  } catch (err: any) {
    if (controller.signal.aborted) return;
    setAutoNote('');
    state.characterSearch = { status: 'candidate-prompt', name, candidates: [], sources: [], error: `${String(err?.message || err)} Mientras tanto podés usar el método manual.`, suggestion: null, prompt: buildCandidatePrompt(name), responseText: '' };
  } finally {
    if (autoAbort === controller) setAutoAbort(null);
  }
  paint();
}

function suggestionFromParsed(parsed: any, fallbackName: string) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('La respuesta no tiene el formato de ficha esperado.');
  return {
    name: String(parsed.name || fallbackName).trim().slice(0, LIMITS.name),
    aliases: Array.isArray(parsed.aliases) ? parsed.aliases.map((x: unknown) => String(x).trim().slice(0, LIMITS.alias)).filter(Boolean).slice(0, LIMITS.aliases) : [],
    age: String(parsed.age || '').trim().slice(0, LIMITS.age), description: String(parsed.description || '').trim().slice(0, LIMITS.description),
    traits: Array.isArray(parsed.traits) ? parsed.traits.map((x: unknown) => String(x).trim().slice(0, LIMITS.trait)).filter(Boolean).slice(0, LIMITS.traits) : [],
    occupation: String(parsed.occupation || '').trim().slice(0, LIMITS.occupation), affiliation: String(parsed.affiliation || '').trim().slice(0, LIMITS.affiliation),
    certainty: parsed.certainty && typeof parsed.certainty === 'object' ? parsed.certainty : {},
  };
}

async function runAutoProfile(selected: { name: string; aliases: string[] }) {
  const controller = beginAuto();
  const before = state.characterSearch;
  setAutoNote(`Completando la ficha de «${selected.name}»…`);
  state.characterSearch = { ...before, status: 'running', name: selected.name, error: '' };
  paint();
  const prompt = buildProfilePrompt(selected);
  try {
    const result = await runJSONTask(prompt, controller.signal, false);
    if (controller.signal.aborted) return;
    const parsed = parsePastedJSON(result.text);
    const suggestion = suggestionFromParsed(parsed, selected.name);
    setAutoNote('Propuesta preparada con el conocimiento general del modelo, sin búsqueda web ni fuentes del cuaderno.');
    state.characterSearch = { ...before, status: 'ready', name: selected.name, suggestion, sources: before.sources, error: '', responseText: '' };
  } catch (err: any) {
    if (controller.signal.aborted) return;
    setAutoNote('');
    state.characterSearch = { ...before, status: 'profile-prompt', name: selected.name, prompt, error: `${String(err?.message || err)} Mientras tanto podés usar el método manual.`, responseText: '' };
  } finally {
    if (autoAbort === controller) setAutoAbort(null);
  }
  paint();
}

export function prepareSelectedProfile() {
  const index = Number(host?.querySelector<HTMLInputElement>('input[name="chrCandidate"]:checked')?.value);
  const selected = state.characterSearch.candidates[index];
  if (!selected) return showFormErrors(['Elegí explícitamente una coincidencia antes de continuar.']);
  if (!state.editingCharacterId) {
    const nameInput = host?.querySelector<HTMLInputElement>('[name="name"]');
    if (nameInput) nameInput.value = selected.name;
  }
  if (api().ai.hasKey()) return void runAutoProfile(selected);
  state.characterSearch = { ...state.characterSearch, status: 'profile-prompt', name: selected.name, prompt: buildProfilePrompt(selected), error: '', responseText: '' };
  paint();
}

export function parseProfileResponse() {
  const search = state.characterSearch;
  try {
    const parsed = parsePastedJSON(host?.querySelector<HTMLTextAreaElement>('#chrProfileResponse')?.value || '');
    const suggestion = suggestionFromParsed(parsed, search.name);
    // El perfil se completa sin búsqueda web; las fuentes previas solo respaldan la identificación.
    state.characterSearch = { ...search, status: 'ready', suggestion, sources: search.sources, error: '', responseText: '' };
  } catch (err: any) { state.characterSearch = { ...search, error: String(err?.message || err), responseText: host?.querySelector<HTMLTextAreaElement>('#chrProfileResponse')?.value || '' }; }
  paint();
}

export async function copyResearchPrompt() {
  const prompt = state.characterSearch.prompt;
  const textarea = host?.querySelector<HTMLTextAreaElement>('#chrResearchPrompt');
  try {
    await navigator.clipboard.writeText(prompt);
    showFormErrors([], ['Prompt copiado. Abrí Gemini, pegalo y después traé la respuesta a Librarium.']);
  } catch {
    textarea?.focus(); textarea?.select();
    showFormErrors([], ['Seleccioné el prompt para copiarlo manualmente con Ctrl+C.']);
  }
}

export function applyWebResearch() {
  const suggestion = state.characterSearch.suggestion;
  if (!suggestion) return;
  if (!state.editingCharacterId && suggestion.name) {
    const nameInput = host?.querySelector<HTMLInputElement>('[name="name"]');
    if (nameInput) nameInput.value = suggestion.name;
  }
  const filledFields = new Set<string>();
  const setEmpty = (name: string, value: unknown, transform = (x: any) => String(x ?? '')) => {
    const field = host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    if (field && !field.value.trim()) {
      field.value = transform(value);
      if (FIELD_KEYS.includes(name as CharacterFieldKey) && field.value.trim()) filledFields.add(name);
    }
  };
  setEmpty('aliases', suggestion.aliases, (x) => Array.isArray(x) ? x.join('\n') : '');
  setEmpty('age', suggestion.age);
  setEmpty('description', suggestion.description);
  setEmpty('traits', suggestion.traits, (x) => Array.isArray(x) ? x.join(', ') : '');
  setEmpty('occupation', suggestion.occupation);
  setEmpty('affiliation', suggestion.affiliation);
  for (const field of FIELD_KEYS) {
    const input = host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${field}"]`);
    const certainty = host?.querySelector<HTMLSelectElement>(`[name="cert_${field}"]`);
    if (filledFields.has(field) && certainty) certainty.value = 'inferred';
  }
  showFormErrors([], ['Se completaron únicamente campos vacíos. Estos datos provienen del conocimiento general y quedaron marcados como inferidos; las fuentes de búsqueda respaldan la identificación, no los datos de la ficha.']);
  const applyButton = host?.querySelector<HTMLButtonElement>('[data-chr="apply-research"]');
  if (applyButton) applyButton.disabled = true;
}

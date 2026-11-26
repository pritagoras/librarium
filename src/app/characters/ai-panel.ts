/** Personajes · Consultas a la IA desde la ficha y guardado de respuestas. */
import type { Certainty, Character, CharacterFieldKey, CharacterRelation } from '../../types';
import { CERTAINTIES, CERTAINTY_LABELS, FIELD_LABELS, LIMITS, RELATION_TYPES, applyAnswerToCharacter, applyAnswerToRelation, buildCharacterAIRequest, normalizeText, sheetLinks, type SheetLink, type AIScope, type SaveTarget, validateRelation } from '../characters-model';
import { parsePastedJSON } from './character-search';
import { AI_SPARK, api, book, characterById, data, esc, host, state, type AIState } from './context';
import { formValue, showFormErrors } from './forms';
import { paint, reload } from './render';

// ---------------------------------------------------------------------------
// IA
// ---------------------------------------------------------------------------

export function abortAI() {
  state.ai?.controller?.abort();
}

function scopeLabel(character: Character, scope: AIScope): string {
  if (scope.kind === 'character') return `ficha completa de ${character.name}`;
  if (scope.kind === 'field') return `${FIELD_LABELS[scope.field].toLowerCase()} de ${character.name}`;
  return `vínculo entre ${character.name} y ${characterById(scope.otherId)?.name ?? 'otro personaje'}`;
}

export async function startAI(scope: AIScope, formTarget = false) {
  const character = formTarget
    ? (characterById(state.editingCharacterId) ?? {
        id: 'character-draft', bookId: state.bookId, name: host?.querySelector<HTMLInputElement>('#chr_name')?.value.trim() || '',
        aliases: [], age: '', description: '', traits: [], occupation: '', affiliation: '', comments: '', evidence: [], certainty: {},
      })
    : characterById(state.selectedId);
  if (!character || !book) return;
  if (!character.name.trim()) return showFormErrors(['Escribí el nombre del personaje antes de consultar a la IA.']);
  abortAI();
  const ai: AIState = {
    scope,
    label: scopeLabel(character, scope),
    plan: null,
    status: 'running',
    text: '',
    error: '',
    keyError: false,
    note: '',
    controller: null,
    formTarget,
  };
  state.ai = ai;
  if (!api().ai.hasKey()) {
    ai.status = 'error';
    ai.keyError = true;
    ai.error = 'Para consultar a la IA, guardá tu API key personal de Gemini en Ajustes → Ajustes de IA.';
    paintAI();
    return;
  }
  try {
    ai.plan = buildCharacterAIRequest({
      book,
      character,
      characters: data.characters,
      relations: data.relations,
      scope,
      notes: data.notes,
      entries: data.entries,
      quotes: data.quotes,
      styleInstruction: api().ai.styleInstruction(),
    });
    if (!formTarget && scope.kind === 'character') {
      ai.fullSheet = true;
      ai.plan.prompt += '\n\nRespondé únicamente JSON válido, sin markdown, con esta forma: {"aliases":[],"age":"","description":"","traits":[],"occupation":"","affiliation":"","basis":{"age":"de dónde sale el dato y qué tan seguro estás, en 1 o 2 frases","description":"","occupation":"","affiliation":"","traits":"","aliases":""},"certainty":{"age":"explicit|inferred","description":"explicit|inferred","occupation":"explicit|inferred","affiliation":"explicit|inferred"}}. Comprometete con tu mejor estimación para cada campo usando el material guardado y tu conocimiento de la obra, sin revelar trama posterior a la página de lectura. Dejá vacío solo lo que no tenga base alguna. Usá explicit solo si sale directo del material guardado.';
      const others = data.characters.filter((c) => c.id !== character.id).slice(0, 60).map((c) => ({ name: c.name, aliases: c.aliases }));
      ai.plan.prompt += `\n\nAdemás agregá la clave "relations" con los vínculos de «${character.name}» de cualquier tipo (familia, amor, amistad, rivalidad, alianza, mentoría u otros), no solo familiares. Personajes ya registrados (usá exactamente esos nombres): ${JSON.stringify(others)}. También podés proponer personajes que todavía no estén. Cada elemento: {"name":"la otra persona","type":"uno de ${RELATION_TYPES.join(', ')} u otro tipo breve","direction":"out si «${character.name}» es quien cumple el rol hacia el otro (p. ej. Madre de), in si es al revés; en vínculos simétricos usá out","relationDescription":"breve","certainty":"explicit|inferred","basis":"de dónde sale y qué tan seguro estás","age":"","occupation":"","description":"descripción breve de la persona, solo si no está registrada"}. Sin spoilers posteriores a la página de lectura. No repitas los vínculos ya registrados.`;
      ai.plan.systemInstruction += '\n\nEn esta solicitud respondé únicamente con el JSON pedido (ignorá el formato por secciones) y usá tu conocimiento general de la obra cuando el material no alcance, sin spoilers.';
    }
    if (formTarget) {
      ai.plan.prompt += '\n\nLa persona pidió completar una ficha y quizá agregar vínculos (en la clave relatives; de cualquier tipo: familia, amor, amistad, rivalidad, alianza, mentoría u otro). Respondé únicamente JSON válido, sin markdown, con esta forma: {"nameSuggestion":"nombre correcto sugerido o cadena vacía","nameSuggestionBasis":"material|conocimiento_general|vacío","nameSuggestionEvidence":"código de fuente y referencia o vacío","aliases":[],"age":"","description":"","traits":[],"occupation":"","affiliation":"","certainty":{"age":"explicit","description":"inferred","occupation":"explicit","affiliation":"inferred"},"evidence":{"age":"código de fuente y referencia o vacío","description":"código de fuente y referencia o vacío","occupation":"código de fuente y referencia o vacío","affiliation":"código de fuente y referencia o vacío"},"relatives":[{"name":"","type":"Hermano/a de","direction":"out","certainty":"explicit","evidence":"código de fuente y referencia"}]}. Para nameSuggestion podés usar una coincidencia en las fuentes permitidas o tu conocimiento general de la obra para sugerir solo la ortografía/nombre canónico más probable. nameSuggestionBasis debe ser exactamente material, conocimiento_general o vacío. Si usás conocimiento general, marca nameSuggestionBasis como conocimiento_general; no des detalles de trama, relaciones ni eventos al explicar la sugerencia. Si no tenés confianza suficiente, dejá nameSuggestion vacío. Nunca cambies el nombre de la ficha automáticamente. Para los demás datos, priorizá las fuentes permitidas y, si no alcanzan, completá con tu conocimiento de la obra (edad, ocupación, pertenencia, descripción, vínculos) cuando lo conozcas; no anticipes eventos posteriores a la página actual. Dejá vacío solo lo que realmente no sepas. En certainty usá solo los valores exactos explicit, inferred o unknown. Para direction usá solo out o in. Usá cadenas vacías y listas vacías si no hay respaldo. Podés proponer vínculos respaldados por las fuentes o por tu conocimiento de la obra, siempre sin spoilers; si no es del material, no pongas certainty explicit. La persona revisará las sugerencias antes de aplicarlas.';
      ai.plan.systemInstruction += '\n\nEn esta solicitud podés usar tu conocimiento general de la obra para completar edad, ocupación, pertenencia, descripción y vínculos cuando el material no alcance, siempre sin revelar trama posterior a la página de lectura. Lo que no salga del material nunca debe llevar certainty explicit. Dejá vacío solo lo que realmente no conozcas.';
    }
  } catch (err: any) {
    ai.status = 'error';
    ai.error = String(err?.message || err);
    paintAI();
    return;
  }
  paintAI();
  host?.querySelector<HTMLElement>('#chrAiHost')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  await runAI(ai);
}

async function runAI(ai: AIState) {
  const controller = new AbortController();
  ai.controller = controller;
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, ms);
  };
  const answerEl = () => host?.querySelector<HTMLElement>('#chrAiAnswer');
  try {
    const settings = api().ai.settings();
    arm(60000);
    const response = await api().ai.request(
      'chat-stream',
      {
        contents: [{ role: 'user', parts: [{ text: ai.plan!.prompt }] }],
        systemInstruction: ai.plan!.systemInstruction,
        model: settings.model,
        thinking: settings.thinking,
      },
      controller.signal,
    );
    if (!response.ok || !response.body) {
      let message = `Error HTTP ${response.status}`;
      try {
        message = (await response.json()).error || message;
      } catch {}
      const httpError: any = Error(message);
      httpError.status = response.status;
      throw httpError;
    }
    const model = response.headers.get('X-Librarium-Model');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason = '';
    let blocked = '';
    const handle = (block: string) => {
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) return;
      let payload: any;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        return;
      }
      if (payload.error) blocked = payload.error.message || 'Error al generar la respuesta.';
      if (payload.promptFeedback?.blockReason && !ai.text.trim()) {
        blocked = `La consulta fue bloqueada por Gemini (${payload.promptFeedback.blockReason}).`;
      }
      if (Array.isArray(payload.candidates)) {
        const reason = payload.candidates.map((c: any) => c.finishReason).find(Boolean);
        if (reason) finishReason = String(reason);
        const piece = payload.candidates
          .flatMap((c: any) => c.content?.parts || [])
          .filter((part: any) => !part.thought)
          .map((part: any) => part.text || '')
          .join('');
        if (piece) {
          ai.text += piece;
          const el = answerEl();
          if (el) el.textContent = ai.text;
        }
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      arm(45000);
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      blocks.forEach((b) => b.trim() && handle(b));
    }
    if (buffer.trim()) handle(buffer);
    if (!ai.text.trim()) throw Error(blocked || 'Gemini no devolvió texto.');
    if (finishReason && finishReason !== 'STOP') {
      ai.note = 'La respuesta puede estar incompleta. Revisala antes de guardarla.';
    }
    if (model) ai.note = `${ai.note ? `${ai.note} ` : ''}Modelo: ${model}.`;
    ai.status = 'done';
  } catch (err: any) {
    if (controller.signal.aborted && !stalled) {
      // Detenida por la persona: conservamos lo recibido para que pueda usarlo.
      ai.status = ai.text.trim() ? 'done' : 'error';
      ai.error = ai.text.trim() ? '' : 'Consulta detenida.';
      ai.note = ai.text.trim() ? 'Respuesta detenida: puede estar incompleta.' : '';
    } else {
      ai.status = ai.text.trim() ? 'done' : 'error';
      ai.keyError = api().ai.isKeyError(err);
      ai.error = stalled ? 'La IA tardó demasiado en responder. Probá de nuevo.' : String(err?.message || err);
      if (ai.text.trim()) ai.note = `La respuesta se cortó: ${ai.error}`;
    }
  } finally {
    clearTimeout(watchdog);
    ai.controller = null;
  }
  if (state.ai === ai) paintAI();
}

function saveTargetsFor(ai: AIState, hasRelation: boolean): Array<[SaveTarget, string]> {
  if (ai.scope.kind === 'field' && ai.scope.field !== 'name') {
    return [
      ['field', `Como dato: ${FIELD_LABELS[ai.scope.field].toLowerCase()}`],
      ['comments', 'Agregar a los comentarios'],
      ['evidence', 'Guardar como fuente o evidencia'],
    ];
  }
  if (ai.scope.kind === 'relation') {
    return hasRelation
      ? [
          ['field', 'Como descripción del vínculo'],
          ['comments', 'Agregar a la descripción del vínculo'],
          ['evidence', 'Guardar como fuente del vínculo'],
        ]
      : [];
  }
  return [
    ['comments', 'Agregar a los comentarios'],
    ['evidence', 'Guardar como fuente o evidencia'],
  ];
}

function pairRelations(ai: AIState): CharacterRelation[] {
  const character = characterById(state.selectedId);
  if (!character || ai.scope.kind !== 'relation') return [];
  const otherId = ai.scope.otherId;
  return data.relations.filter(
    (r) => (r.fromId === character.id && r.toId === otherId) || (r.fromId === otherId && r.toId === character.id),
  );
}

export function paintAI() {
  const slot = host?.querySelector<HTMLElement>('#chrAiHost');
  if (!slot) return;
  const ai = state.ai;
  if (!ai) {
    slot.innerHTML = '';
    return;
  }
  const relations = pairRelations(ai);
  const targets = ai.status === 'done' && !ai.formTarget ? saveTargetsFor(ai, relations.length > 0) : [];
  const suggestion = splitSuggestion(ai.text);
  const sheetCharacter = characterById(state.selectedId);
  const sheet = ai.fullSheet && ai.status === 'done' && sheetCharacter ? parseFullSheet(ai.text) : null;
  const answerHTML =
    ai.status === 'done' && !ai.formTarget && api().renderMarkdown
      ? `<div class="chr-ai-answer chr-ai-answer--md" id="chrAiAnswer" tabindex="0">${api().renderMarkdown!(suggestion.body)}</div>`
      : `<div class="chr-ai-answer" id="chrAiAnswer" tabindex="0">${esc(suggestion.body)}</div>`;
  const fieldKey = ai.scope.kind === 'field' && ai.scope.field !== 'name' ? ai.scope.field : null;
  const isFieldSuggestion = fieldKey !== null;
  const fieldSuggestionHTML = isFieldSuggestion && ai.status === 'done'
    ? `<div class="chr-ai-quick-context"><span class="chr-ai-eyebrow">CONTEXTO</span><p>${esc(suggestion.body)}</p><p class="muted">Sugerencia basada en el conocimiento general del modelo, sin notas ni búsqueda web. Se guardará como inferida.</p></div>
      <form id="chrAiSave" class="chr-ai-quick-form" novalidate>
        <input type="hidden" name="target" value="field" />
        <input type="hidden" name="certainty" value="inferred" />
        <label for="chrAiSaveText">${esc(FIELD_LABELS[fieldKey!])}</label>
        ${fieldKey === 'description'
          ? `<textarea id="chrAiSaveText" name="text" rows="3">${esc(suggestion.value)}</textarea>`
          : `<input id="chrAiSaveText" name="text" type="text" value="${esc(suggestion.value)}" autocomplete="off" />`}
        <div class="chr-ai-save-error" id="chrAiSaveError" role="alert"></div>
        <button type="submit" class="primary">Aplicar a la ficha</button>
      </form>`
    : '';
  slot.innerHTML = `<section class="chr-ai" aria-labelledby="chrAiTitle">
    <div class="chr-section-head">
      <h3 id="chrAiTitle">${AI_SPARK} IA · ${esc(ai.label)}</h3>
      <div class="chr-row-actions">
        ${ai.status === 'running' ? '<button type="button" class="secondary" data-chr="ai-stop">Detener</button>' : ''}
        <button type="button" class="secondary" data-chr="ai-close">Cerrar</button>
      </div>
    </div>
    ${!isFieldSuggestion && ai.plan ? `<details class="chr-ai-context"><summary>Qué se envía a la IA</summary><p class="muted">${esc(ai.plan.contextSummary)}</p></details>` : ''}
    <p class="chr-ai-status" role="status" aria-live="polite">${
      ai.status === 'running' ? 'Consultando a la IA…' : ai.status === 'done' ? esc(ai.note) : ''
    }</p>
    ${ai.status === 'error' ? `<div class="chr-ai-error" role="alert">${esc(ai.error)} ${ai.keyError ? '<button type="button" class="ai-key-cta" data-chr="ai-key">Configurar mi API key</button>' : ''}</div>` : ''}
    ${isFieldSuggestion ? fieldSuggestionHTML : sheet ? fullSheetFormHTML(sheetCharacter!, sheet) : ai.fullSheet && ai.status === 'running' ? '' : ai.text || ai.status === 'running' ? answerHTML : ''}
    ${ai.formTarget && ai.status === 'done' ? `<div class="chr-ai-save">${suggestedNameHTML(ai.text)}<p class="muted">Revisá la respuesta. Marcá los vínculos que quieras agregar; se crearán al guardar la ficha.</p><div id="chrSuggestedRelatives">${suggestedRelativesHTML(ai.text)}</div><button type="button" class="primary" data-chr="apply-autofill">Aplicar datos seleccionados</button></div>` : ''}
    ${!isFieldSuggestion && ai.status === 'done' && ai.text.trim() && !sheet
        ? `<p class="muted chr-ai-disclaimer">La IA puede equivocarse y no leyó el libro completo: revisá lo explícito y lo inferido antes de guardar.</p>
    ${
      targets.length
        ? `<form id="chrAiSave" class="chr-ai-save" novalidate>
      <div class="chr-form-field">
        <label for="chrAiSaveText">${suggestion.value ? 'Valor sugerido por la IA (editalo antes de guardar)' : 'Texto a guardar (podés editarlo)'}</label>
        <textarea id="chrAiSaveText" name="text" rows="${suggestion.value ? 2 : 6}">${esc(suggestion.value || suggestion.body)}</textarea>
      </div>
      <div class="chr-ai-save-row">
        <div class="chr-form-field">
          <label for="chrAiTarget">Dónde guardarlo</label>
          <select id="chrAiTarget" name="target">${targets.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('')}</select>
        </div>
        <div class="chr-form-field" id="chrAiCertaintyWrap">
          <label for="chrAiCertainty">Certeza del dato</label>
          <select id="chrAiCertainty" name="certainty">
            <option value="inferred" ${suggestion.certainty === 'inferred' ? 'selected' : ''}>${CERTAINTY_LABELS.inferred}</option>
            <option value="explicit" ${suggestion.certainty === 'explicit' ? 'selected' : ''}>${CERTAINTY_LABELS.explicit}</option>
          </select>
        </div>
        ${
          relations.length > 1
            ? `<div class="chr-form-field"><label for="chrAiRelation">Vínculo</label><select id="chrAiRelation" name="relation">${relations.map((r) => `<option value="${esc(r.id)}">${esc(r.type)}</option>`).join('')}</select></div>`
            : ''
        }
      </div>
      <div class="chr-ai-save-error" id="chrAiSaveError" role="alert"></div>
      <button type="submit" class="primary">Guardar en la ficha…</button>
    </form>`
        : ai.scope.kind === 'relation'
          ? '<p class="muted">Todavía no hay un vínculo registrado entre estos personajes. Creá uno con «＋ Agregar vínculo» para poder guardar la respuesta allí.</p>'
          : ''
    }`
        : ''
    }
  </section>`;
  syncAISaveForm();
}

/** Separa del texto de la IA las líneas VALOR_SUGERIDO / CERTEZA_SUGERIDA que precargan el formulario de guardado. */
function splitSuggestion(text: string): { body: string; value: string; certainty: Certainty } {
  const value = /^[ \t]*VALOR_SUGERIDO:[ \t]*(.*)$/im.exec(text)?.[1]?.trim().replace(/^[«"“]+|[»"”]+$/g, '') || '';
  const raw = /^[ \t]*CERTEZA_SUGERIDA:[ \t]*(\w+)/im.exec(text)?.[1]?.toLowerCase() || '';
  const body = text.replace(/^[ \t]*(?:VALOR_SUGERIDO|CERTEZA_SUGERIDA):.*$/gim, '')
    .replace(/^[ \t]*CONTEXTO_BREVE:[ \t]*/im, '')
    .replace(/\n{3,}/g, '\n\n').trim();
  return { body, value, certainty: raw === 'explicit' ? 'explicit' : 'inferred' };
}

const FULL_SHEET_FIELDS: Array<{ key: CharacterFieldKey; long?: boolean }> = [
  { key: 'age' }, { key: 'occupation' }, { key: 'affiliation' }, { key: 'description', long: true },
];

function parseFullSheet(text: string): any | null {
  try {
    const parsed = parsePastedJSON(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function sheetLinkRow(i: number, link: Partial<SheetLink>, manual = false): string {
  const direction = link.direction === 'in' ? 'in' : 'out';
  const existing = link.name && data.characters.some((c) => [c.name, ...c.aliases].some((n) => normalizeText(n) === normalizeText(link.name!)));
  return `<fieldset class="chr-fs-row chr-link-row">
    <label class="chr-fs-check"><input type="checkbox" name="rel_apply_${i}" ${manual ? 'checked' : ''}/> <span>${manual ? '<strong>Nuevo vínculo</strong>' : `<strong>${esc(link.name)}</strong> · ${esc(link.type)} <span class="muted">${existing ? '(ya tiene ficha)' : '(se creará la ficha)'}</span>`}</span></label>
    <label>Con quién<input name="rel_name_${i}" value="${esc(link.name)}" list="chrLinkNames" maxlength="${LIMITS.name}" autocomplete="off"/></label>
    <label>Tipo de vínculo<input name="rel_type_${i}" value="${esc(link.type)}" list="chrLinkTypes" maxlength="${LIMITS.relationType}" placeholder="Amistad, amor, rivalidad, familiar…" autocomplete="off"/></label>
    <label>Sentido<select name="rel_dir_${i}"><option value="out" ${direction === 'out' ? 'selected' : ''}>De este personaje hacia el otro</option><option value="in" ${direction === 'in' ? 'selected' : ''}>Del otro hacia este personaje</option></select></label>
    <details><summary>Más detalles</summary><div>
      <label>Descripción del vínculo<textarea name="rel_note_${i}" rows="2">${esc(link.description)}</textarea></label>
      <label>Edad (si es nuevo)<input name="rel_age_${i}" value="${esc(link.age)}"/></label>
      <label>Ocupación (si es nuevo)<input name="rel_occupation_${i}" value="${esc(link.occupation)}"/></label>
      <label>Quién es (si es nuevo)<textarea name="rel_description_${i}" rows="2">${esc(link.profile)}</textarea></label>
    </div></details>
    ${manual ? '' : `<small class="muted">${link.basis ? `Respaldo sugerido: ${esc(link.basis)}` : 'La IA no indicó una fuente; verificá antes de incorporarlo.'} · Se guardará como inferido.</small>`}
    <input type="hidden" name="rel_basis_${i}" value="${esc(link.basis)}"/>
    <input type="hidden" name="rel_manual_${i}" value="${manual ? '1' : ''}"/>
  </fieldset>`;
}

function sheetRelationRows(character: Character, parsed: any): string {
  const links = sheetLinks(parsed, character, data.characters, data.relations);
  const names = data.characters.filter((c) => c.id !== character.id).map((c) => `<option value="${esc(c.name)}"></option>`).join('');
  return `<h4>Vínculos</h4><p class="muted">${links.length ? 'Marcá los que querés incorporar.' : 'La IA no propuso vínculos nuevos.'} También podés agregar los tuyos.</p>
    <datalist id="chrLinkNames">${names}</datalist><datalist id="chrLinkTypes">${RELATION_TYPES.map((t) => `<option value="${esc(t)}"></option>`).join('')}</datalist>
    <input type="hidden" name="rel_count" value="${links.length}"/>
    <div id="chrSheetLinks">${links.map((link, i) => sheetLinkRow(i, link)).join('')}</div>
    <button type="button" class="secondary" data-chr="add-sheet-link">＋ Agregar otro vínculo</button>`;
}

/** Suma una fila vacía sin repintar, para no perder lo ya marcado o escrito. */
export function addSheetLinkRow(): void {
  const form = host?.querySelector<HTMLFormElement>('#chrFullSheet');
  const list = form?.querySelector('#chrSheetLinks');
  const count = form?.elements.namedItem('rel_count') as HTMLInputElement | null;
  if (!list || !count) return;
  const i = Number(count.value) || 0;
  list.insertAdjacentHTML('beforeend', sheetLinkRow(i, {}, true));
  count.value = String(i + 1);
  list.querySelector<HTMLInputElement>(`[name="rel_name_${i}"]`)?.focus();
}

function fullSheetFormHTML(character: Character, parsed: any): string {
  const row = (key: string, label: string, aiValue: string, current: string, long: boolean, certainty?: Certainty, basis = '') => {
    const value = aiValue || current;
    const checked = aiValue && !current ? 'checked' : '';
    const hasProposal = Boolean(aiValue);
    return `<div class="chr-form-field chr-fs-row"><label class="chr-fs-check"><input type="checkbox" name="fs_apply_${key}" ${checked}/> <span><strong>${esc(label)}</strong>${aiValue ? ' · Aplicar sugerencia IA' : ''}</span></label>
      ${aiValue && current ? `<small class="muted">Dato actual: ${esc(String(current).slice(0, 500))}</small>` : ''}
      ${long ? `<textarea name="fs_${key}" rows="4">${esc(value)}</textarea>` : `<input name="fs_${key}" value="${esc(value)}" />`}
      ${hasProposal ? `<small class="muted">${basis ? `Respaldo sugerido: ${esc(String(basis).slice(0, LIMITS.evidenceText))}` : 'La IA no indicó una fuente concreta.'} · Certeza propuesta: ${esc(CERTAINTY_LABELS[certainty || 'inferred'])}. Al aplicarlo, Librarium lo guardará como inferido.</small><input type="hidden" name="fs_basis_${key}" value="${esc(String(basis).slice(0, LIMITS.evidenceText))}" />` : ''}
      </div>`;
  };
  const list = (value: unknown) => (Array.isArray(value) ? value.map((x) => String(x).trim()).filter(Boolean) : []);
  const rows = FULL_SHEET_FIELDS.map(({ key, long }) => {
    const proposed = CERTAINTIES.includes(parsed.certainty?.[key]) ? parsed.certainty[key] as Certainty : 'inferred';
    return row(key, FIELD_LABELS[key], String(parsed[key] || '').trim(), String(character[key] || ''), Boolean(long), proposed, String(parsed.basis?.[key] || ''));
  }).join('');
  const traits = row('traits', 'Rasgos (separados por coma)', list(parsed.traits).join(', '), character.traits.join(', '), false, undefined, String(parsed.basis?.traits || ''));
  const aliases = row('aliases', 'Alias (separados por coma)', list(parsed.aliases).join(', '), character.aliases.join(', '), false, undefined, String(parsed.basis?.aliases || ''));
  return `<form id="chrFullSheet" class="chr-ai-save" novalidate><p class="muted">La IA completó los datos que pudo establecer. Los valores ya están cargados y podés editarlos antes de aplicar.</p>${rows}${traits}${aliases}${sheetRelationRows(character, parsed)}<div class="chr-ai-save-error" id="chrAiSaveError" role="alert"></div><button type="submit" class="primary">Aplicar ficha completa</button></form>`;
}

export async function submitFullSheet(form: HTMLFormElement) {
  const character = characterById(state.selectedId);
  if (!character) return;
  const errorBox = host?.querySelector<HTMLElement>('#chrAiSaveError');
  const fail = (message: string) => { if (errorBox) errorBox.textContent = message; };
  const checked = (key: string) => (form.elements.namedItem(`fs_apply_${key}`) as HTMLInputElement | null)?.checked;
  const updated: Character = { ...character, certainty: { ...character.certainty } };
  const changes: string[] = [];
  for (const { key } of FULL_SHEET_FIELDS) {
    if (!checked(key)) continue;
    const value = formValue(form, `fs_${key}`).trim();
    if (!value) continue;
    if (value.length > LIMITS[key]) return fail(`«${FIELD_LABELS[key]}» supera el máximo de ${LIMITS[key]} caracteres.`);
    const cert: Certainty = 'inferred';
    updated[key] = value;
    updated.certainty[key] = cert;
    changes.push(`${FIELD_LABELS[key]}: ${value.slice(0, 120)} (${CERTAINTY_LABELS[cert]})`);
  }
  const splitList = (key: string, max: number, limit: number) => formValue(form, `fs_${key}`).split(',').map((x) => x.trim().slice(0, max)).filter(Boolean).slice(0, limit);
  if (checked('traits')) { updated.traits = splitList('traits', LIMITS.trait, LIMITS.traits); changes.push(`Rasgos: ${updated.traits.join(', ')}`); }
  if (checked('aliases')) { updated.aliases = splitList('aliases', LIMITS.alias, LIMITS.aliases); changes.push(`Alias: ${updated.aliases.join(', ')}`); }
  const evidenceLabels: Record<string, string> = { ...FIELD_LABELS, traits: 'Rasgos', aliases: 'Alias' };
  for (const key of [...FULL_SHEET_FIELDS.map(({ key }) => key), 'traits', 'aliases']) {
    const basis = formValue(form, `fs_basis_${key}`).trim();
    if (!checked(key) || !basis || updated.evidence.length >= LIMITS.evidence) continue;
    const evidenceText = `${evidenceLabels[key]}: ${basis}`.slice(0, LIMITS.evidenceText);
    if (!updated.evidence.some((e) => e.kind === 'other' && e.ref === 'Consulta a la IA' && e.text === evidenceText)) {
      updated.evidence.push({ kind: 'other', ref: 'Consulta a la IA', text: evidenceText });
    }
  }
  const relativeCount = Number(formValue(form, 'rel_count')) || 0;
  const selectedRelatives: Array<{ i: number; name: string; type: string; direction: 'out' | 'in' }> = [];
  for (let i = 0; i < relativeCount; i++) {
    if (!(form.elements.namedItem(`rel_apply_${i}`) as HTMLInputElement | null)?.checked) continue;
    const name = formValue(form, `rel_name_${i}`).trim().slice(0, LIMITS.name);
    const type = formValue(form, `rel_type_${i}`).trim().slice(0, LIMITS.relationType);
    if (!name || !type) return fail('Completá «Con quién» y «Tipo de vínculo» en cada vínculo marcado.');
    selectedRelatives.push({ i, name, type, direction: formValue(form, `rel_dir_${i}`) === 'in' ? 'in' : 'out' });
  }
  const fieldChanges = changes.length;
  for (const relative of selectedRelatives) changes.push(`Vínculo: ${relative.name} (${relative.type})`);
  if (!changes.length) return fail('No hay datos marcados para aplicar.');
  try {

    if (fieldChanges) await api().saveCharacter(updated);
    let fresh = selectedRelatives.length ? await api().loadBookData(state.bookId) : null;
    let relations = fresh ? fresh.relations.filter((r) => r.bookId === state.bookId) : [];
    const relativeFailures: string[] = [];
    for (const relative of selectedRelatives) {
      try {
        const relativeName = normalizeText(relative.name);
        let other = fresh!.characters.find((c) => c.bookId === state.bookId && [c.name, ...c.aliases].some((candidate) => normalizeText(candidate) === relativeName));
        if (!other) {
          const now = new Date().toISOString();
          other = await api().saveCharacter({ id: crypto.randomUUID(), bookId: state.bookId, name: relative.name, aliases: [], age: formValue(form, `rel_age_${relative.i}`).trim().slice(0, LIMITS.age), description: formValue(form, `rel_description_${relative.i}`).trim().slice(0, LIMITS.description), traits: [], occupation: formValue(form, `rel_occupation_${relative.i}`).trim().slice(0, LIMITS.occupation), affiliation: '', comments: '', evidence: [], certainty: {}, createdAt: now, updatedAt: now });
          fresh!.characters.push(other);
        }
        const manual = Boolean(formValue(form, `rel_manual_${relative.i}`));
        const input = { fromId: relative.direction === 'out' ? character.id : other.id, toId: relative.direction === 'out' ? other.id : character.id, type: relative.type, description: formValue(form, `rel_note_${relative.i}`).trim().slice(0, LIMITS.relationDescription), certainty: (manual ? 'unknown' : 'inferred') as Certainty };
        const validation = validateRelation(input, { bookId: state.bookId, characters: fresh!.characters.filter((c) => c.bookId === state.bookId), relations });
        if (!validation.ok || !validation.value) { if (validation.errors.some((e) => !/duplicad|existe/i.test(e))) throw Error(validation.errors.join(' ')); else continue; }
        const basis = formValue(form, `rel_basis_${relative.i}`).trim();
        const record: CharacterRelation = { ...validation.value.record, evidence: basis ? [{ kind: 'other', ref: 'Consulta a la IA', text: basis.slice(0, LIMITS.evidenceText) }] : [] };
        await api().saveRelation(record);
        relations = [...relations, record];
      } catch (err: any) { relativeFailures.push(`${relative.name}: ${String(err?.message || err)}`); }
    }
    await reload();
    if (relativeFailures.length) return fail(`Algunos vínculos no se pudieron guardar: ${relativeFailures.join(' · ')}`);
    state.ai = null;
    state.notice = selectedRelatives.length ? 'Ficha actualizada y vínculos agregados.' : 'Ficha actualizada.';
    paint(true);
  } catch (err: any) { fail(String(err?.message || err)); }
}

export function syncAISaveForm() {
  const target = host?.querySelector<HTMLSelectElement>('#chrAiTarget');
  const wrap = host?.querySelector<HTMLElement>('#chrAiCertaintyWrap');
  if (target && wrap) wrap.classList.toggle('hidden', target.value !== 'field');
}

function suggestedRelativesHTML(text: string): string {
  try {
    const raw = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const relatives = JSON.parse(raw).relatives;
    if (!Array.isArray(relatives) || !relatives.length) return '<p class="muted">La IA no encontró vínculos con respaldo suficiente en el material consultado.</p>';
    return relatives.filter((r: any) => typeof r.name === 'string' && r.name.trim()).slice(0, 20).map((r: any, i: number) => `<label class="chr-form-field"><span class="chr-check-line"><input type="checkbox" data-relative-index="${i}" /> <span>${esc(r.name)} · ${esc(r.type || 'Familiar')} · certeza propuesta: ${esc(CERTAINTY_LABELS[r.certainty === 'explicit' ? 'explicit' : 'inferred'])}</span></span><small class="muted">${r.evidence ? `Respaldo sugerido: ${esc(String(r.evidence).slice(0, LIMITS.evidenceText))}` : 'La IA no indicó una fuente concreta; verificá este vínculo antes de agregarlo.'}</small></label>`).join('');
  } catch { return '<p class="muted">No se pudieron interpretar las propuestas de vínculos.</p>'; }
}

function suggestedNameHTML(text: string): string {
  try {
    const raw = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const suggestion = JSON.parse(raw);
    const name = typeof suggestion.nameSuggestion === 'string' ? suggestion.nameSuggestion.trim() : '';
    if (!name) return '';
    const basis = suggestion.nameSuggestionBasis;
    const explanation = basis === 'conocimiento_general'
      ? 'Sugerencia basada en el conocimiento general de la IA sobre la obra; no está verificada con tu ejemplar y no incluye información de la trama.'
      : suggestion.nameSuggestionEvidence
        ? `La IA la encontró en ${esc(suggestion.nameSuggestionEvidence)}. Revisá la fuente antes de usarla.`
        : 'La IA la propone como posible corrección; verificá el nombre antes de usarlo.';
    return `<div class="chr-name-suggestion" role="status"><strong>¿Quisiste decir «${esc(name)}»?</strong><p class="muted">${explanation}</p><button type="button" class="secondary" data-chr="use-name-suggestion" data-suggested-name="${esc(name)}">Usar «${esc(name)}»</button></div>`;
  } catch { return ''; }
}

export async function submitAISave(form: HTMLFormElement) {
  const ai = state.ai;
  const character = characterById(state.selectedId);
  if (!ai || !character) return;
  const errorBox = host?.querySelector<HTMLElement>('#chrAiSaveError');
  const fail = (message: string) => {
    if (errorBox) errorBox.textContent = message;
  };
  const options = {
    target: formValue(form, 'target') as SaveTarget,
    text: formValue(form, 'text'),
    certainty: formValue(form, 'certainty') as Certainty,
    field: ai.scope.kind === 'field' && ai.scope.field !== 'name' ? ai.scope.field : undefined,
  };
  try {
    let preview: string;
    let commit: () => Promise<void>;
    if (ai.scope.kind === 'relation') {
      const relations = pairRelations(ai);
      const chosen = relations.find((r) => r.id === formValue(form, 'relation')) ?? relations[0];
      if (!chosen) return fail('No hay un vínculo donde guardar la respuesta.');
      const updated = applyAnswerToRelation(chosen, options);
      preview = `Se modificará el vínculo «${chosen.type}»:\n\n${options.text.trim().slice(0, 600)}`;
      commit = async () => void (await api().saveRelation(updated));
    } else {
      const updated = applyAnswerToCharacter(character, options);
      preview = `Se modificará la ficha de ${character.name}:\n\n${options.text.trim().slice(0, 600)}`;
      commit = async () => void (await api().saveCharacter(updated));
    }
    if (!(ai.scope.kind === 'field' && options.target === 'field')) {
      const ok = await api().confirm({
        eyebrow: 'GUARDAR RESPUESTA DE LA IA',
        title: '¿Guardar en la ficha?',
        message: preview,
        confirmLabel: 'Guardar',
      });
      if (!ok) return;
    }
    await commit();
    await reload();
    state.ai = null;
    state.notice = 'Respuesta guardada en la ficha.';
    paint(true);
  } catch (err: any) {
    fail(String(err?.message || err));
  }
}

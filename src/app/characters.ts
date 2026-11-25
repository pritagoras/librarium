/**
 * Sección "Personajes" de cada libro: lista, tabla y red de relaciones, fichas editables,
 * vínculos entre personajes y consultas a la IA. La lógica pura (validación, IDs, respaldo,
 * contexto para la IA) vive en `characters-model.ts`; este módulo solo arma la interfaz,
 * maneja eventos y delega la persistencia y la IA en las dependencias que recibe de app.ts.
 */
import type {
  Book,
  Certainty,
  Character,
  CharacterFieldKey,
  CharacterRelation,
  Entry,
  EvidenceRef,
  Note,
  Quote,
} from '../types';
import {
  CERTAINTY_LABELS,
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  FIELD_KEYS,
  FIELD_LABELS,
  LIMITS,
  RELATION_TYPES,
  applyAnswerToCharacter,
  applyAnswerToRelation,
  buildCharacterAIRequest,
  isDirectedType,
  neighborsOf,
  removeCharacterCascade,
  searchCharacters,
  sortCharacters,
  validateCharacter,
  validateRelation,
  type AIRequestPlan,
  type AIScope,
  type CharacterInput,
  type SaveTarget,
} from './characters-model';

// ---------------------------------------------------------------------------
// Dependencias (las aporta app.ts)
// ---------------------------------------------------------------------------

export interface CharactersBookData {
  characters: Character[];
  relations: CharacterRelation[];
  notes: Note[];
  entries: Entry[];
  quotes: Quote[];
}

export interface CharactersDeps {
  loadBookData(bookId: string): Promise<CharactersBookData>;
  saveCharacter(character: Character): Promise<Character>;
  saveRelation(relation: CharacterRelation): Promise<CharacterRelation>;
  deleteCharacter(id: string): Promise<void>;
  deleteRelation(id: string): Promise<void>;
  confirm(options: {
    eyebrow?: string;
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    noticeOnly?: boolean;
  }): Promise<boolean>;
  ai: {
    hasKey(): boolean;
    /** Misma integración Gemini que el resto de la app (clave y modelo de las preferencias). */
    request(route: string, payload: Record<string, any>, signal?: AbortSignal): Promise<Response>;
    settings(): { model: string; thinking: string };
    styleInstruction(): string;
    openSettings(): void;
    isKeyError(error: unknown): boolean;
  };
  renderMarkdown?(text: string): string;
}

let deps: CharactersDeps | null = null;

export function initCharacters(dependencies: CharactersDeps) {
  deps = dependencies;
}

function api(): CharactersDeps {
  if (!deps) throw Error('El módulo de personajes no fue inicializado.');
  return deps;
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

type Mode = 'index' | 'sheet' | 'character-form' | 'relation-form';
type IndexView = 'list' | 'table' | 'network';

interface AIState {
  scope: AIScope;
  label: string;
  plan: AIRequestPlan | null;
  status: 'running' | 'done' | 'error';
  text: string;
  error: string;
  keyError: boolean;
  note: string;
  controller: AbortController | null;
  formTarget?: boolean;
}

interface State {
  bookId: string;
  mode: Mode;
  view: IndexView;
  query: string;
  selectedId: string | null;
  editingCharacterId: string | null;
  relationDraft: { fromId: string; editingId: string | null } | null;
  netFocus: string | null;
  netSelected: string | null;
  netIsolatedOnly: boolean;
  notice: string;
  ai: AIState | null;
  pendingRelatives: Array<{ name: string; type: string; direction: 'out' | 'in'; certainty: Certainty; evidence: string }>;
  characterSearch: { status: 'idle' | 'searching' | 'results' | 'error' | 'investigating' | 'ready'; name: string; candidates: Array<{ name: string; aliases: string[]; description: string; confidence: string }>; sources: Array<{ title: string; url: string }>; error: string; suggestion: any | null; controller: AbortController | null };
}

const emptyState = (bookId = ''): State => ({
  bookId,
  mode: 'index',
  view: 'list',
  query: '',
  selectedId: null,
  editingCharacterId: null,
  relationDraft: null,
  netFocus: null,
  netSelected: null,
  netIsolatedOnly: false,
  notice: '',
  ai: null,
  pendingRelatives: [],
  characterSearch: { status: 'idle', name: '', candidates: [], sources: [], error: '', suggestion: null, controller: null },
});

let state: State = emptyState();
let data: CharactersBookData = { characters: [], relations: [], notes: [], entries: [], quotes: [] };
let book: Book | null = null;
let host: HTMLElement | null = null;

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char),
  );

const AI_SPARK = '✦';

/** Verdadero mientras hay un formulario abierto o una consulta en curso: app.ts no debe repintar encima. */
export function isCharactersBusy(): boolean {
  return state.mode === 'character-form' || state.mode === 'relation-form' || state.ai?.status === 'running';
}

export async function purgeBookCharacters(bookId: string): Promise<void> {
  const bookData = await api().loadBookData(bookId);
  for (const relation of bookData.relations) await api().deleteRelation(relation.id);
  for (const character of bookData.characters) await api().deleteCharacter(character.id);
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

export async function renderCharactersPanel(container: HTMLElement, currentBook: Book): Promise<void> {
  if (state.bookId !== currentBook.id) {
    abortAI();
    state = emptyState(currentBook.id);
  }
  host = container;
  book = currentBook;
  await reload();
  paint();
}

async function reload() {
  const loaded = await api().loadBookData(state.bookId);
  data = {
    ...loaded,
    characters: sortCharacters(loaded.characters.filter((c) => c.bookId === state.bookId)),
    relations: loaded.relations.filter((r) => r.bookId === state.bookId),
  };
  // Relaciones huérfanas (por ejemplo, un personaje borrado desde otro dispositivo) no se muestran.
  const ids = new Set(data.characters.map((c) => c.id));
  data.relations = data.relations.filter((r) => ids.has(r.fromId) && ids.has(r.toId));
  if (state.selectedId && !ids.has(state.selectedId)) {
    state.selectedId = null;
    if (state.mode === 'sheet') state.mode = 'index';
  }
}

function characterById(id: string | null | undefined): Character | undefined {
  return data.characters.find((c) => c.id === id);
}

function go(mode: Mode, patch: Partial<State> = {}) {
  abortAI();
  state.characterSearch.controller?.abort();
  state = { ...state, ai: null, notice: '', ...patch, mode };
  paint(true);
}

function paint(focusHeading = false) {
  if (!host) return;
  let html = '';
  if (state.mode === 'index') html = indexHTML();
  else if (state.mode === 'sheet' && characterById(state.selectedId)) html = sheetHTML(characterById(state.selectedId)!);
  else if (state.mode === 'character-form') html = characterFormHTML();
  else if (state.mode === 'relation-form') html = relationFormHTML();
  else {
    state.mode = 'index';
    html = indexHTML();
  }
  host.innerHTML = `<div class="chr-root">${html}</div>`;
  bindEvents();
  if (state.mode === 'sheet') paintAI();
  if (focusHeading) host.querySelector<HTMLElement>('#chrHeading')?.focus({ preventScroll: false });
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

function certaintyBadge(certainty: Certainty | undefined): string {
  const value = certainty ?? 'unknown';
  return `<span class="chr-badge chr-badge--${value}">${esc(CERTAINTY_LABELS[value])}</span>`;
}

function relationCount(id: string): number {
  return neighborsOf(data.relations, id).length;
}

function indexHTML(): string {
  const views: Array<[IndexView, string]> = [['list', 'Lista'], ['table', 'Tabla'], ['network', 'Red']];
  return `<div class="content-heading">
      <div>
        <h2 id="chrHeading" tabindex="-1">Personajes</h2>
        <p class="muted">Fichas de los personajes de este libro y cómo se relacionan. Todo lo que cargues es tuyo: nada se completa solo, y la IA solo responde cuando se lo pedís.</p>
      </div>
      <div class="content-heading-actions">
        <button type="button" class="primary" data-chr="new">＋ Nuevo personaje</button>
      </div>
    </div>
    ${state.notice ? `<p class="chr-notice" role="status">${esc(state.notice)}</p>` : ''}
    <div class="chr-toolbar">
      <label class="chr-search">
        <span class="chr-sr-only">Buscar personajes</span>
        <input type="search" id="chrSearch" placeholder="Buscar por nombre, alias, rasgo u ocupación" value="${esc(state.query)}" autocomplete="off" />
      </label>
      <div class="chr-view-toggle" role="group" aria-label="Vista de personajes">
        ${views.map(([key, label]) => `<button type="button" data-chr="view" data-view="${key}" aria-pressed="${state.view === key}" class="${state.view === key ? 'active' : ''}">${label}</button>`).join('')}
      </div>
    </div>
    <div id="chrResults">${resultsHTML()}</div>`;
}

function resultsHTML(): string {
  if (state.view === 'network') return networkHTML();
  if (!data.characters.length) {
    return '<p class="empty-inline">Todavía no cargaste personajes de este libro. Creá la primera ficha con «＋ Nuevo personaje».</p>';
  }
  const found = searchCharacters(data.characters, state.query);
  if (!found.length) return '<p class="empty-inline" role="status">Ningún personaje coincide con la búsqueda.</p>';
  const count = `<p class="muted chr-count" role="status">${found.length} de ${data.characters.length} personaje${data.characters.length === 1 ? '' : 's'}</p>`;
  if (state.view === 'table') {
    return `${count}<div class="chr-table-wrap"><table class="chr-table">
      <caption class="chr-sr-only">Personajes del libro</caption>
      <thead><tr><th scope="col">Nombre</th><th scope="col">Edad</th><th scope="col">Ocupación</th><th scope="col">Pertenencia</th><th scope="col">Vínculos</th></tr></thead>
      <tbody>${found
        .map(
          (c) => `<tr>
        <th scope="row"><button type="button" class="chr-link" data-chr="open" data-id="${esc(c.id)}">${esc(c.name)}</button></th>
        <td>${esc(c.age) || '<span class="chr-unknown">—</span>'}</td>
        <td>${esc(c.occupation) || '<span class="chr-unknown">—</span>'}</td>
        <td>${esc(c.affiliation) || '<span class="chr-unknown">—</span>'}</td>
        <td>${relationCount(c.id)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  }
  return `${count}<ul class="chr-list">${found
    .map((c) => {
      const meta = [c.occupation, c.affiliation].filter(Boolean).join(' · ');
      const links = relationCount(c.id);
      return `<li><button type="button" class="chr-card" data-chr="open" data-id="${esc(c.id)}">
        <strong>${esc(c.name)}</strong>
        ${c.aliases.length ? `<span class="muted">También: ${esc(c.aliases.join(', '))}</span>` : ''}
        ${meta ? `<span class="muted">${esc(meta)}</span>` : ''}
        <span class="chr-card-links">${links} vínculo${links === 1 ? '' : 's'}</span>
      </button></li>`;
    })
    .join('')}</ul>`;
}

function fieldRow(character: Character, key: CharacterFieldKey): string {
  const value = character[key];
  return `<div class="chr-field">
    <dt>${FIELD_LABELS[key]}</dt>
    <dd>${
      value
        ? `<span class="chr-value">${esc(value)}</span> ${certaintyBadge(character.certainty[key])}`
        : '<span class="chr-unknown">Sin dato (desconocido)</span>'
    }</dd>
    <button type="button" class="chr-ai-btn" data-chr="ask" data-scope="field" data-field="${key}" aria-label="Preguntar a la IA por ${esc(FIELD_LABELS[key].toLowerCase())} de ${esc(character.name)}">${AI_SPARK}<span class="chr-sr-only"> Preguntar a la IA</span></button>
  </div>`;
}

function evidenceListHTML(items: EvidenceRef[]): string {
  if (!items.length) return '';
  return `<ul class="chr-evidence">${items
    .map(
      (ev) => `<li><strong>${esc(EVIDENCE_LABELS[ev.kind])}</strong>${ev.ref ? ` · ${/^https?:\/\//i.test(ev.ref) ? `<a href="${esc(ev.ref)}" target="_blank" rel="noopener noreferrer">${esc(ev.ref)}</a>` : esc(ev.ref)}` : ''}${ev.text ? `<br><span class="chr-quote">${/^https?:\/\//i.test(ev.text) ? `<a href="${esc(ev.text)}" target="_blank" rel="noopener noreferrer">${esc(ev.text)}</a>` : esc(ev.text)}</span>` : ''}</li>`,
    )
    .join('')}</ul>`;
}

function relationRowHTML(character: Character, relation: CharacterRelation): string {
  const otherId = relation.fromId === character.id ? relation.toId : relation.fromId;
  const other = characterById(otherId);
  if (!other) return '';
  const outgoing = relation.fromId === character.id;
  return `<li class="chr-relation">
    <div class="chr-relation-head">
      <span class="chr-type">${esc(relation.type)}</span>
      <button type="button" class="chr-link" data-chr="open" data-id="${esc(other.id)}" aria-label="Abrir la ficha de ${esc(other.name)}">${esc(outgoing ? `${character.name} → ${other.name}` : `${other.name} → ${character.name}`)}</button>
      ${certaintyBadge(relation.certainty)}
    </div>
    ${relation.description ? `<p class="chr-relation-text">${esc(relation.description)}</p>` : ''}
    ${evidenceListHTML(relation.evidence)}
    <div class="chr-row-actions">
      <button type="button" class="secondary" data-chr="open" data-id="${esc(other.id)}">Abrir ficha</button>
      <button type="button" class="secondary" data-chr="ask" data-scope="relation" data-other="${esc(other.id)}" data-rel="${esc(relation.id)}" aria-label="Preguntar a la IA por el vínculo con ${esc(other.name)}">${AI_SPARK} IA</button>
      <button type="button" class="secondary" data-chr="edit-relation" data-rel="${esc(relation.id)}">Editar</button>
      <button type="button" class="secondary" data-chr="remove-relation" data-rel="${esc(relation.id)}" aria-label="Quitar el vínculo con ${esc(other.name)}">Quitar</button>
    </div>
  </li>`;
}

function sheetHTML(character: Character): string {
  const links = neighborsOf(data.relations, character.id);
  const others = data.characters.filter((c) => c.id !== character.id);
  return `<p><button type="button" class="chr-back" data-chr="back">← Volver a personajes</button></p>
    <div class="content-heading">
      <div>
        <p class="eyebrow">FICHA DE PERSONAJE</p>
        <h2 id="chrHeading" tabindex="-1">${esc(character.name)}</h2>
        ${character.aliases.length ? `<p class="muted">También llamado: ${esc(character.aliases.join(', '))}</p>` : ''}
      </div>
      <div class="content-heading-actions">
        <button type="button" class="secondary" data-chr="ask" data-scope="character" aria-label="Preguntar a la IA sobre la ficha completa de ${esc(character.name)}">${AI_SPARK} Consultar la ficha con IA</button>
        <button type="button" class="secondary" data-chr="edit">Editar</button>
        <button type="button" class="danger-btn" data-chr="delete">Eliminar</button>
      </div>
    </div>
    ${state.notice ? `<p class="chr-notice" role="status">${esc(state.notice)}</p>` : ''}
    <div id="chrAiHost"></div>
    <section class="chr-section" aria-labelledby="chrFields">
      <h3 id="chrFields">Datos</h3>
      <dl class="chr-fields">
        <div class="chr-field">
          <dt>Nombre</dt>
          <dd><span class="chr-value">${esc(character.name)}</span></dd>
          <button type="button" class="chr-ai-btn" data-chr="ask" data-scope="field" data-field="name" aria-label="Preguntar a la IA por el nombre y los alias de ${esc(character.name)}">${AI_SPARK}<span class="chr-sr-only"> Preguntar a la IA</span></button>
        </div>
        ${FIELD_KEYS.map((key) => fieldRow(character, key)).join('')}
      </dl>
      ${character.traits.length ? `<p class="chr-traits"><span class="field-label">Rasgos</span> ${character.traits.map((t) => `<span class="chr-chip">${esc(t)}</span>`).join(' ')}</p>` : ''}
      ${character.comments ? `<div class="chr-comments"><span class="field-label">Comentarios y observaciones</span><p>${esc(character.comments)}</p></div>` : ''}
      ${character.evidence.length ? `<div><span class="field-label">Fuentes y evidencia</span>${evidenceListHTML(character.evidence)}</div>` : ''}
    </section>
    <section class="chr-section" aria-labelledby="chrRelations">
      <div class="chr-section-head">
        <h3 id="chrRelations">Vínculos (${links.length})</h3>
        <div class="chr-row-actions">
          <button type="button" class="secondary" data-chr="add-relation">＋ Agregar vínculo o familiar</button>
          <button type="button" class="secondary" data-chr="show-network" ${links.length ? '' : 'disabled'}>Ver en la red</button>
        </div>
      </div>
      ${others.length ? '' : '<p class="muted">Podés crear familiares y vínculos desde este botón.</p>'}
      ${links.length ? `<ul class="chr-relations">${links.map((n) => relationRowHTML(character, n.relation)).join('')}</ul>` : others.length ? '<p class="empty-inline">Todavía no registraste vínculos de este personaje.</p>' : ''}
      ${
        others.length
          ? `<div class="chr-pair">
        <label for="chrPairSelect">Consultar a la IA por el vínculo con otro personaje</label>
        <div class="chr-pair-row">
          <select id="chrPairSelect">${others.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
          <button type="button" class="secondary" data-chr="ask-pair">${AI_SPARK} Consultar vínculo</button>
        </div>
      </div>`
          : ''
      }
    </section>`;
}

// ---------------------------------------------------------------------------
// Red de relaciones
// ---------------------------------------------------------------------------

function mostConnected(): string | null {
  let best: { id: string; n: number } | null = null;
  for (const c of data.characters) {
    const n = relationCount(c.id);
    if (!best || n > best.n) best = { id: c.id, n };
  }
  return best?.id ?? null;
}

function layoutGlobalGraph() {
  const nodes = data.characters;
  const n = nodes.length;
  const size = Math.max(760, Math.ceil(150 * Math.sqrt(n)));
  const center = size / 2;
  const radius = Math.max(150, size * 0.38);
  const positions = new Map(nodes.map((c, i) => {
    const angle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
    return [c.id, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle), vx: 0, vy: 0 }];
  }));
  const edgeLength = Math.max(90, Math.min(170, size / Math.sqrt(Math.max(n, 1))));
  const iterations = Math.max(8, Math.min(100, Math.floor(250000 / Math.max(n * n, 1))));
  for (let step = 0; step < iterations; step++) {
    const list = nodes.map((c) => positions.get(c.id)!);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = list[i], b = list[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = Math.max(25, dx * dx + dy * dy), d = Math.sqrt(d2);
      const force = Math.min(2.5, (size * size) / (d2 * Math.max(n, 1)) * 0.018);
      a.vx += (dx / d) * force; a.vy += (dy / d) * force;
      b.vx -= (dx / d) * force; b.vy -= (dy / d) * force;
    }
    for (const relation of data.relations) {
      const a = positions.get(relation.fromId), b = positions.get(relation.toId);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
      const force = (d - edgeLength) * 0.002;
      a.vx += dx / d * force; a.vy += dy / d * force; b.vx -= dx / d * force; b.vy -= dy / d * force;
    }
    for (const p of list) {
      p.vx += (center - p.x) * 0.0007; p.vy += (center - p.y) * 0.0007;
      p.x += Math.max(-8, Math.min(8, p.vx)); p.y += Math.max(-8, Math.min(8, p.vy));
      p.vx *= 0.82; p.vy *= 0.82;
    }
  }
  return { positions, size };
}

function relationColor(type: string): string {
  const key = type.toLocaleLowerCase();
  if (/famili|madre|padre|hijo|herman|abuelo|nieto|tio|sobrino|primo/.test(key)) return '#fb923c';
  if (/amistad/.test(key)) return '#34d399';
  if (/alianza/.test(key)) return '#38bdf8';
  if (/rival/.test(key)) return '#fb7185';
  if (/rom[aá]nt/.test(key)) return '#e879f9';
  if (/mentor/.test(key)) return '#a78bfa';
  if (/labor/.test(key)) return '#22d3ee';
  let hash = 0; for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 76% 62%)`;
}

function networkHTML(): string {
  if (!data.characters.length) return '<p class="empty-inline">Cargá personajes y vínculos para ver la red de relaciones.</p>';
  if (!characterById(state.netFocus)) state.netFocus = characterById(state.selectedId)?.id ?? mostConnected();
  const focusId = state.netFocus!;
  const { positions, size } = layoutGlobalGraph();
  const selected = characterById(state.netSelected);
  const isolated = data.characters.filter((c) => relationCount(c.id) === 0).length;
  const connected = data.characters.length - isolated;
  const edgeSvg = data.relations.map((r) => {
    const a = positions.get(r.fromId), b = positions.get(r.toId);
    if (!a || !b) return '';
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const bend = ((r.id.charCodeAt(4) || 7) % 2 ? 1 : -1) * 18;
    const cx = mx + bend, cy = my - bend;
    const dashed = r.certainty === 'explicit' ? '' : ' stroke-dasharray="7 6"';
    return `<path class="chr-edge chr-edge--color${state.netIsolatedOnly ? ' chr-edge--filtered' : ''}" d="M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}" stroke="${relationColor(r.type)}"${dashed}><title>${esc(characterById(r.fromId)?.name)} → ${esc(characterById(r.toId)?.name)} · ${esc(r.type)} · ${esc(CERTAINTY_LABELS[r.certainty])}</title></path>`;
  }).join('');
  const nodesSvg = data.characters.map((c, i) => {
    const p = positions.get(c.id)!;
    const focus = c.id === focusId;
    const isolatedClass = relationCount(c.id) === 0 ? ' chr-node--isolated' : '';
    const label = c.name.length > 18 ? `${c.name.slice(0, 17)}…` : c.name;
    const hue = (i * 47 + 195) % 360;
    return `<g class="chr-node chr-node--global${focus ? ' chr-node--focus' : ''}${c.id === state.netSelected ? ' chr-node--selected' : ''}${isolatedClass}${state.netIsolatedOnly && relationCount(c.id) ? ' chr-node--filtered' : ''}" data-chr="net-select" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.name)}, ${relationCount(c.id)} vínculos"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${focus ? 36 : 29}" style="--node-hue:${hue}"></circle><text x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle">${esc(label)}</text></g>`;
  }).join('');
  const types = [...new Set(data.relations.map((r) => r.type))];
  const allGroups = buildConnectedGroups(data.characters, data.relations);
  const detail = selected ? `<aside class="chr-net-details"><strong>${esc(selected.name)}</strong><span>${relationCount(selected.id)} vínculos · ${isolated && relationCount(selected.id) === 0 ? 'personaje aislado' : `grupo ${allGroups.findIndex((g) => g.includes(selected.id)) + 1}`}</span><div class="chr-row-actions"><button type="button" class="secondary" data-chr="open" data-id="${esc(selected.id)}">Abrir ficha</button><button type="button" class="secondary" data-chr="net-center" data-id="${esc(selected.id)}">Centrar y elegir</button><button type="button" class="secondary" data-chr="add-relation">＋ Agregar vínculo</button></div>${data.relations.filter((r) => r.fromId === selected.id || r.toId === selected.id).map((r) => `<div class="chr-net-rel"><span class="chr-net-dot" style="--edge-color:${relationColor(r.type)}"></span>${esc(characterById(r.fromId)?.name)} ${isDirectedType(r.type) ? '→' : '↔'} ${esc(characterById(r.toId)?.name)} · ${esc(r.type)} <button type="button" class="secondary" data-chr="edit-relation" data-rel="${esc(r.id)}">Editar</button></div>`).join('')}</aside>` : '<p class="muted">Seleccioná cualquier personaje para abrir su ficha o administrar vínculos.</p>';
  return `<div class="chr-network chr-network--global"><div class="chr-network-header"><div><h3>Universo de personajes</h3><p>${data.characters.length} personajes · ${data.relations.length} vínculos · ${allGroups.length} grupos · ${isolated} aislados</p></div><label for="chrNetFocus">Centrar en<select id="chrNetFocus">${data.characters.map((c) => `<option value="${esc(c.id)}" ${c.id === focusId ? 'selected' : ''}>${esc(c.name)} (${relationCount(c.id)})</option>`).join('')}</select></label><button type="button" class="secondary" data-chr="fullscreen-network">⛶ Pantalla completa</button></div><div class="chr-net-stats"><button type="button" data-chr="filter-isolated" aria-pressed="${state.netIsolatedOnly}">${isolated} aislados</button><span>${connected} conectados</span><span>${allGroups.length} grupos independientes</span></div><div class="chr-net-canvas"><svg class="chr-svg chr-svg--global" viewBox="0 0 ${size} ${size}" role="group" aria-label="Mapa global con todos los personajes y vínculos">${edgeSvg}${nodesSvg}</svg></div><div class="chr-net-legend">${types.map((type) => `<span><i style="--edge-color:${relationColor(type)}"></i>${esc(type)}</span>`).join('')}<span><i class="chr-net-certainty"></i>Línea continua: explícita · discontinua: inferida o desconocida</span></div>${detail}</div>`;
}

function buildConnectedGroups(characters: Character[], relations: CharacterRelation[]): string[][] {
  const remaining = new Set(characters.map((c) => c.id));
  const groups: string[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value as string;
    const group: string[] = [], queue = [first]; remaining.delete(first);
    while (queue.length) {
      const id = queue.shift()!; group.push(id);
      for (const neighbor of neighborsOf(relations, id)) if (remaining.delete(neighbor.other)) queue.push(neighbor.other);
    }
    groups.push(group);
  }
  return groups;
}


// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------

function certaintySelectHTML(name: string, value: Certainty | undefined, options: { allowUnknown?: boolean; required?: boolean } = {}): string {
  const list: Certainty[] = options.allowUnknown ? ['explicit', 'inferred', 'unknown'] : ['explicit', 'inferred'];
  return `<select name="${name}" aria-label="Certeza del dato"${options.required ? ' required' : ''}>
    ${options.allowUnknown ? '' : `<option value="">Elegí si es explícito o inferido…</option>`}
    ${list.map((c) => `<option value="${c}" ${value === c ? 'selected' : ''}>${CERTAINTY_LABELS[c]}</option>`).join('')}
  </select>`;
}

function evidenceRowHTML(ev: EvidenceRef = { kind: 'page', ref: '', text: '' }): string {
  return `<div class="chr-evidence-row">
    <select data-f="kind" aria-label="Tipo de fuente">${EVIDENCE_KINDS.map((k) => `<option value="${k}" ${ev.kind === k ? 'selected' : ''}>${EVIDENCE_LABELS[k]}</option>`).join('')}</select>
    <input data-f="ref" type="text" maxlength="${LIMITS.evidenceRef}" placeholder="Página, capítulo o número" aria-label="Referencia de la fuente" value="${esc(ev.ref)}" />
    <input data-f="text" type="text" maxlength="${LIMITS.evidenceText}" placeholder="Cita o nota (opcional)" aria-label="Texto de la fuente" value="${esc(ev.text)}" />
    <button type="button" class="secondary" data-chr="remove-evidence" aria-label="Quitar esta fuente">✕</button>
  </div>`;
}

function evidenceEditorHTML(items: EvidenceRef[]): string {
  return `<fieldset class="chr-fieldset"><legend>Fuentes o evidencia</legend>
    <div id="chrEvidenceRows">${items.map((ev) => evidenceRowHTML(ev)).join('')}</div>
    <button type="button" class="secondary" data-chr="add-evidence">＋ Agregar fuente</button>
  </fieldset>`;
}

function characterFormHTML(): string {
  const editing = characterById(state.editingCharacterId);
  const c: Character | undefined = editing;
  const fieldBlock = (key: CharacterFieldKey, multiline: boolean) => `<div class="chr-form-field">
      <label for="chr_${key}">${FIELD_LABELS[key]}</label>
      ${
        multiline
          ? `<textarea id="chr_${key}" name="${key}" maxlength="${LIMITS[key]}">${esc(c?.[key] ?? '')}</textarea>`
          : `<input id="chr_${key}" name="${key}" type="text" maxlength="${LIMITS[key]}" value="${esc(c?.[key] ?? '')}" />`
      }
      ${certaintySelectHTML(`cert_${key}`, c?.certainty[key])}
    </div>`;
  return `<p><button type="button" class="chr-back" data-chr="cancel">← Cancelar</button></p>
    <h2 id="chrHeading" tabindex="-1">${editing ? `Editar a ${esc(editing.name)}` : 'Nuevo personaje'}</h2>
    <p class="muted">Dejá en blanco lo que no sepas: un campo vacío queda como «desconocido». Si cargás un dato, indicá si el libro lo dice de forma explícita o si lo inferís vos.</p>
    <form id="chrCharacterForm" class="chr-form" novalidate>
      <div class="chr-errors" id="chrFormErrors" role="alert" aria-live="assertive"></div>
      <div class="chr-form-field">
        <label for="chr_name">Nombre</label>
        <input id="chr_name" name="name" type="text" maxlength="${LIMITS.name}" required value="${esc(c?.name ?? '')}" />
        <div class="chr-research-actions"><button type="button" class="secondary" data-chr="search-character">${AI_SPARK} Buscar y completar con IA</button><span class="muted">La búsqueda web se ejecuta al presionar el botón; modo sin spoilers activado (p. ${Math.max(0, Number(book?.currentPage) || 0)}).</span></div>
      </div>
      ${characterSearchHTML()}
      <div id="chrAiHost"></div>
      <div class="chr-form-field">
        <label for="chr_aliases">Otros nombres o alias (uno por línea)</label>
        <textarea id="chr_aliases" name="aliases">${esc((c?.aliases ?? []).join('\n'))}</textarea>
      </div>
      ${fieldBlock('age', false)}
      ${fieldBlock('description', true)}
      <div class="chr-form-field">
        <label for="chr_traits">Rasgos (separados por coma)</label>
        <input id="chr_traits" name="traits" type="text" value="${esc((c?.traits ?? []).join(', '))}" />
      </div>
      ${fieldBlock('occupation', false)}
      ${fieldBlock('affiliation', false)}
      <div class="chr-form-field">
        <label for="chr_comments">Comentarios y observaciones personales</label>
        <textarea id="chr_comments" name="comments" maxlength="${LIMITS.comments}">${esc(c?.comments ?? '')}</textarea>
      </div>
      ${evidenceEditorHTML(c?.evidence ?? [])}
      <div class="chr-form-actions">
        <button type="submit" class="primary">${editing ? 'Guardar cambios' : 'Crear ficha'}</button>
        <button type="button" class="secondary" data-chr="cancel">Cancelar</button>
      </div>
    </form>`;
}

function characterSearchHTML(): string {
  const search = state.characterSearch;
  if (search.status === 'idle') return '<div id="chrResearchPanel"></div>';
  if (search.status === 'searching' || search.status === 'investigating') return `<section class="chr-research" id="chrResearchPanel" aria-live="polite"><strong>${search.status === 'searching' ? 'Buscando en Internet…' : 'Investigando el personaje seleccionado…'}</strong><p class="muted">Obra: ${esc(book?.title || '')}${book?.author ? ` · ${esc(book.author)}` : ''}. Avance registrado: página ${Math.max(0, Number(book?.currentPage) || 0)}. Modo sin spoilers.</p><button type="button" class="secondary" data-chr="stop-research">Cancelar búsqueda</button></section>`;
  if (search.status === 'error') return `<section class="chr-research" id="chrResearchPanel" role="alert"><strong>No pude realizar la búsqueda web.</strong><p>${esc(search.error)}</p><button type="button" class="secondary" data-chr="search-character">Intentar de nuevo</button></section>`;
  if (search.status === 'results') return `<section class="chr-research" id="chrResearchPanel"><h3>${search.candidates.length ? 'Encontré posibles coincidencias' : 'No encontré coincidencias suficientemente confiables'}</h3><p class="muted">Resultados para «${esc(search.name)}» en ${esc(book?.title || 'esta obra')}${book?.author ? ` de ${esc(book.author)}` : ''}. Avance: página ${Math.max(0, Number(book?.currentPage) || 0)}. La descripción se limita a identificación sin spoilers; las fuentes web no corresponden necesariamente a las páginas de tu edición.</p>${search.candidates.length ? `${search.candidates.length > 1 ? '<p class="chr-ambiguity" role="status">La búsqueda devolvió varias coincidencias posibles. Elegí la que corresponde; no se seleccionó ninguna automáticamente.</p>' : ''}<fieldset class="chr-candidates"><legend>Elegí explícitamente el personaje</legend>${search.candidates.map((c, i) => `<label class="chr-candidate"><input type="radio" name="chrCandidate" value="${i}"/><span><strong>${esc(c.name)}</strong><span>También: ${esc(c.aliases.join(', ') || 'sin variantes encontradas')}</span><span>${esc(c.description || 'Sin descripción introductoria disponible.')}</span><small>Coincidencia ${esc(c.confidence === 'high' ? 'alta' : c.confidence === 'medium' ? 'media' : 'baja')}</small></span></label>`).join('')}</fieldset><button type="button" class="primary" data-chr="investigate-character" disabled>Completar con este</button>` : '<p class="muted">La búsqueda devolvió resultados ambiguos o sin respaldo suficiente. Podés conservar el nombre y completar la ficha manualmente.</p>'}<button type="button" class="secondary" data-chr="none-candidate">Ninguno de estos</button>${characterSourcesHTML(search.sources)}</section>`;
  if (search.status === 'ready') return `<section class="chr-research" id="chrResearchPanel"><h3>Seleccionaste «${esc(search.name)}»</h3><p class="muted">Revisá las sugerencias. Solo se completarán campos vacíos; los campos que ya escribiste se conservan. La información web se marca como inferida, nunca explícita en el libro.</p>${characterSourcesHTML(search.sources)}<button type="button" class="primary" data-chr="apply-research">Aplicar sugerencias a campos vacíos</button><button type="button" class="secondary" data-chr="none-candidate">Descartar sugerencias</button></section>`;
  return '<div id="chrResearchPanel"></div>';
}

function characterSourcesHTML(sources: Array<{ title: string; url: string }>): string {
  if (!sources.length) return '<p class="muted">Gemini no proporcionó citas web verificables.</p>';
  return `<details class="chr-research-sources"><summary>Fuentes web consultadas (${sources.length})</summary><ul>${sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a></li>`).join('')}</ul></details>`;
}

function readReadingEvidence() {
  const page = Math.max(0, Number(book?.currentPage) || 0);
  const normalize = (text: string) => text.toLocaleLowerCase();
  const names = new Set([state.characterSearch.name, ...data.characters.flatMap((c) => [c.name, ...c.aliases])].map(normalize).filter((x) => x.length > 2));
  const containsName = (text: string) => [...names].some((name) => normalize(text).includes(name));
  const records: string[] = [];
  for (const note of data.notes) if (note.endPage != null && note.endPage <= page && containsName(`${note.text} ${note.comment || ''}`)) records.push(`[Cuaderno: nota ${note.number}, p. ${note.endPage}] ${note.text}${note.comment ? ` — comentario: ${note.comment}` : ''}`);
  for (const entry of data.entries) if (entry.page != null && entry.page <= page && containsName(`${entry.title || ''} ${entry.text || ''} ${entry.comment || ''}`)) records.push(`[Cuaderno: anotación, p. ${entry.page}] ${entry.title || ''} ${entry.text || ''}${entry.comment ? ` — comentario: ${entry.comment}` : ''}`);
  for (const quote of data.quotes) if (quote.page != null && quote.page <= page && containsName(`${quote.text} ${quote.analysis || ''}`)) records.push(`[Cuaderno: cita, p. ${quote.page}] ${quote.text}${quote.analysis ? ` — reflexión: ${quote.analysis}` : ''}`);
  return records.slice(0, 40);
}

async function searchCharacterWithWeb() {
  const name = host?.querySelector<HTMLInputElement>('#chr_name')?.value.trim() || '';
  if (!name) return showFormErrors(['Escribí el nombre antes de buscar coincidencias.']);
  if (!api().ai.hasKey()) return showFormErrors(['Guardá tu API key personal de Gemini en Ajustes → Ajustes de IA.']);
  state.characterSearch.controller?.abort();
  const search = state.characterSearch = { ...state.characterSearch, status: 'searching', name, candidates: [], sources: [], error: '', suggestion: null, controller: new AbortController() };
  paint();
  try {
    const settings = api().ai.settings();
    const response = await api().ai.request('character-research', { mode: 'candidates', name, book, characters: data.characters, model: settings.model, thinking: settings.thinking }, search.controller.signal);
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `Error HTTP ${response.status}`);
    if (result.usedGoogleSearch !== true) throw Error('Gemini no confirmó que ejecutó Google Search.');
    state.characterSearch = { ...state.characterSearch, status: 'results', candidates: Array.isArray(result.candidates) ? result.candidates : [], sources: Array.isArray(result.sources) ? result.sources : [], error: '', controller: null };
  } catch (err: any) {
    if (err?.name === 'AbortError') { state.characterSearch = { ...state.characterSearch, status: 'idle', controller: null }; paint(); return; }
    state.characterSearch = { ...state.characterSearch, status: 'error', error: String(err?.message || err), controller: null };
  }
  paint();
}

async function investigateSelectedCharacter() {
  const index = Number(host?.querySelector<HTMLInputElement>('input[name="chrCandidate"]:checked')?.value);
  const selected = state.characterSearch.candidates[index];
  if (!selected) return showFormErrors(['Elegí explícitamente una coincidencia antes de continuar.']);
  const search = state.characterSearch;
  const controller = new AbortController();
  state.characterSearch = { ...search, status: 'investigating', name: selected.name, controller };
  paint();
  try {
    const settings = api().ai.settings();
    const response = await api().ai.request('character-research', { mode: 'investigate', name: selected.name, aliases: selected.aliases, book, characters: data.characters, readingEvidence: readReadingEvidence(), model: settings.model, thinking: settings.thinking }, controller.signal);
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `Error HTTP ${response.status}`);
    if (result.usedGoogleSearch !== true) throw Error('Gemini no confirmó que ejecutó Google Search.');
    state.characterSearch = { ...state.characterSearch, status: 'ready', name: selected.name, sources: result.sources || [], suggestion: result.suggestion || {}, controller: null };
  } catch (err: any) {
    if (err?.name === 'AbortError') state.characterSearch = { ...state.characterSearch, status: 'idle', controller: null };
    else state.characterSearch = { ...state.characterSearch, status: 'error', error: String(err?.message || err), controller: null };
  }
  paint();
}

function applyWebResearch() {
  const suggestion = state.characterSearch.suggestion;
  if (!suggestion) return;
  const setEmpty = (name: string, value: unknown, transform = (x: any) => String(x ?? '')) => {
    const field = host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    if (field && !field.value.trim()) field.value = transform(value);
  };
  const nameInput = host?.querySelector<HTMLInputElement>('[name="name"]');
  if (nameInput && suggestion.name) nameInput.value = String(suggestion.name);
  setEmpty('aliases', suggestion.aliases, (x) => Array.isArray(x) ? x.join('\n') : '');
  setEmpty('age', suggestion.age);
  setEmpty('description', suggestion.description);
  setEmpty('traits', suggestion.traits, (x) => Array.isArray(x) ? x.join(', ') : '');
  setEmpty('occupation', suggestion.occupation);
  setEmpty('affiliation', suggestion.affiliation);
  for (const field of FIELD_KEYS) {
    const input = host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${field}"]`);
    const certainty = host?.querySelector<HTMLSelectElement>(`[name="cert_${field}"]`);
    if (input?.value.trim() && !certainty?.value && suggestion[field]) certainty.value = 'inferred';
  }
  const evidenceRows = host?.querySelector<HTMLElement>('#chrEvidenceRows');
  for (const source of state.characterSearch.sources) {
    if (evidenceRows && source.url.length <= LIMITS.evidenceText && evidenceRows.children.length < LIMITS.evidence) evidenceRows.insertAdjacentHTML('beforeend', evidenceRowHTML({ kind: 'other', ref: source.url.length <= LIMITS.evidenceRef ? source.url : `Fuente web: ${source.title}`.slice(0, LIMITS.evidenceRef), text: source.url.length <= LIMITS.evidenceRef ? `Fuente web externa: ${source.title}`.slice(0, LIMITS.evidenceText) : source.url }));
  }
  showFormErrors([], ['Se completaron únicamente campos vacíos. Los datos web quedan como inferidos; revisá cada fuente.']);
}

function relationFormHTML(): string {
  const draft = state.relationDraft;
  const from = characterById(draft?.fromId);
  if (!draft || !from) return indexHTML();
  const editing = draft.editingId ? data.relations.find((r) => r.id === draft.editingId) : undefined;
  const otherId = editing ? (editing.fromId === from.id ? editing.toId : editing.fromId) : '';
  const others = data.characters.filter((c) => c.id !== from.id);
  const usedTypes = [...new Set(data.relations.map((r) => r.type))].filter((t) => !(RELATION_TYPES as readonly string[]).includes(t));
  return `<p><button type="button" class="chr-back" data-chr="cancel">← Cancelar</button></p>
    <h2 id="chrHeading" tabindex="-1">${editing ? 'Editar vínculo' : 'Nuevo vínculo'} de ${esc(from.name)}</h2>
    <form id="chrRelationForm" class="chr-form" novalidate>
      <div class="chr-errors" id="chrFormErrors" role="alert" aria-live="assertive"></div>
      <div class="chr-form-field">
        <label for="chr_other">Otro personaje</label>
        <select id="chr_other" name="other" ${editing ? 'disabled' : ''}>
          <option value="" ${!otherId ? 'selected' : ''}>Elegir personaje…</option>
          ${others.map((c) => `<option value="${esc(c.id)}" ${c.id === otherId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          ${editing ? '' : '<option value="__new__">＋ Crear familiar nuevo…</option>'}
        </select>
      </div>
      ${editing ? '' : `<div class="chr-form-field"><label><input type="checkbox" id="chrMultiRelation" /> Crear este vínculo con varios personajes</label><fieldset id="chrMultiTargets" class="chr-fieldset hidden"><legend>Seleccioná los personajes</legend>${others.map((c) => `<label><input type="checkbox" name="multiOther" value="${esc(c.id)}" /> ${esc(c.name)}</label>`).join('')}</fieldset></div>`}
      ${!editing ? `<div class="chr-form-field hidden" id="chrNewRelativeWrap"><label for="chr_new_relative">Nombre del familiar</label><input id="chr_new_relative" name="newRelative" type="text" maxlength="${LIMITS.name}" /></div>` : ''}
      <div class="chr-form-field">
        <label for="chr_direction">Sentido del vínculo</label>
        <select id="chr_direction" name="direction">
          <option value="out" ${!editing || editing.fromId === from.id ? 'selected' : ''}>${esc(from.name)} → otro personaje</option>
          <option value="in" ${editing && editing.fromId !== from.id ? 'selected' : ''}>otro personaje → ${esc(from.name)}</option>
        </select>
        <small class="muted">Solo importa en vínculos con sentido, como Mentoría (quien enseña → quien aprende).</small>
      </div>
      <div class="chr-form-field">
        <label for="chr_type">Tipo de vínculo</label>
        <input id="chr_type" name="type" type="text" list="chrTypes" maxlength="${LIMITS.relationType}" required value="${esc(editing?.type ?? '')}" placeholder="Familiar, amistad, rivalidad, alianza, mentoría u otro" />
        <datalist id="chrTypes">${[...RELATION_TYPES, ...usedTypes].map((t) => `<option value="${esc(t)}"></option>`).join('')}</datalist>
      </div>
      <div class="chr-form-field">
        <label for="chr_rel_description">Descripción o comentario del vínculo</label>
        <textarea id="chr_rel_description" name="description" maxlength="${LIMITS.relationDescription}">${esc(editing?.description ?? '')}</textarea>
      </div>
      <div class="chr-form-field">
        <label for="chr_rel_certainty">Certeza del vínculo</label>
        ${certaintySelectHTML('certainty', editing?.certainty ?? 'unknown', { allowUnknown: true })}
      </div>
      ${evidenceEditorHTML(editing?.evidence ?? [])}
      <div class="chr-form-actions">
        <button type="submit" class="primary">${editing ? 'Guardar cambios' : 'Crear vínculo'}</button>
        <button type="button" class="secondary" data-chr="cancel">Cancelar</button>
      </div>
    </form>`;
}

function readEvidence(form: HTMLElement): EvidenceRef[] {
  return [...form.querySelectorAll<HTMLElement>('.chr-evidence-row')].map((row) => ({
    kind: (row.querySelector<HTMLSelectElement>('[data-f=kind]')!.value || 'other') as EvidenceRef['kind'],
    ref: row.querySelector<HTMLInputElement>('[data-f=ref]')!.value,
    text: row.querySelector<HTMLInputElement>('[data-f=text]')!.value,
  }));
}

function formValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return el ? el.value : '';
}

function showFormErrors(errors: string[], warnings: string[] = []) {
  const box = host?.querySelector<HTMLElement>('#chrFormErrors');
  if (!box) return;
  box.innerHTML = errors.length
    ? `<ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
    : warnings.length
      ? `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
      : '';
  if (errors.length) box.scrollIntoView({ block: 'nearest' });
}

async function submitCharacterForm(form: HTMLFormElement) {
  const editing = characterById(state.editingCharacterId);
  const certainty: CharacterInput['certainty'] = {};
  for (const key of FIELD_KEYS) {
    const value = formValue(form, `cert_${key}`);
    if (value === 'explicit' || value === 'inferred') certainty[key] = value;
  }
  const input: CharacterInput = {
    id: editing?.id,
    name: formValue(form, 'name'),
    aliases: formValue(form, 'aliases').split(/\n|;/),
    age: formValue(form, 'age'),
    description: formValue(form, 'description'),
    traits: formValue(form, 'traits').split(/[,;\n]/),
    occupation: formValue(form, 'occupation'),
    affiliation: formValue(form, 'affiliation'),
    comments: formValue(form, 'comments'),
    evidence: readEvidence(form),
    certainty,
  };
  const result = validateCharacter(input, { bookId: state.bookId, existing: data.characters, editingId: editing?.id });
  if (!result.ok || !result.value) {
    showFormErrors(result.errors);
    return;
  }
  try {
    const saved = await api().saveCharacter({ ...result.value, userId: editing?.userId, createdAt: editing?.createdAt });
    await reload();
    let relativeCount = 0;
    for (const suggestion of state.pendingRelatives) {
      let relative = data.characters.find((c) => c.name.trim().toLowerCase() === suggestion.name.trim().toLowerCase());
      if (!relative) {
        const created = validateCharacter({ name: suggestion.name }, { bookId: state.bookId, existing: data.characters });
        if (!created.ok || !created.value) continue;
        relative = await api().saveCharacter(created.value);
        data.characters.push(relative);
      }
      const relation = validateRelation({
        fromId: suggestion.direction === 'out' ? saved.id : relative.id,
        toId: suggestion.direction === 'out' ? relative.id : saved.id,
        type: suggestion.type,
        description: '', evidence: suggestion.evidence ? [{ kind: 'other', ref: 'Fuente sugerida por IA', text: suggestion.evidence.slice(0, LIMITS.evidenceText) }] : [], certainty: suggestion.certainty,
      }, { bookId: state.bookId, characters: data.characters, relations: data.relations });
      if (relation.ok && relation.value) {
        await api().saveRelation(relation.value.record);
        relativeCount++;
      }
    }
    state.pendingRelatives = [];
    await reload();
    go('sheet', {
      selectedId: saved.id,
      editingCharacterId: null,
      notice: [editing ? 'Ficha actualizada.' : 'Ficha creada.', relativeCount ? `Se guardaron ${relativeCount} vínculo(s) familiar(es) seleccionados.` : '', ...result.warnings].filter(Boolean).join(' '),
    });
  } catch (err: any) {
    showFormErrors([`No se pudo guardar: ${err?.message || err}`]);
  }
}

async function submitRelationForm(form: HTMLFormElement) {
  const draft = state.relationDraft;
  if (!draft) return;
  const editing = draft.editingId ? data.relations.find((r) => r.id === draft.editingId) : undefined;
  if (!editing && form.querySelector<HTMLInputElement>('#chrMultiRelation')?.checked) {
    const targets = [...form.querySelectorAll<HTMLInputElement>('input[name="multiOther"]:checked')].map((input) => input.value);
    if (!targets.length) return showFormErrors(['Seleccioná al menos un personaje para crear los vínculos.']);
    const outgoing = formValue(form, 'direction') !== 'in';
    const proposed = targets.map((otherId) => validateRelation({
      fromId: outgoing ? draft.fromId : otherId, toId: outgoing ? otherId : draft.fromId,
      type: formValue(form, 'type'), description: formValue(form, 'description'), evidence: readEvidence(form),
      certainty: (formValue(form, 'certainty') || 'unknown') as Certainty,
    }, { bookId: state.bookId, characters: data.characters, relations: data.relations }));
    const errors = proposed.flatMap((r, i) => r.ok ? [] : [`${characterById(targets[i])?.name || 'Personaje'}: ${r.errors.join(' ')}`]);
    if (errors.length) return showFormErrors(errors);
    const records = proposed.flatMap((r) => r.value ? [r.value.record] : []);
    const approved = await api().confirm({ eyebrow: 'VÍNCULOS MÚLTIPLES', title: `Crear ${records.length} vínculos`, message: records.map((r) => `${characterById(r.fromId)?.name} → ${r.type} → ${characterById(r.toId)?.name}`).join('\n'), confirmLabel: 'Crear vínculos' });
    if (!approved) return;
    let saved = 0;
    const failures: string[] = [];
    for (const record of records) {
      try {
        const fresh = await api().loadBookData(state.bookId);
        const validAgain = validateRelation(record, { bookId: state.bookId, characters: fresh.characters, relations: fresh.relations });
        if (!validAgain.ok || !validAgain.value) throw Error(validAgain.errors.join(' '));
        await api().saveRelation(validAgain.value.record);
        saved++;
      } catch (err: any) { failures.push(`${characterById(record.toId)?.name || record.toId}: ${String(err?.message || err)}`); }
    }
    await reload();
    go('sheet', { selectedId: draft.fromId, relationDraft: null, notice: `Se guardaron ${saved} de ${records.length} vínculos.${failures.length ? ` No se guardaron: ${failures.join('; ')}` : ''}` });
    return;
  }
  let otherId = editing ? (editing.fromId === draft.fromId ? editing.toId : editing.fromId) : formValue(form, 'other');
  let createdRelative: Character | null = null;
  if (otherId === '__new__') {
    const name = formValue(form, 'newRelative').trim();
    if (!name) return showFormErrors(['Escribí el nombre del familiar.']);
    const characterResult = validateCharacter({ name }, { bookId: state.bookId, existing: data.characters });
    if (!characterResult.ok || !characterResult.value) return showFormErrors(characterResult.errors);
    try {
      createdRelative = await api().saveCharacter(characterResult.value);
      otherId = createdRelative.id;
    } catch (err: any) {
      return showFormErrors([`No se pudo crear el familiar: ${err?.message || err}`]);
    }
  }
  const outgoing = formValue(form, 'direction') !== 'in';
  const result = validateRelation(
    {
      fromId: outgoing ? draft.fromId : otherId,
      toId: outgoing ? otherId : draft.fromId,
      type: formValue(form, 'type'),
      description: formValue(form, 'description'),
      evidence: readEvidence(form),
      certainty: (formValue(form, 'certainty') || 'unknown') as Certainty,
    },
    { bookId: state.bookId, characters: data.characters, relations: data.relations, editing },
  );
  if (!result.ok || !result.value) {
    showFormErrors(result.errors);
    return;
  }
  try {
    await api().saveRelation(result.value.record);
    if (result.value.replacesId) await api().deleteRelation(result.value.replacesId);
    await reload();
    go('sheet', { selectedId: draft.fromId, relationDraft: null, notice: editing ? 'Vínculo actualizado.' : 'Vínculo creado.' });
  } catch (err: any) {
    showFormErrors([`${createdRelative ? `Se creó «${createdRelative.name}», pero ` : ''}no se pudo guardar el vínculo: ${err?.message || err}`]);
  }
}

// ---------------------------------------------------------------------------
// IA
// ---------------------------------------------------------------------------

function abortAI() {
  state.ai?.controller?.abort();
}

function scopeLabel(character: Character, scope: AIScope): string {
  if (scope.kind === 'character') return `ficha completa de ${character.name}`;
  if (scope.kind === 'field') return `${FIELD_LABELS[scope.field].toLowerCase()} de ${character.name}`;
  return `vínculo entre ${character.name} y ${characterById(scope.otherId)?.name ?? 'otro personaje'}`;
}

async function startAI(scope: AIScope, formTarget = false) {
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
    if (formTarget) {
      ai.plan.prompt += '\n\nLa persona pidió completar una ficha y quizá agregar familiares. Respondé únicamente JSON válido, sin markdown, con esta forma: {"nameSuggestion":"nombre correcto sugerido o cadena vacía","nameSuggestionBasis":"material|conocimiento_general|vacío","nameSuggestionEvidence":"código de fuente y referencia o vacío","aliases":[],"age":"","description":"","traits":[],"occupation":"","affiliation":"","certainty":{"age":"explicit","description":"inferred","occupation":"explicit","affiliation":"inferred"},"evidence":{"age":"código de fuente y referencia o vacío","description":"código de fuente y referencia o vacío","occupation":"código de fuente y referencia o vacío","affiliation":"código de fuente y referencia o vacío"},"relatives":[{"name":"","type":"Hermano/a de","direction":"out","certainty":"explicit","evidence":"código de fuente y referencia"}]}. Para nameSuggestion podés usar una coincidencia en las fuentes permitidas o tu conocimiento general de la obra para sugerir solo la ortografía/nombre canónico más probable. nameSuggestionBasis debe ser exactamente material, conocimiento_general o vacío. Si usás conocimiento general, marca nameSuggestionBasis como conocimiento_general; no des detalles de trama, relaciones ni eventos al explicar la sugerencia. Si no tenés confianza suficiente, dejá nameSuggestion vacío. Nunca cambies el nombre de la ficha automáticamente. Para todos los demás datos, usá exclusivamente las fuentes permitidas hasta la página actual: no uses conocimiento general ni anticipes eventos. En certainty usá solo los valores exactos explicit, inferred o unknown. Para direction usá solo out o in. Usá cadenas vacías y listas vacías si no hay respaldo. Solo proponé familiares respaldados por las fuentes permitidas; la persona revisará las sugerencias antes de aplicarlas.';
      ai.plan.systemInstruction += '\n\nEn esta solicitud, la única excepción a la prohibición de usar conocimiento general es sugerir la posible ortografía del nombre en nameSuggestion. Nunca reveles trama, spoilers ni hechos de la obra basados en ese conocimiento. Completá los demás campos solo con el material permitido.';
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

function paintAI() {
  const slot = host?.querySelector<HTMLElement>('#chrAiHost');
  if (!slot) return;
  const ai = state.ai;
  if (!ai) {
    slot.innerHTML = '';
    return;
  }
  const relations = pairRelations(ai);
  const targets = ai.status === 'done' && !ai.formTarget ? saveTargetsFor(ai, relations.length > 0) : [];
  const answerHTML =
    ai.status === 'done' && !ai.formTarget && api().renderMarkdown
      ? `<div class="chr-ai-answer chr-ai-answer--md" id="chrAiAnswer" tabindex="0">${api().renderMarkdown!(ai.text)}</div>`
      : `<div class="chr-ai-answer" id="chrAiAnswer" tabindex="0">${esc(ai.text)}</div>`;
  slot.innerHTML = `<section class="chr-ai" aria-labelledby="chrAiTitle">
    <div class="chr-section-head">
      <h3 id="chrAiTitle">${AI_SPARK} IA · ${esc(ai.label)}</h3>
      <div class="chr-row-actions">
        ${ai.status === 'running' ? '<button type="button" class="secondary" data-chr="ai-stop">Detener</button>' : ''}
        <button type="button" class="secondary" data-chr="ai-close">Cerrar</button>
      </div>
    </div>
    ${ai.plan ? `<p class="muted chr-ai-context">${esc(ai.plan.contextSummary)}</p>` : ''}
    <p class="chr-ai-status" role="status" aria-live="polite">${
      ai.status === 'running' ? 'Consultando a la IA…' : ai.status === 'done' ? esc(ai.note) : ''
    }</p>
    ${ai.status === 'error' ? `<div class="chr-ai-error" role="alert">${esc(ai.error)} ${ai.keyError ? '<button type="button" class="ai-key-cta" data-chr="ai-key">Configurar mi API key</button>' : ''}</div>` : ''}
    ${ai.text || ai.status === 'running' ? answerHTML : ''}
    ${ai.formTarget && ai.status === 'done' ? `<div class="chr-ai-save">${suggestedNameHTML(ai.text)}<p class="muted">Revisá la respuesta. Marcá los familiares que quieras agregar; se crearán al guardar la ficha.</p><div id="chrSuggestedRelatives">${suggestedRelativesHTML(ai.text)}</div><button type="button" class="primary" data-chr="apply-autofill">Aplicar datos seleccionados</button></div>` : ''}
    ${
      ai.status === 'done' && ai.text.trim()
        ? `<p class="muted chr-ai-disclaimer">La IA puede equivocarse y no leyó el libro completo: revisá lo explícito y lo inferido antes de guardar.</p>
    ${
      targets.length
        ? `<form id="chrAiSave" class="chr-ai-save" novalidate>
      <div class="chr-form-field">
        <label for="chrAiSaveText">Texto a guardar (podés editarlo)</label>
        <textarea id="chrAiSaveText" name="text">${esc(ai.text)}</textarea>
      </div>
      <div class="chr-ai-save-row">
        <div class="chr-form-field">
          <label for="chrAiTarget">Dónde guardarlo</label>
          <select id="chrAiTarget" name="target">${targets.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('')}</select>
        </div>
        <div class="chr-form-field" id="chrAiCertaintyWrap">
          <label for="chrAiCertainty">Certeza del dato</label>
          <select id="chrAiCertainty" name="certainty">
            <option value="inferred" selected>${CERTAINTY_LABELS.inferred}</option>
            <option value="explicit">${CERTAINTY_LABELS.explicit}</option>
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

function syncAISaveForm() {
  const target = host?.querySelector<HTMLSelectElement>('#chrAiTarget');
  const wrap = host?.querySelector<HTMLElement>('#chrAiCertaintyWrap');
  if (target && wrap) wrap.classList.toggle('hidden', target.value !== 'field');
}

function suggestedRelativesHTML(text: string): string {
  try {
    const raw = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const relatives = JSON.parse(raw).relatives;
    if (!Array.isArray(relatives) || !relatives.length) return '<p class="muted">La IA no encontró familiares con respaldo suficiente en el material consultado.</p>';
    return relatives.filter((r: any) => typeof r.name === 'string' && r.name.trim()).slice(0, 20).map((r: any, i: number) => `<label class="chr-form-field"><span><input type="checkbox" data-relative-index="${i}" /> ${esc(r.name)} · ${esc(r.type || 'Familiar')} (${r.direction === 'in' ? 'el familiar → personaje' : 'personaje → familiar'})</span></label>`).join('');
  } catch { return '<p class="muted">No se pudieron interpretar las propuestas de familiares.</p>'; }
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

async function submitAISave(form: HTMLFormElement) {
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
    const ok = await api().confirm({
      eyebrow: 'GUARDAR RESPUESTA DE LA IA',
      title: '¿Guardar en la ficha?',
      message: preview,
      confirmLabel: 'Guardar',
    });
    if (!ok) return;
    await commit();
    await reload();
    state.ai = null;
    state.notice = 'Respuesta guardada en la ficha.';
    paint(true);
  } catch (err: any) {
    fail(String(err?.message || err));
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

function bindEvents() {
  if (!host) return;
  host.onclick = (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-chr]');
    if (!el || !host!.contains(el)) return;
    void handleAction(el.dataset.chr!, el);
  };
  host.onkeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = (event.target as HTMLElement).closest<SVGElement>('g[data-chr="net-select"]');
    if (!el) return;
    event.preventDefault();
    void handleAction('net-select', el as unknown as HTMLElement);
  };
  host.onsubmit = (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    if (form.id === 'chrCharacterForm') void submitCharacterForm(form);
    else if (form.id === 'chrRelationForm') void submitRelationForm(form);
    else if (form.id === 'chrAiSave') void submitAISave(form);
  };
  host.oninput = (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'chrSearch') {
      state.query = (target as HTMLInputElement).value;
      const results = host!.querySelector('#chrResults');
      if (results) results.innerHTML = resultsHTML();
    }
  };
  host.onchange = (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'chrAiTarget') syncAISaveForm();
    if (target.id === 'chrMultiRelation') host?.querySelector<HTMLElement>('#chrMultiTargets')?.classList.toggle('hidden', !(target as HTMLInputElement).checked);
    if ((target as HTMLInputElement).name === 'chrCandidate') host?.querySelector<HTMLButtonElement>('[data-chr="investigate-character"]')?.removeAttribute('disabled');
    if (target.id === 'chr_other') host!.querySelector<HTMLElement>('#chrNewRelativeWrap')?.classList.toggle('hidden', (target as HTMLSelectElement).value !== '__new__');
    if (target.id === 'chrNetFocus') {
      state.netFocus = (target as HTMLSelectElement).value;
      state.netSelected = null;
      const results = host!.querySelector('#chrResults');
      if (results) results.innerHTML = resultsHTML();
      host!.querySelector<HTMLElement>('#chrNetFocus')?.focus();
    }
  };
}

function repaintResults(focusSelector?: string) {
  const results = host?.querySelector('#chrResults');
  if (results) results.innerHTML = resultsHTML();
  if (focusSelector) host?.querySelector<HTMLElement>(focusSelector)?.focus();
}

async function handleAction(action: string, el: HTMLElement) {
  const id = el.dataset.id || '';
  const current = characterById(state.selectedId) ?? characterById(state.netSelected);
  switch (action) {
    case 'new':
      return go('character-form', { editingCharacterId: null, pendingRelatives: [] });
    case 'open':
      return go('sheet', { selectedId: id });
    case 'back':
    case 'cancel':
      return go(state.mode === 'character-form' && state.editingCharacterId ? 'sheet' : state.mode === 'relation-form' ? 'sheet' : 'index', {
        relationDraft: null,
        editingCharacterId: null,
      });
    case 'view':
      state.view = el.dataset.view as IndexView;
      if (state.view === 'network') {
        state.netSelected = null;
      }
      return paint();
    case 'edit':
      return current ? go('character-form', { editingCharacterId: current.id, pendingRelatives: [] }) : undefined;
    case 'delete': {
      if (!current) return;
      const links = relationCount(current.id);
      const ok = await api().confirm({
        eyebrow: 'ELIMINAR PERSONAJE',
        title: `¿Eliminar a «${current.name}»?`,
        message: links
          ? `Se borrará la ficha y también ${links} vínculo${links === 1 ? '' : 's'} con otros personajes.`
          : 'Se borrará la ficha.',
        confirmLabel: 'Sí, eliminar',
        danger: true,
      });
      if (!ok) return;
      const cascade = removeCharacterCascade(data.characters, data.relations, current.id);
      for (const relationId of cascade.removedRelationIds) await api().deleteRelation(relationId);
      await api().deleteCharacter(current.id);
      await reload();
      return go('index', { selectedId: null, notice: `Se eliminó a «${current.name}».` });
    }
    case 'add-relation':
      return current ? go('relation-form', { relationDraft: { fromId: current.id, editingId: null } }) : undefined;
    case 'edit-relation':
      return current ? go('relation-form', { relationDraft: { fromId: current.id, editingId: el.dataset.rel || null } }) : undefined;
    case 'remove-relation': {
      const relation = data.relations.find((r) => r.id === el.dataset.rel);
      if (!relation || !current) return;
      const other = characterById(relation.fromId === current.id ? relation.toId : relation.fromId);
      const ok = await api().confirm({
        eyebrow: 'QUITAR VÍNCULO',
        title: '¿Quitar este vínculo?',
        message: `Se quitará «${relation.type}» entre ${current.name} y ${other?.name ?? 'otro personaje'}. Las fichas no se modifican.`,
        confirmLabel: 'Quitar',
        danger: true,
      });
      if (!ok) return;
      await api().deleteRelation(relation.id);
      await reload();
      return go('sheet', { selectedId: current.id, notice: 'Vínculo quitado.' });
    }
    case 'show-network':
      return current ? (state.netFocus = current.id, state.netSelected = null, state.view = 'network', go('index', { selectedId: current.id })) : undefined;
    case 'add-evidence': {
      const rows = host?.querySelector('#chrEvidenceRows');
      if (!rows || rows.children.length >= LIMITS.evidence) return;
      rows.insertAdjacentHTML('beforeend', evidenceRowHTML());
      rows.lastElementChild?.querySelector<HTMLElement>('[data-f=ref]')?.focus();
      return;
    }
    case 'remove-evidence': {
      const row = el.closest('.chr-evidence-row');
      const next = (row?.nextElementSibling || row?.previousElementSibling) as HTMLElement | null;
      row?.remove();
      (next?.querySelector<HTMLElement>('[data-f=ref]') || host?.querySelector<HTMLElement>('[data-chr=add-evidence]'))?.focus();
      return;
    }
    case 'ask': {
      const scope = el.dataset.scope;
      if (scope === 'character') return startAI({ kind: 'character' });
      if (scope === 'field') return startAI({ kind: 'field', field: el.dataset.field as CharacterFieldKey | 'name' });
      if (scope === 'relation') return startAI({ kind: 'relation', otherId: el.dataset.other || '', relationId: el.dataset.rel });
      return;
    }
    case 'autofill':
      return startAI({ kind: 'character' }, true);
    case 'search-character':
      return searchCharacterWithWeb();
    case 'investigate-character':
      return investigateSelectedCharacter();
    case 'apply-research':
      applyWebResearch();
      return;
    case 'none-candidate':
      state.characterSearch.controller?.abort();
      state.characterSearch = { status: 'idle', name: '', candidates: [], sources: [], error: '', suggestion: null, controller: null };
      paint();
      showFormErrors([], ['No se modificó la ficha. Conservá el nombre y completala manualmente o iniciá otra búsqueda.']);
      return;
    case 'stop-research':
      state.characterSearch.controller?.abort();
      return;
    case 'apply-autofill': {
      const ai = state.ai;
      if (!ai?.formTarget) return;
      try {
        const raw = ai.text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
        const suggestion = JSON.parse(raw);
        state.pendingRelatives = (Array.isArray(suggestion.relatives) ? suggestion.relatives : []).slice(0, 20).flatMap((r: any, index: number) => {
          const checked = host?.querySelector<HTMLInputElement>(`[data-relative-index="${index}"]`)?.checked;
          if (!checked || typeof r.name !== 'string' || !r.name.trim()) return [];
          return [{ name: r.name.trim(), type: typeof r.type === 'string' ? r.type : 'Familiar', direction: r.direction === 'in' ? 'in' as const : 'out' as const, certainty: r.certainty === 'explicit' || r.certainty === 'inferred' ? r.certainty : 'unknown' as Certainty, evidence: String(r.evidence ?? '') }];
        });
        const setValue = (name: string, value: unknown, transform = (x: any) => String(x ?? '')) => {
          const field = host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
          if (field && !field.value.trim()) field.value = transform(value);
        };
        setValue('aliases', suggestion.aliases, (x) => Array.isArray(x) ? x.join('\n') : '');
        setValue('age', suggestion.age);
        setValue('description', suggestion.description);
        setValue('traits', suggestion.traits, (x) => Array.isArray(x) ? x.join(', ') : '');
        setValue('occupation', suggestion.occupation);
        setValue('affiliation', suggestion.affiliation);
        for (const field of FIELD_KEYS) {
          const cert = host?.querySelector<HTMLSelectElement>(`[name="cert_${field}"]`);
          const value = suggestion.certainty?.[field];
          if (cert && !cert.value && ['explicit', 'inferred'].includes(value)) cert.value = value;
        }
        const evidenceRows = host?.querySelector<HTMLElement>('#chrEvidenceRows');
        const evidenceMap = suggestion.evidence && typeof suggestion.evidence === 'object' ? suggestion.evidence : {};
        for (const field of FIELD_KEYS) {
          const ref = String(evidenceMap[field] ?? '').trim();
          if (ref && evidenceRows && evidenceRows.children.length < LIMITS.evidence) {
            evidenceRows.insertAdjacentHTML('beforeend', evidenceRowHTML({ kind: 'other', ref: ref.slice(0, LIMITS.evidenceRef), text: `Respaldo sugerido para ${FIELD_LABELS[field]} (revisar)` }));
          }
        }
        showFormErrors([], ['Se aplicaron solo los campos vacíos. Revisá los datos y sus fuentes antes de guardar.']);
      } catch {
        showFormErrors(['La respuesta de la IA no tiene el formato esperado. Volvé a consultar o copiá los datos manualmente.']);
      }
      return;
    }
    case 'use-name-suggestion': {
      const nameInput = host?.querySelector<HTMLInputElement>('#chr_name');
      const suggestedName = el.dataset.suggestedName?.trim();
      if (nameInput && suggestedName) {
        nameInput.value = suggestedName;
        nameInput.focus();
      }
      return;
    }
    case 'ask-pair': {
      const otherId = host?.querySelector<HTMLSelectElement>('#chrPairSelect')?.value;
      return otherId ? startAI({ kind: 'relation', otherId }) : undefined;
    }
    case 'ai-stop':
      return abortAI();
    case 'ai-close':
      abortAI();
      state.ai = null;
      paintAI();
      return;
    case 'ai-key':
      return api().ai.openSettings();
    case 'net-select':
      state.netSelected = id;
      return repaintResults(`[data-chr="net-select"][data-id="${CSS.escape(id)}"]`);
    case 'net-center':
      state.netFocus = id;
      state.netSelected = id;
      return repaintResults(`[data-chr="net-select"][data-id="${CSS.escape(id)}"]`);
    case 'fullscreen-network':
      host?.querySelector('.chr-network--global')?.classList.toggle('chr-network--fullscreen');
      return;
    case 'filter-isolated':
      state.netIsolatedOnly = !state.netIsolatedOnly;
      return repaintResults('[data-chr="filter-isolated"]');
  }
}

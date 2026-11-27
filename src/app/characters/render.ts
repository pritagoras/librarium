/** Personajes · Carga de datos, navegación y repintado del panel. */
import { sortCharacters } from '../characters-model';
import { abortAI, paintAI } from './ai-panel';
import { api, characterById, data, host, setData, setState, state, type Mode, type State } from './context';
import { bindEvents } from './events';
import { characterFormHTML, relationFormHTML } from './forms';
import { indexHTML, sheetHTML } from './views';

export async function reload() {
  const loaded = await api().loadBookData(state.bookId);
  setData({
    ...loaded,
    characters: sortCharacters(loaded.characters.filter((c) => c.bookId === state.bookId)),
    relations: loaded.relations.filter((r) => r.bookId === state.bookId),
  });
  // Relaciones huérfanas (por ejemplo, un personaje borrado desde otro dispositivo) no se muestran.
  const ids = new Set(data.characters.map((c) => c.id));
  data.relations = data.relations.filter((r) => ids.has(r.fromId) && ids.has(r.toId));
  if (state.selectedId && !ids.has(state.selectedId)) {
    state.selectedId = null;
    if (state.mode === 'sheet') state.mode = 'index';
  }
}

export function go(mode: Mode, patch: Partial<State> = {}) {
  abortAI();
  setState({ ...state, ai: null, notice: '', ...patch, mode });
  if (patch.view === 'network') state.netReveal = true;
  paint(true);
  rememberForm();
}

const FORMS = '#chrCharacterForm, #chrRelationForm';
let formSnapshot: string | null = null;

function formValues(): string | null {
  const form = host?.querySelector<HTMLFormElement>(FORMS);
  if (!form) return null;
  return JSON.stringify(
    [...form.querySelectorAll<HTMLInputElement>('input, textarea, select')]
      .filter((field) => field.type !== 'search' && field.name !== 'chrCandidate' && !field.hasAttribute('data-chr-grounding'))
      .map((field) => (field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value))
      .filter((value) => value !== '' && value !== false),
  );
}

function rememberForm() {
  formSnapshot = formValues();
}

/** Hay un formulario abierto con cambios sin guardar. */
export function hasUnsavedChanges(): boolean {
  const now = formValues();
  return now !== null && formSnapshot !== null && now !== formSnapshot;
}

/** Pregunta antes de descartar. Devuelve true si se puede salir del formulario. */
export async function confirmDiscard(): Promise<boolean> {
  if (!hasUnsavedChanges()) return true;
  const ok = await api().confirm({
    eyebrow: 'CAMBIOS SIN GUARDAR',
    title: '¿Descartar los cambios?',
    message: 'Lo que escribiste en este formulario todavía no se guardó.',
    confirmLabel: 'Descartar',
    danger: true,
  });
  if (ok) formSnapshot = null;
  return ok;
}

export function paint(focusHeading = false) {
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
  // La red se dibuja estable: no reiniciar animaciones de opacidad/escala al entrar
  // o al repintar controles, porque producen un efecto de parpadeo en móviles.
  state.netReveal = false;
  if (state.mode === 'sheet') paintAI();
  if (focusHeading) host.querySelector<HTMLElement>('#chrHeading')?.focus({ preventScroll: false });
}

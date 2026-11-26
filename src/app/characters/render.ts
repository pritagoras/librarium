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
  if (state.netReveal && state.mode === 'index' && state.view === 'network') {
    const network = host.querySelector<HTMLElement>('.chr-network--global');
    if (network) {
      network.classList.add('chr-network--reveal');
      state.netReveal = false;
      window.setTimeout(() => network.classList.remove('chr-network--reveal'), 1500);
    }
  }
  if (state.mode === 'sheet') paintAI();
  if (focusHeading) host.querySelector<HTMLElement>('#chrHeading')?.focus({ preventScroll: false });
}

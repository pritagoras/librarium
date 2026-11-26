/**
 * Sección "Personajes" de cada libro: lista, tabla y red de relaciones, fichas editables,
 * vínculos entre personajes y consultas a la IA. La lógica pura (validación, IDs, respaldo,
 * contexto para la IA) vive en `characters-model.ts`; este módulo solo arma la interfaz,
 * maneja eventos y delega la persistencia y la IA en las dependencias que recibe de app.ts.
 */
import type { Book } from '../types';
import { abortAI } from './characters/ai-panel';
import { api, book, characterById, emptyState, host, setBook, setHost, setState, state } from './characters/context';
import { go, paint, reload } from './characters/render';

/** Verdadero mientras hay un formulario abierto o una consulta en curso: app.ts no debe repintar encima. */
export function isCharactersBusy(): boolean {
  return state.mode === 'character-form' || state.mode === 'relation-form' || state.ai?.status === 'running' || state.characterSearch.status === 'running' || state.networkReview.status === 'running' || state.growth.status !== 'idle';
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
    setState(emptyState(currentBook.id));
  }
  setHost(container);
  setBook(currentBook);
  await reload();
  paint();
}

/** Abre una ficha en el panel que ya se dibujó (se usa desde la búsqueda global). */
export function openCharacterSheet(id: string): void {
  if (characterById(id)) go('sheet', { selectedId: id });
}

export { initCharacters } from './characters/context';

export { parsePastedJSON } from './characters/character-search';
export type { CharactersBookData, CharactersDeps } from './characters/context';

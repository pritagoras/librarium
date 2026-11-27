/**
 * Sección "Personajes" de cada libro: lista, tabla y red de relaciones, fichas editables,
 * vínculos entre personajes y consultas a la IA. La lógica pura (validación, IDs, respaldo,
 * contexto para la IA) vive en `characters-model.ts`; este módulo solo arma la interfaz,
 * maneja eventos y delega la persistencia y la IA en las dependencias que recibe de app.ts.
 */
import type { Book } from '../types';
import { abortAI } from './characters/ai-panel';
import { api, book, characterById, emptyState, host, setBook, setHost, setState, state } from './characters/context';
import { confirmDiscard, go, hasUnsavedChanges, paint, reload } from './characters/render';

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

let mountedContainer: HTMLElement | null = null;
let mountedBookId = '';

export async function renderCharactersPanel(container: HTMLElement, currentBook: Book): Promise<void> {
  if (mountedContainer === container && mountedBookId === currentBook.id && container.querySelector('.chr-root')) return;
  if (state.bookId !== currentBook.id) {
    abortAI();
    setState(emptyState(currentBook.id));
  }
  setHost(container);
  setBook(currentBook);
  await reload();
  paint();
  mountedContainer = container;
  mountedBookId = currentBook.id;
}

/** Abre una ficha en el panel que ya se dibujó (se usa desde la búsqueda global). */
export function openCharacterSheet(id: string): void {
  if (characterById(id)) go('sheet', { selectedId: id });
}

export { confirmDiscard, hasUnsavedChanges };

/** Cierra el formulario abierto sin guardar (después de confirmar el descarte). */
export function leaveCharacterForm(): void {
  if (state.mode === 'character-form') state.mode = state.editingCharacterId ? 'sheet' : 'index';
  else if (state.mode === 'relation-form') state.mode = 'sheet';
}

export { initCharacters } from './characters/context';

export { parsePastedJSON } from './characters/character-search';
export type { CharactersBookData, CharactersDeps } from './characters/context';

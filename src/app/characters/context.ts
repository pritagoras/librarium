/** Personajes · Dependencias, tipos y estado compartido del módulo. */
import type { Book, Certainty, Character, CharacterRelation, Entry, Note, Quote } from '../../types';
import type { AIRequestPlan, AIScope } from '../characters-model';
import type { GrowthResult } from '../network-growth';

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

export function api(): CharactersDeps {
  if (!deps) throw Error('El módulo de personajes no fue inicializado.');
  return deps;
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

export type Mode = 'index' | 'sheet' | 'character-form' | 'relation-form';
export type IndexView = 'list' | 'table' | 'network';

export interface AIState {
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
  fullSheet?: boolean;
}

export interface State {
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
  netZoom: number;
  netReveal: boolean;
  notice: string;
  growth: { status: 'idle' | 'running' | 'review' | 'saving'; error: string; result: GrowthResult | null };
  ai: AIState | null;
  pendingRelatives: Array<{ name: string; type: string; direction: 'out' | 'in'; certainty: Certainty; evidence: string }>;
  familyReview: { status: 'idle' | 'running' | 'prompt' | 'review'; prompt: string; responseText: string; error: string; relatives: Array<{ name: string; type: string; direction: 'out' | 'in'; basis: string; certainty: Certainty }> };
  characterSearch: { status: 'idle' | 'running' | 'candidate-prompt' | 'candidates' | 'profile-prompt' | 'ready'; name: string; candidates: Array<{ name: string; aliases: string[]; description: string; confidence: string }>; sources: Array<{ title: string; url: string }>; error: string; suggestion: any | null; prompt: string; responseText: string };
  networkReview: { status: 'idle' | 'running' | 'prompt' | 'review'; prompt: string; responseText: string; error: string; proposals: NetworkProposal[]; manualFindings: Array<{ category: string; characterIds: string[]; name?: string; reason: string; evidence: string; sourceUrl: string; basisType: 'reader_material' | 'general_knowledge' }> };
}

export interface NetworkProposal {
  action: 'add' | 'correct';
  targetRelationId?: string;
  fromId: string;
  toId: string;
  type: string;
  description: string;
  certainty: Certainty;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  evidence: string;
  sourceUrl: string;
  basisType: 'reader_material' | 'general_knowledge';
  decision: 'pending' | 'accepted' | 'rejected';
  validationError?: string;
}

export const emptyState = (bookId = ''): State => ({
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
  netZoom: 1,
  netReveal: false,
  notice: '',
  growth: { status: 'idle', error: '', result: null },
  ai: null,
  pendingRelatives: [],
  familyReview: { status: 'idle', prompt: '', responseText: '', error: '', relatives: [] },
  characterSearch: { status: 'idle', name: '', candidates: [], sources: [], error: '', suggestion: null, prompt: '', responseText: '' },
  networkReview: { status: 'idle', prompt: '', responseText: '', error: '', proposals: [], manualFindings: [] },
});

export let state: State = emptyState();
export function setState(value: State) {
  state = value;
}
export let data: CharactersBookData = { characters: [], relations: [], notes: [], entries: [], quotes: [] };
export function setData(value: CharactersBookData) {
  data = value;
}
export let book: Book | null = null;
export function setBook(value: Book | null) {
  book = value;
}
export let host: HTMLElement | null = null;
export function setHost(value: HTMLElement | null) {
  host = value;
}

export const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char),
  );

export const AI_SPARK = '✦';

export function characterById(id: string | null | undefined): Character | undefined {
  return data.characters.find((c) => c.id === id);
}

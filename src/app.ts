import {
  download,
  parseBackupJSON,
  restoreBackupData,
  slug,
  validateNotesJSON,
} from './app/data-transfer';
import { showConfirmDialog } from './app/dialogs';
import { initSearch } from './app/search';
import { extractKeyPhrase, KEY_PHRASE_MARKER, mergeSubannotations, visibleStreamingAnswer } from './app/gemini-key-phrase';
import type { SearchDoc } from './app/search-model';
import { all, get, openDB } from './db';
import { signInWithGoogle, signOutUser } from './firebase';
import { initInstall, initTheme, setupServiceWorkerUpdates } from './app/platform';
import {
  aiStyleInstruction,
  aiStyleOnly,
  commentDiscussionPrompt,
  getAISettingsForTask,
  getPrivateGeminiKey,
  initAISettings,
  isAIKeyError,
  openAISettingsGuide,
  renderInlineKeyCTA,
  requestGeminiFeature,
  syncGeminiNoKeyBanner,
  thinkingLabel,
} from './app/ai-settings';
import {
  deleteFromCloud,
  getSyncState,
  getSyncConflicts,
  initSync,
  migrateLocalDataToCloud,
  pushAnalysisToCloud,
  pushBookToCloud,
  pushCharacterRelationToCloud,
  pushCharacterToCloud,
  pushConversationToCloud,
  pushEntryToCloud,
  pushNoteToCloud,
  pushQuoteToCloud,
  resolveSyncConflict,
  sanitizeId,
} from './sync';
import { isFeedbackAdmin } from './feedback-access';
import changelogMarkdown from '../CHANGELOG.md?raw';
import type {
  AISettings,
  AISubcomment,
  Book,
  BookAnalysis,
  Character,
  CharacterRelation,
  BookStatus,
  Conversation,
  ConversationTurn,
  Entry,
  Note,
  Quote,
  SortOption,
  Subannotation,
  SyncConflict,
  SyncStatus,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(s: string): T | null =>
  document.querySelector(s) as T | null;
const $$ = <T extends HTMLElement = HTMLElement>(s: string): T[] =>
  Array.from(document.querySelectorAll(s)) as T[];

function renderSubannotations(items: Subannotation[] = []): string {
  if (!items.length) return '';
  const visible = items.length > 2 ? items.slice(0, 2) : items;
  const rows = visible.map((item) => `<div class="subannotation" data-subannotation-id="${esc(item.id)}"><strong>${esc(item.phrase)}</strong><small>${esc(item.question)}</small><button type="button" data-delete-subannotation="${esc(item.id)}" aria-label="Borrar frase clave">Borrar</button></div>`).join('');
  const rest = items.length > 2 ? `<details><summary>Ver ${items.length - 2} frases clave más</summary>${items.slice(2).map((item) => `<div class="subannotation" data-subannotation-id="${esc(item.id)}"><strong>${esc(item.phrase)}</strong><small>${esc(item.question)}</small><button type="button" data-delete-subannotation="${esc(item.id)}">Borrar</button></div>`).join('')}</details>` : '';
  return `<div class="subannotations">${rows}${rest}</div>`;
}

function renderAiSubcomments(items: AISubcomment[] = []): string {
  if (!items.length) return '';
  const row = (item: AISubcomment) => `<details class="ai-subcomment" data-ai-subcomment-id="${esc(item.id)}"><summary>${esc(item.question)}</summary><div class="ai-subcomment-answer"><p>${esc(item.text).replace(/\n/g, '<br>')}</p><small>${new Date(item.createdAt).toLocaleDateString('es-AR')}</small><button type="button" data-delete-ai-subcomment="${esc(item.id)}">Borrar respuesta</button></div></details>`;
  const preview = items.length > 2 ? items.slice(0, 2) : items;
  return `<div class="ai-subcomments"><small>Respuestas de la IA</small>${preview.map(row).join('')}${items.length > 2 ? `<details class="ai-subcomments-more"><summary>Ver ${items.length - 2} preguntas más</summary>${items.slice(2).map(row).join('')}</details>` : ''}</div>`;
}

const statusNames: Record<BookStatus, string> = {
  pending: 'Pendiente',
  reading: 'En lectura',
  paused: 'Pausado',
  finished: 'Terminado',
};

type DetailTab = 'notes' | 'entries' | 'photos' | 'quotes' | 'characters' | 'review' | 'settings';

let books: Book[] = [];
let activeBook: Book | null = null;
let detailTab: DetailTab = 'notes';
let annotationAsComment = false;
let pendingImport: { obj: any; notes: any[] } | null = null;
let coverData: string | null = null;
let photoData: string | null = null;
let quotePhotoData: string[] = [];
let quoteOCRGeneration = 0;
let isbnScannerStream: MediaStream | null = null;
let cameraCaptureStream: MediaStream | null = null;
let cameraFacingMode: 'environment' | 'user' = 'environment';
let cameraCapturedBlob: Blob | null = null;
let cameraShotUrl: string | null = null;
let cameraOnCapture: ((file: File) => Promise<void> | void) | null = null;
let cameraFallbackInput: HTMLInputElement | null = null;
let isAnalyzingBook = false;

type CharactersFeature = typeof import('./app/characters');
let charactersFeature: CharactersFeature | null = null;
let charactersFeaturePromise: Promise<CharactersFeature> | null = null;
let adminFeaturePromise: Promise<typeof import('./app/admin')> | null = null;
let adminFeaturesInitialized = false;

function loadCharactersFeature(): Promise<CharactersFeature> {
  if (charactersFeature) return Promise.resolve(charactersFeature);
  if (!charactersFeaturePromise) {
    charactersFeaturePromise = import('./app/characters').then((feature) => {
      feature.initCharacters({
        loadBookData: async (bookId) => {
          const [characters, relations, notes, entries, quotes] = await Promise.all([
            all<Character>('characters'), all<CharacterRelation>('characterRelations'), all<Note>('notes'), all<Entry>('entries'), all<Quote>('quotes'),
          ]);
          const mine = <T extends { bookId: string }>(items: T[]) => items.filter((item) => sanitizeId(item.bookId) === sanitizeId(bookId));
          return { characters: mine(characters), relations: mine(relations), notes: mine(notes), entries: mine(entries), quotes: mine(quotes) };
        },
        saveCharacter: pushCharacterToCloud,
        saveRelation: pushCharacterRelationToCloud,
        deleteCharacter: (id) => deleteFromCloud('characters', id),
        deleteRelation: (id) => deleteFromCloud('characterRelations', id),
        confirm: showConfirmDialog,
        ai: {
          hasKey: () => Boolean(getPrivateGeminiKey()),
          request: requestGeminiFeature,
          settings: () => { const settings = getAISettingsForTask('chat'); return { model: settings.model, thinking: settings.thinking }; },
          styleInstruction: () => aiStyleOnly(getAISettingsForTask('chat')),
          openSettings: openAISettingsGuide,
          isKeyError: isAIKeyError,
        },
        renderMarkdown: renderGeminiMarkdown,
      });
      charactersFeature = feature;
      return feature;
    }).catch((error) => { charactersFeaturePromise = null; throw error; });
  }
  return charactersFeaturePromise;
}

function loadAdminFeature() {
  if (!adminFeaturePromise) {
    adminFeaturePromise = import('./app/admin').then((feature) => {
      if (!adminFeaturesInitialized) {
        feature.initAdminFeatures();
        adminFeaturesInitialized = true;
      }
      return feature;
    }).catch((error) => { adminFeaturePromise = null; throw error; });
  }
  return adminFeaturePromise;
}

function resetAdminBadges() {
  for (const id of ['settingsOpenBadge', 'inboxPendingBadge']) {
    const badge = $(`#${id}`);
    badge?.classList.add('hidden');
    if (badge) badge.textContent = '';
  }
  $('#settingsOpen')?.setAttribute('aria-label', 'Ajustes');
}

const AI_SPARK = '<svg class="ai-spark" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false"><path d="M10 3c.7 4.6 3.4 7.3 8 8-4.6.7-7.3 3.4-8 8-.7-4.6-3.4-7.3-8-8 4.6-.7 7.3-3.4 8-8z"/><path d="M19 1.5c.25 1.7 1.1 2.55 2.8 2.8-1.7.25-2.55 1.1-2.8 2.8-.25-1.7-1.1-2.55-2.8-2.8 1.7-.25 2.55-1.1 2.8-2.8z"/></svg>';

function aiIconButton(attr: string, id: string, label: string): string {
  return `<button type="button" class="ai-icon-btn" ${attr}="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}">${AI_SPARK}</button>`;
}

let geminiHistory: ConversationTurn[] = [];
let geminiItem: {
  book: Book | null;
  note: Note | null;
  entry: Entry | null;
  quote: Quote | null;
  analysis: BookAnalysis | null;
} | null = null;
let geminiAttachedImage: string | null = null;
let geminiExtraContext = '';
let geminiConversationId: string | null = null;
let geminiConversationHadImages = false;
let geminiLastQuestion = '';
let geminiStreamController: AbortController | null = null;

const uid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);

const localDayKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c),
  );

const fileData = (f: File): Promise<string> =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ''));
    r.onerror = rej;
    r.readAsDataURL(f);
  });

async function copyPlainText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.append(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  }
}

function markdownToPlainText(text: string): string {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\x60{3}[^\n]*\n([\s\S]*?)\x60{3}/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\x60([^\x60]+)\x60/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, '• ')
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')
    .replace(/\*\*(.*?)\*\*|__(.*?)__/gs, (_match, a, b) => a ?? b)
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)/g, (_match, a, b) => a ?? b)
    .replace(/~~(.*?)~~/gs, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseTagsInput(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(',')) {
    const clean = part.trim().slice(0, 32);
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) {
      seen.add(key);
      result.push(clean);
      if (result.length >= 10) break;
    }
  }
  return result;
}

function getAllLibraryTags(): string[] {
  const map = new Map<string, string>();
  for (const b of books) {
    for (const t of b.tags || []) {
      const clean = String(t).trim();
      if (clean && !map.has(clean.toLowerCase())) {
        map.set(clean.toLowerCase(), clean);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.localeCompare(b, 'es'));
}

function renderStarsText(rating: number | null | undefined): string {
  if (!rating || rating < 1) return '';
  const r = Math.min(5, Math.max(1, Math.round(rating)));
  return `${'★'.repeat(r)}${'☆'.repeat(5 - r)} (${r}/5)`;
}

function renderInteractiveStars(
  container: HTMLElement,
  currentRating: number | null,
  onChange: (rating: number | null) => void,
) {
  const value = currentRating ? Math.min(5, Math.max(1, Math.round(currentRating))) : 0;
  container.innerHTML = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<button type="button" class="star-btn ${n <= value ? 'active' : ''}" data-star="${n}" aria-label="${n} ${
          n === 1 ? 'estrella' : 'estrellas'
        }" aria-pressed="${n <= value}">${n <= value ? '★' : '☆'}</button>`,
    )
    .join('') +
    (value
      ? `<button type="button" class="star-clear" data-star-clear>Quitar</button>`
      : '');

  container.querySelectorAll<HTMLButtonElement>('[data-star]').forEach((btn) => {
    btn.onclick = () => {
      const next = Number(btn.dataset.star);
      onChange(next === value ? null : next);
    };
  });
  container.querySelector<HTMLButtonElement>('[data-star-clear]')?.addEventListener('click', () => {
    onChange(null);
  });
}

function switchView(v: string) {
  $$('.tab').forEach((b) => {
    const active = b.dataset.view === v;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === `${v}View`));
  if (v === 'notebook') void renderJournal();
  if (v === 'quotes') void renderQuoteCollection();
}

function coverHTML(b: Book): string {
  const src = b.cover || b.coverUrl;
  return src
    ? `<img class="cover" src="${esc(src)}" data-cover-title="${esc(b.title)}" alt="Portada de ${esc(b.title)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="cover cover-placeholder">${esc(b.title)}</div>`;
}

function card(b: Book): string {
  const pct = b.totalPages
    ? Math.min(100, Math.round(((b.currentPage || 0) / b.totalPages) * 100))
    : 0;
  const ratingText = b.rating ? `★ ${b.rating}/5` : '';
  const tagsList = (b.tags || []).slice(0, 3).join(' · ');
  const metaExtras = [ratingText, tagsList].filter(Boolean).join(' · ');
  return `<article class="book-card" data-id="${esc(b.id)}" tabindex="0" role="button" aria-label="Abrir ${esc(b.title)}">
    ${coverHTML(b)}
    <div class="book-meta">
      <span class="status">${statusNames[b.status] || 'Pendiente'}</span>
      <h3>${esc(b.title)}</h3>
      <p>${esc(b.author || 'Autor desconocido')}</p>
      ${metaExtras ? `<p class="book-card-tags">${esc(metaExtras)}</p>` : ''}
      <p>${b.currentPage || 0}${b.totalPages ? ` / ${b.totalPages} páginas` : ' páginas'}</p>
      <div class="progress"><span style="width:${pct}%"></span></div>
    </div>
  </article>`;
}

function populateTagFilter() {
  const select = $<HTMLSelectElement>('#bookTagFilter');
  if (!select) return;
  const previous = select.value || 'all';
  const tags = getAllLibraryTags();
  select.innerHTML =
    `<option value="all">Todas las etiquetas</option>` +
    tags.map((t) => `<option value="${esc(t.toLowerCase())}">${esc(t)}</option>`).join('');
  if (previous === 'all' || tags.some((t) => t.toLowerCase() === previous)) {
    select.value = previous;
  } else {
    select.value = 'all';
  }
}

function sortBooks(list: Book[], sortBy: SortOption): Book[] {
  const copy = [...list];
  const progressPct = (b: Book) =>
    b.totalPages ? (b.currentPage || 0) / b.totalPages : 0;

  copy.sort((a, b) => {
    switch (sortBy) {
      case 'title':
        return (a.title || '').localeCompare(b.title || '', 'es');
      case 'author':
        return (a.author || 'zzz').localeCompare(b.author || 'zzz', 'es');
      case 'rating':
        return (b.rating || 0) - (a.rating || 0) || (b.updatedAt || '').localeCompare(a.updatedAt || '');
      case 'progress':
        return progressPct(b) - progressPct(a) || (b.currentPage || 0) - (a.currentPage || 0);
      case 'year':
        return (Number(b.year) || 0) - (Number(a.year) || 0);
      case 'recent':
      default:
        return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
    }
  });
  return copy;
}

function render() {
  scheduleAiConvsBanner();
  populateTagFilter();
  const q = ($<HTMLInputElement>('#bookSearch')?.value || '').toLowerCase().trim();
  const statusFilter = $<HTMLSelectElement>('#bookFilter')?.value || 'all';
  const tagFilter = $<HTMLSelectElement>('#bookTagFilter')?.value || 'all';
  const sortBy = ($<HTMLSelectElement>('#bookSort')?.value || 'recent') as SortOption;

  const filtered = books.filter((b) => {
    const matchesStatus = statusFilter === 'all' || b.status === statusFilter;
    const matchesTag =
      tagFilter === 'all' ||
      (b.tags || []).some((t) => t.toLowerCase() === tagFilter);
    const haystack = `${b.title} ${b.author || ''} ${(b.tags || []).join(' ')}`.toLowerCase();
    const matchesQuery = !q || haystack.includes(q);
    return matchesStatus && matchesTag && matchesQuery;
  });

  const activeFiltersCount =
    (statusFilter !== 'all' ? 1 : 0) +
    (tagFilter !== 'all' ? 1 : 0) +
    (sortBy !== 'recent' ? 1 : 0);
  const toggleFiltersBtn = $('#toggleFiltersBtn');
  if (toggleFiltersBtn) {
    toggleFiltersBtn.textContent = activeFiltersCount
      ? `Filtros (${activeFiltersCount})`
      : 'Filtros';
    toggleFiltersBtn.classList.toggle('has-active', activeFiltersCount > 0);
  }
  const clearFiltersBtn = $('#clearFiltersBtn');
  if (clearFiltersBtn) {
    clearFiltersBtn.classList.toggle('hidden', !activeFiltersCount && !q);
  }
  const libraryBar = $('.library-bar');
  if (libraryBar) {
    libraryBar.classList.toggle('hidden', books.length === 0);
  }
  if (books.length === 0) {
    $('#libraryFilters')?.classList.add('hidden');
  }

  const sorted = sortBooks(filtered, sortBy);
  const grid = $('#bookGrid');
  const empty = $('#emptyBooks');
  const readingGrid = $('#readingGrid');
  if (grid) {
    grid.innerHTML = sorted.length
      ? sorted.map(card).join('')
      : books.length
        ? '<p class="empty-inline">Ningún libro coincide con los filtros actuales.</p>'
        : '';
    grid.style.display = books.length ? (sorted.length ? 'grid' : 'block') : 'none';
  }
  if (empty) empty.style.display = books.length ? 'none' : 'block';
  if (readingGrid) {
    readingGrid.innerHTML =
      books
        .filter((b) => b.status === 'reading')
        .map(card)
        .join('') || '<p class="empty-inline">Todavía no hay libros en lectura.</p>';
  }
}

function renderBookTagSuggestions() {
  const container = $('#bookTagsSuggestions');
  const input = $<HTMLInputElement>('#bookTagsInput');
  if (!container || !input) return;
  const libraryTags = getAllLibraryTags();
  if (!libraryTags.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = libraryTags
    .slice(0, 12)
    .map(
      (tag) =>
        `<button type="button" class="tag-suggestion-btn" data-add-tag="${esc(tag)}">+ ${esc(tag)}</button>`,
    )
    .join('');
  container.querySelectorAll<HTMLButtonElement>('[data-add-tag]').forEach((btn) => {
    btn.onclick = () => {
      const current = parseTagsInput(input.value);
      const nextTag = btn.dataset.addTag || '';
      if (
        nextTag &&
        !current.some((t) => t.toLowerCase() === nextTag.toLowerCase()) &&
        current.length < 10
      ) {
        current.push(nextTag);
        input.value = current.join(', ');
      }
    };
  });
}

function openBookForm(b: Book | null = null) {
  stopISBNScanner();
  const form = $<HTMLFormElement>('#bookForm');
  form?.reset();
  const isbnStatus = $('#isbnStatus');
  if (isbnStatus) isbnStatus.textContent = '';

  ($<HTMLInputElement>('#bookId')!).value = b?.id || '';
  $('#bookDialogTitle')!.textContent = b ? 'Editar libro' : 'Añadir libro';

  ($<HTMLInputElement>('#title')!).value = b?.title ?? '';
  ($<HTMLInputElement>('#author')!).value = b?.author ?? '';
  ($<HTMLInputElement>('#publisher')!).value = b?.publisher ?? '';
  ($<HTMLInputElement>('#year')!).value = b?.year ?? '';
  ($<HTMLInputElement>('#edition')!).value = b?.edition ?? '';
  ($<HTMLInputElement>('#isbn')!).value = b?.isbn ?? '';
  ($<HTMLInputElement>('#totalPages')!).value = b?.totalPages ? String(b.totalPages) : '';
  ($<HTMLInputElement>('#currentPage')!).value = String(b?.currentPage ?? 0);
  ($<HTMLSelectElement>('#status')!).value = b?.status ?? 'pending';
  ($<HTMLInputElement>('#coverUrl')!).value = b?.coverUrl ?? '';
  ($<HTMLInputElement>('#bookTagsInput')!).value = (b?.tags || []).join(', ');
  ($<HTMLTextAreaElement>('#bookReviewInput')!).value = b?.review ?? '';

  const ratingInput = $<HTMLInputElement>('#bookRatingValue')!;
  let currentRating: number | null = b?.rating ?? null;
  ratingInput.value = currentRating ? String(currentRating) : '';
  const starsEl = $('#bookFormStars');
  if (starsEl) {
    const syncStars = (val: number | null) => {
      currentRating = val;
      ratingInput.value = val ? String(val) : '';
      renderInteractiveStars(starsEl, currentRating, syncStars);
    };
    renderInteractiveStars(starsEl, currentRating, syncStars);
  }
  renderBookTagSuggestions();

  coverData = b?.cover || null;
  updateCoverPreview(coverData ? 'Portada cargada.' : '');
  const autofillStatus = $('#aiAutofillStatus');
  if (autofillStatus) autofillStatus.textContent = '';
  $('#catalogPanel')?.classList.add('hidden');
  $('#manualMode')?.classList.add('active');
  $('#searchMode')?.classList.remove('active');
  $<HTMLDialogElement>('#bookDialog')?.showModal();
}

async function autofillBookWithAI() {
  const btn = $<HTMLButtonElement>('#aiAutofillBookBtn');
  const status = $('#aiAutofillStatus');
  if (!btn || !status) return;

  const titleInput = $<HTMLInputElement>('#title')!;
  const authorInput = $<HTMLInputElement>('#author')!;
  const publisherInput = $<HTMLInputElement>('#publisher')!;
  const yearInput = $<HTMLInputElement>('#year')!;
  const pagesInput = $<HTMLInputElement>('#totalPages')!;
  const isbnInput = $<HTMLInputElement>('#isbn')!;
  const tagsInput = $<HTMLInputElement>('#bookTagsInput')!;

  const title = titleInput.value.trim();
  const author = authorInput.value.trim();
  const isbn = isbnInput.value.trim();

  let coverImage: { mimeType: string; data: string } | null = null;
  if (coverData && coverData.startsWith('data:image/')) {
    const [header, data] = coverData.split(',', 2);
    const mimeType = header.match(/data:(.*?);base64/)?.[1] || 'image/jpeg';
    if (data) coverImage = { mimeType, data };
  }

  if (!title && !author && !isbn && !coverImage) {
    status.textContent = 'Escribí el título, autor, ISBN o cargá una foto de portada primero.';
    titleInput.focus();
    return;
  }

  if (!getPrivateGeminiKey()) {
    renderInlineKeyCTA(status, 'Necesitás guardar tu API key personal de Gemini para autocompletar fichas.');
    return;
  }

  const originalText = btn.textContent || '✦ Completar ficha y etiquetas con IA';
  btn.disabled = true;
  btn.textContent = 'Consultando IA…';
  status.textContent = 'Buscando ficha y etiquetas sugeridas…';

  try {
    const ai = getAISettingsForTask('image');
    const res = await requestGeminiFeature('book-autofill', {
        title,
        author,
        isbn,
        existingTags: getAllLibraryTags(),
        coverImage,
        model: ai.model,
        thinking: ai.thinking,
      });
    const data = await res.json();
    if (!res.ok) {
      const err: any = Error(data.error || `Error HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const s = data.suggestion || {};
    if (!titleInput.value.trim() && s.title) titleInput.value = s.title;
    if (!authorInput.value.trim() && s.author) authorInput.value = s.author;
    if (!publisherInput.value.trim() && s.publisher) publisherInput.value = s.publisher;
    if (!yearInput.value.trim() && s.year) yearInput.value = s.year;
    if (!pagesInput.value.trim() && s.totalPages > 0) pagesInput.value = String(s.totalPages);

    if (Array.isArray(s.tags) && s.tags.length) {
      const merged = parseTagsInput([tagsInput.value, ...s.tags].filter(Boolean).join(', '));
      tagsInput.value = merged.join(', ');
    }

    status.textContent = 'Ficha y etiquetas sugeridas. Revisá los campos antes de guardar.';
  } catch (err: any) {
    if (isAIKeyError(err)) {
      renderInlineKeyCTA(status, err?.message || 'Revisá tu API key personal de Gemini.');
    } else {
      status.textContent = `No se pudo completar con IA: ${err?.message || err}`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function normalizeISBN(value: string): string | null {
  const isbn = String(value || '')
    .replace(/[^0-9x]/gi, '')
    .toUpperCase();
  if (/^\d{13}$/.test(isbn)) {
    const sum = [...isbn.slice(0, 12)].reduce(
      (n, d, i) => n + Number(d) * (i % 2 ? 3 : 1),
      0,
    );
    return (10 - (sum % 10)) % 10 === Number(isbn[12]) ? isbn : null;
  }
  if (/^\d{9}[0-9X]$/.test(isbn)) {
    const sum = [...isbn].reduce(
      (n, d, i) => n + (d === 'X' ? 10 : Number(d)) * (10 - i),
      0,
    );
    return sum % 11 === 0 ? isbn : null;
  }
  return null;
}

async function lookupISBN(value: string) {
  const isbnStatus = $('#isbnStatus')!;
  const isbn = normalizeISBN(value);
  if (!isbn) {
    isbnStatus.textContent = 'Ingresá o escaneá un ISBN-10 o ISBN-13 válido.';
    return;
  }
  ($<HTMLInputElement>('#isbn')!).value = isbn;
  isbnStatus.textContent = 'Buscando el libro por ISBN…';
  try {
    const url =
      'https://openlibrary.org/search.json?q=' +
      encodeURIComponent('isbn:' + isbn) +
      '&fields=title,author_name,publisher,first_publish_year,number_of_pages_median,cover_i,isbn&limit=1';
    const response = await fetch(url);
    if (!response.ok) throw Error('No se pudo consultar el catálogo.');
    const data = await response.json();
    const book = data.docs?.[0];
    if (!book) {
      isbnStatus.textContent =
        'No encontré datos para ese ISBN. Podés completar la ficha manualmente.';
      return;
    }
    ($<HTMLInputElement>('#title')!).value = book.title || '';
    ($<HTMLInputElement>('#author')!).value = (book.author_name || []).join(', ');
    ($<HTMLInputElement>('#publisher')!).value = (book.publisher || [])[0] || '';
    ($<HTMLInputElement>('#year')!).value = book.first_publish_year || '';
    ($<HTMLInputElement>('#totalPages')!).value = book.number_of_pages_median || '';
    ($<HTMLInputElement>('#isbn')!).value =
      (book.isbn || []).find((x: string) => normalizeISBN(x)) || isbn;
    if (book.cover_i) {
      ($<HTMLInputElement>('#coverUrl')!).value =
        `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`;
    }
    isbnStatus.textContent =
      'Datos encontrados. Revisá la edición y completá lo que falte antes de guardar.';
  } catch {
    isbnStatus.textContent =
      'No hubo conexión con el catálogo. El ISBN quedó cargado; podés completar los datos manualmente.';
  }
}

function stopISBNScanner() {
  const video = $<HTMLVideoElement>('#isbnVideo');
  video?.pause?.();
  if (isbnScannerStream) {
    isbnScannerStream.getTracks().forEach((track) => track.stop());
    isbnScannerStream = null;
  }
  if (video) video.srcObject = null;
  $('#isbnScanner')?.classList.add('hidden');
}

function prefersNativeMobileCamera(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  );
}

function revokeCameraShotUrl() {
  if (cameraShotUrl) {
    URL.revokeObjectURL(cameraShotUrl);
    cameraShotUrl = null;
  }
}

function stopCameraCapture() {
  const video = $<HTMLVideoElement>('#cameraVideo');
  const shotPreview = $<HTMLImageElement>('#cameraShotPreview');
  video?.pause?.();
  if (cameraCaptureStream) {
    cameraCaptureStream.getTracks().forEach((track) => track.stop());
    cameraCaptureStream = null;
  }
  if (video) video.srcObject = null;
  if (shotPreview) {
    shotPreview.classList.add('hidden');
    shotPreview.removeAttribute('src');
  }
  revokeCameraShotUrl();
  cameraCapturedBlob = null;
}

async function startCameraStream() {
  const video = $<HTMLVideoElement>('#cameraVideo');
  const shotPreview = $<HTMLImageElement>('#cameraShotPreview');
  const status = $('#cameraCaptureStatus');
  const snapBtn = $<HTMLButtonElement>('#cameraSnapBtn');
  const retakeBtn = $<HTMLButtonElement>('#cameraRetakeBtn');
  const useBtn = $<HTMLButtonElement>('#cameraUseBtn');
  const flipBtn = $<HTMLButtonElement>('#cameraFlipBtn');
  if (!video || !shotPreview || !status || !snapBtn || !retakeBtn || !useBtn) return;

  stopCameraCapture();
  video.classList.remove('hidden');
  shotPreview.classList.add('hidden');
  snapBtn.classList.remove('hidden');
  snapBtn.disabled = true;
  retakeBtn.classList.add('hidden');
  useBtn.classList.add('hidden');
  if (flipBtn) flipBtn.classList.add('hidden');
  status.textContent = 'Abriendo cámara…';

  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent =
      'Este navegador no permite abrir la cámara desde acá. Podés elegir una imagen desde tus archivos.';
    return;
  }

  try {
    cameraCaptureStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: cameraFacingMode },
        width: { ideal: 1600 },
        height: { ideal: 1200 },
      },
      audio: false,
    });
    video.srcObject = cameraCaptureStream;
    await video.play();
    snapBtn.disabled = false;
    status.textContent = 'Enfocá y tocá «Sacar foto».';
    if (flipBtn && navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const videoCount = devices.filter((d) => d.kind === 'videoinput').length;
      flipBtn.classList.toggle('hidden', videoCount < 2);
    }
  } catch {
    stopCameraCapture();
    status.textContent =
      'No se pudo acceder a la cámara. Verificá los permisos del navegador o elegí una imagen desde tus archivos.';
  }
}

function openCameraCapture(options: {
  title: string;
  cameraInput: HTMLInputElement;
  fallbackInput: HTMLInputElement;
  onFile: (file: File) => Promise<void> | void;
  canCapture?: () => boolean;
}) {
  if (options.canCapture && !options.canCapture()) return;
  if (prefersNativeMobileCamera()) {
    options.cameraInput.click();
    return;
  }
  const dlg = $<HTMLDialogElement>('#cameraCaptureDialog');
  if (!dlg) {
    options.cameraInput.click();
    return;
  }
  cameraOnCapture = options.onFile;
  cameraFallbackInput = options.fallbackInput;
  cameraFacingMode = 'environment';
  $('#cameraCaptureTitle')!.textContent = options.title;
  dlg.showModal();
  void startCameraStream();
}

function updateCoverPreview(message = '') {
  const wrap = $('#coverPreviewWrap');
  const img = $<HTMLImageElement>('#coverPreviewImg');
  const status = $('#coverStatus');
  const urlVal = ($<HTMLInputElement>('#coverUrl')?.value || '').trim();
  const src = coverData || (urlVal.startsWith('http') || urlVal.startsWith('data:image/') ? urlVal : '');
  if (wrap && img) {
    if (src) {
      img.src = src;
      wrap.classList.remove('hidden');
    } else {
      img.removeAttribute('src');
      wrap.classList.add('hidden');
    }
  }
  if (status) status.textContent = message;
}

function updateAnnotationPhotoPreview(message = '') {
  const wrap = $('#annotationPhotoPreviewWrap');
  const img = $<HTMLImageElement>('#annotationPhotoPreviewImg');
  const status = $('#annotationPhotoStatus');
  const emptyStatus = $('#annotationPhotoEmptyStatus');
  if (wrap && img) {
    if (photoData) {
      img.src = photoData;
      wrap.classList.remove('hidden');
    } else {
      img.removeAttribute('src');
      wrap.classList.add('hidden');
    }
  }
  if (status) status.textContent = photoData ? message : '';
  if (emptyStatus) emptyStatus.textContent = photoData ? '' : message;
}

async function openDetail(id: string) {
  activeBook = (await get<Book>('books', id)) || books.find((b) => b.id === id) || null;
  if (!activeBook) return;
  detailTab = 'notes';
  await renderDetail();
  $<HTMLDialogElement>('#detailDialog')?.showModal();
}

function renderBookSynthesisHTML(analysis: BookAnalysis | undefined, quotesCount: number): string {
  if (isAnalyzingBook) {
    return `<section class="book-synthesis-card" id="bookSynthesisSection">
      <div class="book-synthesis-head">
        <div>
          <p class="eyebrow">SÍNTESIS LITERARIA CON IA</p>
          <h3>Analizando citas y conexiones del libro…</h3>
        </div>
      </div>
      <p class="muted">Gemini está leyendo tus citas, anotaciones y comentarios para detectar ejes temáticos y conexiones entre fragmentos.</p>
    </section>`;
  }

  if (!analysis) {
    return quotesCount >= 2
      ? `<section class="book-synthesis-card" id="bookSynthesisSection">
          <div class="book-synthesis-head">
            <div>
              <p class="eyebrow">MAPA DE IDEAS DEL LIBRO</p>
              <h3>Descubrí conexiones entre tus citas</h3>
            </div>
            <button type="button" class="secondary" id="runBookSynthesis">✦ Analizar conexiones</button>
          </div>
          <p class="muted">Tenés material suficiente guardado. La IA puede sintetizar los ejes temáticos y cruzar citas o anotaciones de distintos capítulos.</p>
        </section>`
      : '';
  }

  const summaryParagraphs = analysis.summary
    .split(/\n+/)
    .filter((p) => p.trim())
    .map((p) => `<p>${esc(p.trim())}</p>`)
    .join('');

  const themesLine = analysis.themes?.length
    ? `<div class="synthesis-themes"><strong>Ejes temáticos:</strong> ${analysis.themes
        .map((t) => esc(t))
        .join(' · ')}</div>`
    : '';

  const connectionsHTML = analysis.connections?.length
    ? `<div class="synthesis-connections">
        ${analysis.connections
          .map(
            (c) => `<article class="connection-card">
              <h4>${esc(c.title)}</h4>
              <p>${esc(c.explanation)}</p>
              ${
                c.refs?.length
                  ? `<div class="connection-refs">${c.refs
                      .map(
                        (ref) =>
                          `<button type="button" class="connection-ref-btn" data-jump-ref="${esc(ref)}">${esc(ref)}</button>`,
                      )
                      .join('')}</div>`
                  : ''
              }
            </article>`,
          )
          .join('')}
      </div>`
    : '';

  const questionsHTML = analysis.questions?.length
    ? `<div>
        <p class="eyebrow">PREGUNTAS PARA TU CUADERNO</p>
        <ul class="synthesis-questions">${analysis.questions
          .map((q) => `<li>${esc(q)}</li>`)
          .join('')}</ul>
      </div>`
    : '';

  return `<section class="book-synthesis-card" id="bookSynthesisSection">
    <div class="book-synthesis-head">
      <div>
        <p class="eyebrow">SÍNTESIS LITERARIA · ${analysis.sourceCount} FRAGMENTOS ANALIZADOS</p>
        <h3>Mapa de ideas y conexiones</h3>
      </div>
      <button type="button" class="mini" id="runBookSynthesis">Regenerar análisis</button>
    </div>
    <div class="synthesis-summary">${summaryParagraphs}</div>
    ${themesLine}
    ${connectionsHTML}
    ${questionsHTML}
    <div class="synthesis-footer">
      <small class="muted">Actualizado el ${new Date(analysis.updatedAt).toLocaleDateString('es-AR')}</small>
      <button type="button" class="secondary" id="chatBookSynthesis">${AI_SPARK}Conversar sobre esta síntesis</button>
    </div>
  </section>`;
}

async function renderDetail() {
  const b = activeBook;
  if (!b) return;
  const allNotes = await all<Note>('notes');
  const allEntries = await all<Entry>('entries');
  const allQuotes = await all<Quote>('quotes');
  const allAnalyses = await all<BookAnalysis>('analyses');

  const notes = allNotes.filter((n) => n.bookId === b.id);
  const entries = allEntries.filter((n) => n.bookId === b.id);
  const quotes = allQuotes.filter((q) => q.bookId === b.id);
  const analysis = allAnalyses.find((a) => a.bookId === b.id);

  const read = notes.filter((n) => n.read).length;
  const pagesToday = Number(b.readingLog?.[localDayKey()] || 0);

  const metaParts: string[] = [];
  if (b.rating) metaParts.push(`<strong>${renderStarsText(b.rating)}</strong>`);
  if (b.tags?.length) metaParts.push(b.tags.map((t) => esc(t)).join(' · '));

  $('#detailDialog')?.classList.toggle('chr-focus', detailTab === 'characters');
  const detailContent = $('#detailContent')!;
  detailContent.innerHTML = `<header class="book-page-header">
    <div class="book-page-cover">${coverHTML(b)}</div>
    <div class="book-page-heading">
      <p class="eyebrow">${statusNames[b.status] || 'Pendiente'}</p>
      <h1>${esc(b.title)}</h1>
      <p class="muted">${esc(b.author || 'Autor desconocido')}</p>
      ${metaParts.length ? `<p class="book-detail-meta-line">${metaParts.join(' · ')}</p>` : ''}
      <div class="book-page-actions">
      <button type="button" id="readingProgressOpen" class="reading-progress-trigger">
        <strong>Página ${b.currentPage || 0}${b.totalPages ? ` de ${b.totalPages}` : ''}</strong>
        <span>${
          b.totalPages
            ? `${Math.min(100, Math.round(((b.currentPage || 0) / b.totalPages) * 100))}% · `
            : ''
        }Hoy leíste ${pagesToday} ${pagesToday === 1 ? 'página' : 'páginas'}</span>
        <small>Tocá para actualizar tu avance</small>
      </button>
      <button type="button" id="openBookCharacters" class="primary book-characters-trigger">✦ Personajes</button>
      </div>
    </div>
  </header>
  <div class="detail-tabs">
    ${(
      [
        ['notes', 'Notas finales'],
        ['entries', 'Comentarios'],
        ['photos', 'Fotografías'],
        ['quotes', 'Citas'],
        ['review', 'Reseña'],
        ['settings', 'Ajustes'],
      ] as Array<[DetailTab, string]>
    )
      .map(
        ([k, v]) =>
          `<button data-detail-tab="${k}" class="${detailTab === k ? 'active' : ''}">${v}</button>`,
      )
      .join('')}
  </div>
  <div class="detail-panel" id="detailPanel"></div>`;

  $$('[data-detail-tab]').forEach((x) => {
    x.onclick = () => {
      detailTab = x.dataset.detailTab as DetailTab;
      void renderDetail();
    };
  });

  const p = $('#detailPanel')!;

  if (detailTab === 'settings') {
    p.innerHTML = `<section class="book-settings-section">
        <p class="eyebrow">DATOS DEL LIBRO</p>
        <p class="muted">Editorial: ${esc(b.publisher || '—')} · Año: ${esc(b.year || '—')} · Edición: ${esc(b.edition || '—')} · ISBN: ${esc(b.isbn || '—')}</p>
        <div class="panel-actions"><button class="secondary" id="editBook2">Editar ficha</button></div>
      </section>
      <section class="book-settings-section">
        <p class="eyebrow">NOTAS FINALES</p>
        <p class="muted">${notes.length} notas · ${read} leídas</p>
        <div class="panel-actions">
          <button class="secondary" id="importNotes">Importar JSON</button>
          <button class="secondary" id="exportNotes">Exportar JSON</button>
        </div>
      </section>
      <section class="book-settings-section danger-zone">
        <p class="eyebrow">LIBRO</p>
        <button type="button" class="danger-btn" id="deleteBook">Eliminar libro y sus registros</button>
      </section>`;
  }

  if (detailTab === 'review') {
    p.innerHTML = `<div class="content-heading">
        <div>
          <h2>Puntuación y reseña personal</h2>
          <p class="muted">Registrá tu valoración general y tus conclusiones al avanzar o terminar la lectura.</p>
        </div>
        <div class="review-head-tools">
          <button type="button" class="secondary" id="aiReviewDraftBtn">✦ Sugerir borrador con IA</button>
          <button type="button" class="secondary" id="askReviewGemini">${AI_SPARK}Debatir mi reseña con IA</button>
        </div>
      </div>
      <div class="review-panel">
        <div class="rating-field">
          <span class="field-label">Tu puntuación</span>
          <div id="detailStarsPicker" class="star-picker" role="group" aria-label="Puntuación del libro"></div>
        </div>
        <label for="detailReviewText">Reseña o balance de lectura</label>
        <textarea id="detailReviewText" maxlength="10000" placeholder="¿Qué ideas te quedaron? ¿A quién se lo recomendarías?">${esc(b.review || '')}</textarea>
        <div id="reviewSuggestedTags" class="review-suggested-tags"></div>
        <div class="review-actions">
          <span id="detailReviewStatus" class="review-status" aria-live="polite"></span>
          <button type="button" class="primary" id="saveDetailReview">Guardar reseña</button>
        </div>
      </div>`;

    const starsHost = $('#detailStarsPicker')!;
    let tempRating = b.rating ?? null;
    const renderDetailStars = (val: number | null) => {
      tempRating = val;
      renderInteractiveStars(starsHost, tempRating, async (next) => {
        renderDetailStars(next);
        if (!activeBook) return;
        activeBook.rating = next;
        activeBook.updatedAt = new Date().toISOString();
        activeBook = await pushBookToCloud(activeBook);
        books = await all<Book>('books');
        render();
        const statusEl = $('#detailReviewStatus');
        if (statusEl) statusEl.textContent = 'Puntuación guardada.';
      });
    };
    renderDetailStars(tempRating);

    $('#aiReviewDraftBtn')?.addEventListener('click', async () => {
      if (!activeBook) return;
      const btn = $<HTMLButtonElement>('#aiReviewDraftBtn')!;
      const statusEl = $('#detailReviewStatus')!;
      const textarea = $<HTMLTextAreaElement>('#detailReviewText')!;
      const tagsBox = $('#reviewSuggestedTags')!;

      if (!getPrivateGeminiKey()) {
        renderInlineKeyCTA(statusEl, 'Necesitás guardar tu API key personal de Gemini para sugerir un borrador.');
        return;
      }

      const original = btn.textContent || '✦ Sugerir borrador con IA';

      btn.disabled = true;
      btn.textContent = 'Redactando…';
      statusEl.textContent = 'Armando borrador con tus citas y anotaciones…';

      try {
        const ai = getAISettingsForTask('analysis');
        const res = await requestGeminiFeature('review-draft', {
            bookTitle: activeBook.title,
            bookAuthor: activeBook.author || '',
            rating: tempRating,
            existingTags: getAllLibraryTags(),
            currentReview: textarea.value.trim(),
            quotes: quotes.map((q) => ({ text: q.text, page: q.page, analysis: q.analysis })),
            entries: entries.map((e) => ({ page: e.page, title: e.title, text: e.text, comment: e.comment })),
            notes: notes.filter((n) => n.comment).map((n) => ({ number: n.number, comment: n.comment })),
            model: ai.model,
            thinking: ai.thinking,
          });
        const data = await res.json();
        if (!res.ok) {
          const err: any = Error(data.error || `Error HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        const draft = String(data.reviewDraft || '').trim();
        if (!draft) throw Error('Gemini no devolvió un borrador.');

        if (textarea.value.trim()) {
          const replace = await showConfirmDialog({
            eyebrow: 'BORRADOR DE RESEÑA',
            title: '¿Reemplazar la reseña actual?',
            message: 'Ya escribiste texto en la reseña. ¿Querés reemplazarlo con el borrador sugerido por la IA?',
            confirmLabel: 'Reemplazar',
          });
          if (!replace) {
            statusEl.textContent = 'Conservé tu texto actual.';
            return;
          }
        }

        textarea.value = draft;
        textarea.focus();
        statusEl.textContent = 'Borrador listo. Revisalo y tocá Guardar reseña para conservarlo.';

        const suggested: string[] = Array.isArray(data.suggestedTags) ? data.suggestedTags : [];
        const missingTags = suggested.filter(
          (tag) => !(activeBook?.tags || []).some((t) => t.toLowerCase() === tag.toLowerCase()),
        );
        if (missingTags.length) {
          tagsBox.innerHTML =
            '<span>Etiquetas sugeridas:</span>' +
            missingTags
              .map(
                (t) =>
                  `<button type="button" class="tag-suggestion-btn" data-add-review-tag="${esc(t)}">+ ${esc(t)}</button>`,
              )
              .join('');
          tagsBox.querySelectorAll<HTMLButtonElement>('[data-add-review-tag]').forEach((tagBtn) => {
            tagBtn.onclick = async () => {
              if (!activeBook) return;
              const nextTag = tagBtn.dataset.addReviewTag || '';
              if (!nextTag) return;
              const current = activeBook.tags || [];
              if (current.length >= 10) return;
              if (!current.some((t) => t.toLowerCase() === nextTag.toLowerCase())) {
                activeBook.tags = [...current, nextTag];
                activeBook.updatedAt = new Date().toISOString();
                activeBook = await pushBookToCloud(activeBook);
                books = await all<Book>('books');
                render();
                tagBtn.remove();
                statusEl.textContent = `Etiqueta «${nextTag}» agregada al libro.`;
              }
            };
          });
        } else {
          tagsBox.innerHTML = '';
        }
      } catch (err: any) {
        if (isAIKeyError(err)) {
          renderInlineKeyCTA(statusEl, err?.message || 'Revisá tu API key personal de Gemini.');
        } else {
          statusEl.textContent = `No se pudo generar el borrador: ${err?.message || err}`;
        }
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    $('#saveDetailReview')?.addEventListener('click', async () => {
      if (!activeBook) return;
      const text = $<HTMLTextAreaElement>('#detailReviewText')?.value.trim() || '';
      activeBook.review = text;
      activeBook.rating = tempRating;
      activeBook.updatedAt = new Date().toISOString();
      activeBook = await pushBookToCloud(activeBook);
      books = await all<Book>('books');
      render();
      const statusEl = $('#detailReviewStatus');
      if (statusEl) statusEl.textContent = 'Reseña guardada.';
    });

    $('#askReviewGemini')?.addEventListener('click', async () => {
      if (!activeBook) return;
      const review = $<HTMLTextAreaElement>('#detailReviewText')?.value.trim() || '';
      activeBook.review = review;
      activeBook.rating = tempRating;
      activeBook.updatedAt = new Date().toISOString();
      activeBook = await pushBookToCloud(activeBook);
      books = await all<Book>('books');
      const bookId = activeBook.id;
      const title = activeBook.title;
      void openGemini({
        bookId,
        conversationKey: `review__${sanitizeId(bookId)}`,
        extraText: `${commentDiscussionPrompt('mi reseña personal sobre este libro')}\n\nMi reseña:\n${review || '(todavía no escribí una reseña)'}`,
      });
      const statusEl = $('#detailReviewStatus');
      if (statusEl) statusEl.textContent = `Reseña guardada. Conversando sobre «${title}».`;
    });
  }

  if (detailTab === 'quotes') {
    const sortedQuotes = [...quotes].sort((a, b2) =>
      (b2.updatedAt || b2.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''),
    );
    const totalSources = quotes.length + entries.length + notes.filter((n) => n.comment).length;

    const quoteRefMap = new Map<string, string>();
    sortedQuotes.forEach((q, idx) => {
      quoteRefMap.set(`CITA-${idx + 1}`, q.id);
    });

    p.innerHTML = `<div class="content-heading">
        <div>
          <h2>Citas favoritas</h2>
          <p class="muted">Guardá fragmentos, capítulos, páginas, tus ideas y fotos. Podés conversar cada cita o analizar conexiones entre todas.</p>
        </div>
        <div class="content-heading-actions">
          <button class="secondary" id="analyzeBookQuotes" ${totalSources < 2 || isAnalyzingBook ? 'disabled' : ''}>✦ Analizar conexiones</button>
          <button class="primary" id="addQuote">＋ Guardar cita</button>
        </div>
      </div>
      ${renderBookSynthesisHTML(analysis, totalSources)}
      <div class="quote-collection">
        ${
          sortedQuotes.map((q, idx) => quoteCardHTML(q, b, false, `CITA-${idx + 1}`)).join('') ||
          '<p class="empty-inline">Todavía no guardaste citas de este libro.</p>'
        }
      </div>`;

    $('#analyzeBookQuotes')?.addEventListener('click', () => runBookSynthesis(b));
    $('#runBookSynthesis')?.addEventListener('click', () => runBookSynthesis(b));
    $('#chatBookSynthesis')?.addEventListener('click', () => {
      if (analysis) void openGemini({ bookId: b.id, analysis });
    });

    p.querySelectorAll<HTMLButtonElement>('[data-jump-ref]').forEach((btn) => {
      btn.onclick = () => {
        const ref = (btn.dataset.jumpRef || '').trim().toUpperCase();
        const quoteId = quoteRefMap.get(ref);
        if (quoteId) {
          const cardEl = p.querySelector<HTMLElement>(`[data-quote-id="${quoteId}"]`);
          if (cardEl) {
            cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            cardEl.classList.add('quote-highlight');
            setTimeout(() => cardEl.classList.remove('quote-highlight'), 1800);
          }
        }
      };
    });
  }

  if (detailTab === 'notes') {
    const ordered = [...notes].sort(
      (a, b2) => (a.section || 1) - (b2.section || 1) || (a.number || 0) - (b2.number || 0),
    );
    let lastSection = 0;
    const noteRows = ordered
      .map((n) => {
        const section = n.section || 1;
        const heading = section !== lastSection ? `<h3 class="note-section">Sección ${section}</h3>` : '';
        lastSection = section;
        return `${heading}<div class="note-row ${n.read ? 'read' : ''}" data-ai-note="${esc(n.id)}">
          <button type="button" class="note-read-toggle" data-toggle-note="${esc(n.id)}" aria-pressed="${n.read}" title="${
            n.read ? 'Marcar como no leída' : 'Marcar como leída'
          }">
            <span class="note-num" aria-hidden="true">${n.read ? '✓' : esc(n.number)}</span>
            <span class="note-body">
              <strong>Nota ${esc(n.number)}</strong>
              <small> · ${
                n.referencePage != null
                  ? 'Referencia p. ' + n.referencePage
                  : 'Sin página de referencia'
              }${n.endPage != null ? ' · Nota p. ' + n.endPage : ''}${
                n.read ? ' · Leída' : ''
              }</small>
              <span class="note-text">${esc(n.text)}</span>
              ${n.comment ? `<span class="note-comment"><strong>Mi comentario:</strong> ${esc(n.comment)}</span>` : ''}
            </span>
          </button>
          ${renderSubannotations(n.subannotations)}
          ${renderAiSubcomments(n.aiSubcomments)}
          <div class="note-actions">
            ${aiIconButton('data-ask-note', n.id, n.comment ? 'Debatir mi comentario con la IA' : 'Preguntar a la IA')}
            <button type="button" class="comment-note-btn" data-comment-note="${esc(n.id)}" title="Comentar nota">${
              n.comment ? 'Editar comentario' : '＋ Comentario'
            }</button>
            <button data-delete-note="${esc(n.id)}" title="Eliminar" aria-label="Eliminar nota ${esc(n.number)}">×</button>
          </div>
        </div>`;
      })
      .join('');

    p.innerHTML = `<div class="content-heading">
        <div>
          <h2>Notas finales</h2>
          <p class="muted">${read} de ${notes.length} leídas · Tocá una nota para marcarla · mantenela apretada (o clic derecho) para preguntarle a la IA.</p>
        </div>
        <button class="primary" id="addManualNote">＋ Añadir nota</button>
      </div>
      ${
        noteRows ||
        '<p class="empty-inline">Todavía no hay notas. Podés agregar una desde acá o importar un JSON en Ajustes.</p>'
      }`;
  }

  if (detailTab === 'entries' || detailTab === 'photos') {
    const filtered = entries.filter((x) => detailTab === 'entries' || x.photo);
    p.innerHTML = `<div class="content-heading">
        <div>
          <h2>${detailTab === 'entries' ? 'Comentarios' : 'Fotografías'}</h2>
          <p class="muted">${filtered.length} ${
            detailTab === 'entries' ? (filtered.length === 1 ? 'comentario' : 'comentarios') : 'fotografías'
          }${detailTab === 'entries' ? ' · Tus ideas quedan como contexto para conversar con la IA.' : ' · Mantené apretada una para preguntarle a la IA (o clic derecho).'}</p>
        </div>
        <button class="primary" id="addAnnotation">＋ Nuevo comentario</button>
      </div>
      ${
        filtered
          .map(
            (x) => `<article class="journal-item" data-ai-entry="${esc(x.id)}">
              <small>PÁGINA ${x.page} · ${new Date(x.createdAt).toLocaleDateString('es-AR')}</small>
              ${x.title ? `<h3>${esc(x.title)}</h3>` : ''}
              <p>${esc(x.text || '')}</p>
              ${x.comment ? `<p class="entry-personal-comment"><strong>Mi comentario:</strong> ${esc(x.comment)}</p>` : ''}
              ${renderSubannotations(x.subannotations)}
              ${renderAiSubcomments(x.aiSubcomments)}
              ${
                x.photo
                  ? `<img class="annotation-photo-thumb" data-open-photo="${esc(x.id)}" src="${esc(x.photo)}" alt="Abrir fotografía">`
                  : ''
              }
              <div class="annotation-actions">
                <button class="mini" data-edit-entry="${esc(x.id)}">Editar comentario</button>
                ${aiIconButton('data-ask-entry', x.id, 'Conversar sobre este comentario con la IA')}
                <button class="mini" data-delete-entry="${esc(x.id)}">Eliminar</button>
              </div>
            </article>`,
          )
          .join('') ||
        `<p class="empty-inline">Todavía no hay ${
          detailTab === 'entries' ? 'comentarios' : 'fotografías'
        }.</p>`
      }`;
  }

  $('#readingProgressOpen')?.addEventListener('click', () => openReadingProgressDialog(b));
  $('#openBookCharacters')?.addEventListener('click', () => {
    detailTab = 'characters';
    void renderDetail();
  });
  $('#addQuote')?.addEventListener('click', () => openQuoteForm(b.id));
  if (detailTab === 'quotes') bindQuoteActions(p);
  if (detailTab === 'characters') await (await loadCharactersFeature()).renderCharactersPanel(p, b);
  $('#editBook2')?.addEventListener('click', () => {
    $<HTMLDialogElement>('#detailDialog')?.close();
    openBookForm(b);
  });
  $('#addAnnotation')?.addEventListener('click', () => openAnnotation(b.id));
  $('#importNotes')?.addEventListener('click', () => {
    pendingImport = null;
    ($<HTMLTextAreaElement>('#jsonText')!).value = '';
    ($<HTMLInputElement>('#jsonFile')!).value = '';
    $('#importBookTitle')!.textContent = b.title;
    $('#jsonPreview')!.textContent = 'Pegá un JSON o seleccioná un archivo…';
    ($<HTMLButtonElement>('#importNotesBtn')!).disabled = true;
    $<HTMLDialogElement>('#noteDialog')?.showModal();
  });
  $('#addManualNote')?.addEventListener('click', () => {
    $<HTMLFormElement>('#manualNoteForm')?.reset();
    $('#manualBookTitle')!.textContent = b.title;
    $('#manualNoteError')!.textContent = '';
    const refInput = $<HTMLInputElement>('#manualReferencePage')!;
    refInput.disabled = true;
    refInput.required = false;
    $('#manualReferenceLabel')?.classList.add('hidden');
    $<HTMLDialogElement>('#manualNoteDialog')?.showModal();
  });
  $('#exportNotes')?.addEventListener('click', async () => {
    const ns = (await all<Note>('notes')).filter((n) => n.bookId === b.id);
    download(
      {
        schema_version: 1,
        book: { title: b.title, author: b.author },
        notes: ns.map((n) => ({
          number: n.number,
          ...((n.section || 1) > 1 ? { section: n.section } : {}),
          reference_page: n.referencePage,
          end_page: n.endPage,
          text: n.text,
          comment: n.comment,
          read: n.read,
        })),
      },
      `${slug(b.title)}-notas.json`,
    );
  });

  $$('[data-toggle-note]').forEach((x) => {
    x.onclick = async () => {
      const noteId = x.dataset.toggleNote!;
      const n =
        (await get<Note>('notes', noteId)) ||
        (await all<Note>('notes')).find((item) => item.id === noteId || sanitizeId(item.id) === sanitizeId(noteId));
      if (!n) return;
      n.read = !n.read;
      const row = x.closest<HTMLElement>('.note-row');
      if (row) row.classList.toggle('read', n.read);
      x.setAttribute('aria-pressed', String(n.read));
      const numBadge = x.querySelector('.note-num');
      if (numBadge) numBadge.textContent = n.read ? '✓' : String(n.number);
      await pushNoteToCloud(n);
      await renderDetail();
    };
  });

  $$('[data-delete-note]').forEach((x) => {
    x.onclick = async () => {
      const ok = await showConfirmDialog({
        eyebrow: 'NOTA FINAL',
        title: '¿Eliminar esta nota?',
        message: 'La nota y su conversación con la IA se borrarán de este libro.',
        confirmLabel: 'Eliminar',
        danger: true,
      });
      if (ok) {
        const noteId = x.dataset.deleteNote!;
        await deleteFromCloud('notes', noteId);
        await deleteFromCloud('conversations', `note__${noteId}`);
        await renderDetail();
      }
    };
  });

  $$('[data-comment-note]').forEach((x) => {
    x.onclick = async () => {
      const n = await get<Note>('notes', x.dataset.commentNote!);
      if (!n) return;
      ($<HTMLInputElement>('#commentNoteId')!).value = n.id;
      $('#commentNoteLabel')!.textContent = `Nota ${n.number}${
        n.section > 1 ? ` · Sección ${n.section}` : ''
      }`;
      ($<HTMLTextAreaElement>('#noteCommentText')!).value = n.comment || '';
      $<HTMLDialogElement>('#noteCommentDialog')?.showModal();
    };
  });

  $$('[data-open-photo]').forEach((x) => {
    x.onclick = () => openPhoto(x.dataset.openPhoto!);
  });

  $$('[data-edit-entry]').forEach((x) => {
    x.onclick = async () => {
      const entry = await get<Entry>('entries', x.dataset.editEntry!);
      if (entry) openAnnotation(entry.bookId, entry);
    };
  });

  $$('[data-ask-note]').forEach((x) => {
    x.onclick = async () => {
      const note = await get<Note>('notes', x.dataset.askNote!);
      if (!note) return;
      void openGemini({
        noteId: note.id,
        extraText: note.comment ? commentDiscussionPrompt('mi comentario sobre esta nota final') : '',
      });
    };
  });

  $$('[data-ask-entry]').forEach((x) => {
    x.onclick = async () => {
      const entry = await get<Entry>('entries', x.dataset.askEntry!);
      if (!entry) return;
      void openGemini({
        entryId: entry.id,
        extraText: detailTab === 'entries'
          ? `Tomá mi comentario sobre «${activeBook?.title || 'este libro'}» como referencia para esta charla. Quiero poder hacerte cualquier pregunta sobre mi interpretación y recibir una respuesta crítica y razonada.`
          : entry.comment ? commentDiscussionPrompt('mi comentario sobre esta anotación o fotografía') : '',
      });
    };
  });

  $$('[data-delete-entry]').forEach((x) => {
    x.onclick = async () => {
      const ok = await showConfirmDialog({
        eyebrow: detailTab === 'entries' ? 'COMENTARIO' : 'ANOTACIÓN',
        title: detailTab === 'entries' ? '¿Eliminar este comentario?' : '¿Eliminar este registro?',
        message: detailTab === 'entries'
          ? 'Se eliminará este comentario y su conversación con la IA.'
          : 'Se eliminará la anotación junto con su foto si tuviera una.',
        confirmLabel: 'Eliminar',
        danger: true,
      });
      if (ok) {
        const entryId = x.dataset.deleteEntry!;
        await deleteFromCloud('entries', entryId);
        await deleteFromCloud('conversations', `entry__${entryId}`);
        await renderDetail();
      }
    };
  });

  $('#deleteBook')?.addEventListener('click', async () => {
    const ok = await showConfirmDialog({
      eyebrow: 'ELIMINAR LIBRO',
      title: `¿Eliminar «${b.title}»?`,
      message: 'Se borrarán el libro y todas sus notas, anotaciones, citas y reseñas guardadas.',
      confirmLabel: 'Sí, eliminar',
      danger: true,
    });
    if (!ok) return;
    const btn = $<HTMLButtonElement>('#deleteBook');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Eliminando…';
    }
    for (const n of notes) {
      await deleteFromCloud('notes', n.id);
      await deleteFromCloud('conversations', `note__${n.id}`);
    }
    for (const x of entries) {
      await deleteFromCloud('entries', x.id);
      await deleteFromCloud('conversations', `entry__${x.id}`);
    }
    for (const q of quotes) {
      await deleteFromCloud('quotes', q.id);
      await deleteFromCloud('conversations', `quote__${q.id}`);
    }
    if (analysis) {
      await deleteFromCloud('analyses', analysis.id);
    }
    await (await loadCharactersFeature()).purgeBookCharacters(b.id);
    await deleteFromCloud('conversations', `book__${b.id}`);
    await deleteFromCloud('conversations', `review__${sanitizeId(b.id)}`);
    await deleteFromCloud('books', b.id);
    activeBook = null;
    books = await all<Book>('books');
    render();
    $<HTMLDialogElement>('#detailDialog')?.close();
  });
}

async function runBookSynthesis(book: Book) {
  if (isAnalyzingBook) return;
  const quotes = (await all<Quote>('quotes'))
    .filter((q) => q.bookId === book.id)
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  const entries = (await all<Entry>('entries')).filter((e) => e.bookId === book.id && (e.text || e.title || e.comment));
  const notes = (await all<Note>('notes')).filter((n) => n.bookId === book.id && n.comment);

  const items: Array<{ refId: string; kindLabel: string; location: string; text: string; comment?: string }> = [];
  quotes.forEach((q, idx) => {
    items.push({
      refId: `CITA-${idx + 1}`,
      kindLabel: 'Cita favorita',
      location: [q.chapter, q.page != null ? `pág. ${q.page}` : ''].filter(Boolean).join(' · '),
      text: q.text,
      comment: q.analysis || '',
    });
  });
  entries.forEach((e, idx) => {
    items.push({
      refId: `ANOT-${idx + 1}`,
      kindLabel: 'Anotación',
      location: `pág. ${e.page}`,
      text: `${e.title ? e.title + ': ' : ''}${e.text || ''}`,
      comment: e.comment || '',
    });
  });
  notes.forEach((n) => {
    items.push({
      refId: `NOTA-${n.number}`,
      kindLabel: 'Nota comentada',
      location: n.referencePage != null ? `ref. p. ${n.referencePage}` : '',
      text: n.text,
      comment: n.comment || '',
    });
  });

  if (items.length < 2) {
    await showConfirmDialog({
      eyebrow: 'SÍNTESIS LITERARIA',
      title: 'Falta material para analizar',
      message:
        'Necesitás al menos 2 citas, anotaciones o notas comentadas en este libro para generar el mapa de conexiones.',
      noticeOnly: true,
    });
    return;
  }

  if (!getPrivateGeminiKey()) {
    const goSettings = await showConfirmDialog({
      eyebrow: 'SÍNTESIS LITERARIA CON IA',
      title: 'Configurá tu API key personal',
      message: 'Para analizar conexiones con IA necesitás guardar tu API key gratuita de Google AI Studio en Ajustes.',
      confirmLabel: 'Ir a Ajustes de IA',
      cancelLabel: 'Cerrar',
    });
    if (goSettings) openAISettingsGuide();
    return;
  }

  isAnalyzingBook = true;
  await renderDetail();

  try {
    const aiSettings = getAISettingsForTask('analysis');
    const res = await requestGeminiFeature('book-synthesis', {
        bookTitle: book.title,
        bookAuthor: book.author || '',
        bookTags: book.tags || [],
        items,
        model: aiSettings.model,
        thinking: aiSettings.thinking,
      });
    const data = await res.json();
    if (!res.ok) {
      const err: any = new Error(data.error || `Error HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const analysisRecord: BookAnalysis = {
      id: `analysis__${sanitizeId(book.id)}`,
      bookId: book.id,
      summary: data.analysis.summary,
      themes: data.analysis.themes || [],
      connections: data.analysis.connections || [],
      questions: data.analysis.questions || [],
      sourceCount: items.length,
      model: data.model || aiSettings.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await pushAnalysisToCloud(analysisRecord);
  } catch (err: any) {
    if (isAIKeyError(err)) {
      const goSettings = await showConfirmDialog({
        eyebrow: 'SÍNTESIS LITERARIA CON IA',
        title: 'Revisá tu API key de Gemini',
        message: String(err?.message || err),
        confirmLabel: 'Ir a Ajustes de IA',
        cancelLabel: 'Cerrar',
      });
      if (goSettings) openAISettingsGuide();
    } else {
      await showConfirmDialog({
        eyebrow: 'SÍNTESIS LITERARIA',
        title: 'No se pudo completar el análisis',
        message: String(err?.message || err),
        noticeOnly: true,
      });
    }
  } finally {
    isAnalyzingBook = false;
    await renderDetail();
  }
}

function readingDateLabel(key: string) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day, 12).toLocaleDateString('es-AR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function openReadingProgressDialog(book: Book) {
  $('#readingProgressBook')!.textContent = book.title;
  const pageInput = $<HTMLInputElement>('#readingProgressPage')!;
  pageInput.value = String(book.currentPage || 0);
  pageInput.max = book.totalPages ? String(book.totalPages) : '';
  const today = Number(book.readingLog?.[localDayKey()] || 0);
  $('#readingProgressHint')!.textContent = `Hoy ya registraste ${today} ${
    today === 1 ? 'página' : 'páginas'
  }. Si avanzás, se suman las páginas nuevas.`;
  const history = Object.entries(book.readingLog || {})
    .filter(([, pages]) => Number(pages) > 0)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 7);
  $('#readingHistory')!.innerHTML = history.length
    ? `<p class="eyebrow">LECTURAS RECIENTES</p>${history
        .map(
          ([day, pages]) =>
            `<div><span>${esc(readingDateLabel(day))}</span><strong>${Number(pages)} pág.</strong></div>`,
        )
        .join('')}`
    : '';
  $<HTMLDialogElement>('#readingProgressDialog')?.showModal();
  pageInput.focus();
}

function quoteCardHTML(
  quote: Quote,
  book: Book | undefined,
  showBook = false,
  refLabel?: string,
): string {
  const photos = (quote.photos || [])
    .map(
      (src, index) =>
        `<button type="button" class="quote-photo-thumb" data-open-quote-photo="${esc(quote.id)}" data-photo-index="${index}" aria-label="Abrir foto ${index + 1} de la cita"><img src="${esc(src)}" alt="Foto de la cita"></button>`,
    )
    .join('');

  return `<article class="favorite-quote" data-quote-id="${esc(quote.id)}">
    <blockquote>${esc(quote.text)}</blockquote>
    <p class="quote-source">${refLabel ? `<strong>${esc(refLabel)}</strong> · ` : ''}${
      showBook ? `<strong>${esc(book?.title || 'Libro eliminado')}</strong> · ` : ''
    }${quote.chapter ? esc(quote.chapter) : 'Capítulo sin indicar'}${
      quote.page != null ? ` · pág. ${esc(quote.page)}` : ''
    }</p>
    ${quote.analysis ? `<p class="quote-analysis"><strong>Mi comentario:</strong> ${esc(quote.analysis)}</p>` : ''}
    ${renderSubannotations(quote.subannotations)}
    ${renderAiSubcomments(quote.aiSubcomments)}
    ${photos ? `<div class="quote-photos">${photos}</div>` : ''}
    <div class="annotation-actions">
      <button type="button" class="mini" data-edit-quote="${esc(quote.id)}">Editar cita</button>
      ${aiIconButton('data-ask-quote', quote.id, quote.analysis ? 'Debatir mi comentario con la IA' : 'Conversar con la IA')}
      <button type="button" class="mini" data-delete-quote="${esc(quote.id)}">Eliminar</button>
    </div>
  </article>`;
}

async function renderQuoteCollection() {
  const quotes = await all<Quote>('quotes');
  quotes.sort((a, b) =>
    (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''),
  );
  const options = books.map((b) => `<option value="${esc(b.id)}">${esc(b.title)}</option>`).join('');
  const container = $('#quoteCollection')!;
  container.innerHTML = `<div class="quote-add-global">
      <select id="quoteBookForNew" aria-label="Libro de la cita">
        <option value="">Elegí un libro…</option>
        ${options}
      </select>
      <button type="button" id="addQuoteGlobal" class="primary" ${books.length ? '' : 'disabled'}>＋ Nueva cita</button>
    </div>
    ${
      quotes.map((q) => quoteCardHTML(q, books.find((b) => b.id === q.bookId), true)).join('') ||
      '<p class="empty-inline">Todavía no guardaste citas favoritas.</p>'
    }`;

  $('#addQuoteGlobal')!.onclick = () => {
    const bookSelect = $<HTMLSelectElement>('#quoteBookForNew')!;
    if (bookSelect.value) openQuoteForm(bookSelect.value);
    else bookSelect.focus();
  };
  bindQuoteActions(container);
}

function bindQuoteActions(container: HTMLElement) {
  container.onclick = async (e) => {
    const target = e.target as HTMLElement;
    const photo = target.closest<HTMLElement>('[data-open-quote-photo]');
    const edit = target.closest<HTMLElement>('[data-edit-quote]');
    const ask = target.closest<HTMLElement>('[data-ask-quote]');
    const remove = target.closest<HTMLElement>('[data-delete-quote]');
    if (photo) {
      await openQuotePhoto(photo.dataset.openQuotePhoto!, Number(photo.dataset.photoIndex));
      return;
    }
    if (edit) {
      const quote = await get<Quote>('quotes', edit.dataset.editQuote!);
      if (quote) openQuoteForm(quote.bookId, quote);
      return;
    }
    if (ask) {
      const quote = await get<Quote>('quotes', ask.dataset.askQuote!);
      if (quote) void openGemini({
        bookId: quote.bookId,
        quoteId: quote.id,
        extraText: quote.analysis ? commentDiscussionPrompt('mi comentario sobre esta cita') : '',
      });
      return;
    }
    if (remove) {
      const quote = await get<Quote>('quotes', remove.dataset.deleteQuote!);
      if (!quote) return;
      const ok = await showConfirmDialog({
        eyebrow: 'CITAS',
        title: '¿Eliminar esta cita y sus fotos?',
        message: 'Se borrará la cita guardada junto con su análisis y las imágenes adjuntas.',
        confirmLabel: 'Eliminar',
        danger: true,
      });
      if (!ok) return;
      await deleteFromCloud('quotes', quote.id);
      await deleteFromCloud('conversations', `quote__${quote.id}`);
      if ($<HTMLDialogElement>('#detailDialog')?.open && activeBook?.id === quote.bookId) {
        await renderDetail();
      }
      if ($('#quotesView')?.classList.contains('active')) {
        await renderQuoteCollection();
      }
    }
  };
}

function openQuoteForm(bookId: string, quote: Quote | null = null) {
  quoteOCRGeneration++;
  quotePhotoData = [...(quote?.photos || [])];
  $<HTMLFormElement>('#quoteForm')?.reset();
  ($<HTMLInputElement>('#quoteId')!).value = quote?.id || '';
  ($<HTMLInputElement>('#quoteBookId')!).value = bookId;
  $('#quoteDialogTitle')!.textContent = quote ? 'Editar cita' : 'Guardar una cita';
  ($<HTMLTextAreaElement>('#quoteText')!).value = quote?.text || '';
  ($<HTMLInputElement>('#quoteChapter')!).value = quote?.chapter || '';
  ($<HTMLInputElement>('#quotePage')!).value = quote?.page != null ? String(quote.page) : '';
  ($<HTMLTextAreaElement>('#quoteAnalysis')!).value = quote?.analysis || '';
  $('#quotePhotoStatus')!.textContent = `${quotePhotoData.length} de 5 fotos guardadas. Podés agregar o quitar fotos.`;
  renderQuotePhotoPreview();
  $<HTMLDialogElement>('#quoteDialog')?.showModal();
}

function renderQuotePhotoPreview() {
  $('#quotePhotoPreview')!.innerHTML = quotePhotoData
    .map(
      (src, index) => `<div class="quote-photo-edit">
        <img src="${esc(src)}" alt="Foto ${index + 1}">
        <button type="button" class="quote-photo-transcribe" data-transcribe-quote-photo="${index}" aria-label="Extraer texto de la foto ${index + 1}">Extraer texto</button>
        <button type="button" class="quote-photo-remove" data-remove-quote-photo="${index}" aria-label="Quitar foto ${index + 1}">×</button>
      </div>`,
    )
    .join('');
}

function optimizeImagePhoto(file: File, maxSide = 1400, quality = 0.78): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      }
      URL.revokeObjectURL(url);
      try {
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(Error('No se pudo leer una de las imágenes.'));
    };
    image.src = url;
  });
}

async function transcribeQuotePhoto(index: number, button: HTMLButtonElement) {
  const image = quotePhotoData[index];
  if (!image) return;
  const statusEl = $('#quotePhotoStatus');
  if (!getPrivateGeminiKey()) {
    renderInlineKeyCTA(statusEl, 'Necesitás tu API key personal de Gemini para extraer texto de fotos.');
    return;
  }
  const generation = quoteOCRGeneration;
  const label = button.textContent || 'Extraer texto';
  $$<HTMLButtonElement>('[data-transcribe-quote-photo],[data-remove-quote-photo]').forEach(
    (item) => (item.disabled = true),
  );
  button.textContent = 'Leyendo…';
  if (statusEl) {
    statusEl.textContent = 'Gemini está leyendo la foto. Después vas a poder corregir el texto.';
  }
  try {
    const [header, data] = image.split(',', 2);
    const mimeType = header.match(/data:(.*?);base64/)?.[1] || 'image/jpeg';
    const aiSettings = getAISettingsForTask('image');
    const res = await requestGeminiFeature('transcribe', {
      mimeType, data, model: aiSettings.model, thinking: aiSettings.thinking,
    });
    const result = await res.json();
    if (!res.ok) {
      const err: any = Error(result.error || `Error HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const transcript = String(result.text || '').trim();
    if (!transcript) throw Error('Gemini no devolvió una transcripción.');
    if (generation !== quoteOCRGeneration || !$<HTMLDialogElement>('#quoteDialog')?.open) return;

    const quoteText = $<HTMLTextAreaElement>('#quoteText')!;
    const current = quoteText.value.trim();
    if (current) {
      const ok = await showConfirmDialog({
        eyebrow: 'TRANSCRIPCIÓN',
        title: '¿Reemplazar el texto actual?',
        message: 'Ya escribiste texto en esta cita. ¿Querés reemplazarlo con la transcripción extraída de la foto?',
        confirmLabel: 'Reemplazar',
      });
      if (!ok) {
        if (statusEl) statusEl.textContent = 'Conservé el texto que ya tenías.';
        return;
      }
    }
    quoteText.value = transcript;
    quoteText.focus();
    if (statusEl) statusEl.textContent = 'Texto extraído. Revisalo y corregilo antes de guardar la cita.';
  } catch (error: any) {
    if (generation === quoteOCRGeneration && $<HTMLDialogElement>('#quoteDialog')?.open) {
      if (isAIKeyError(error)) {
        renderInlineKeyCTA(statusEl, error?.message || 'Revisá tu API key personal de Gemini.');
      } else if (statusEl) {
        statusEl.textContent = `No se pudo extraer el texto: ${error.message}`;
      }
    }
  } finally {
    if (generation === quoteOCRGeneration && $<HTMLDialogElement>('#quoteDialog')?.open) {
      $$<HTMLButtonElement>('[data-transcribe-quote-photo],[data-remove-quote-photo]').forEach(
        (item) => (item.disabled = false),
      );
      const currentButton = $<HTMLButtonElement>(`[data-transcribe-quote-photo="${index}"]`);
      if (currentButton) currentButton.textContent = label;
    }
  }
}

async function openQuotePhoto(quoteId: string, index: number) {
  const quote = await get<Quote>('quotes', quoteId);
  const photo = quote?.photos?.[index];
  if (!photo || !quote) return;
  const book = books.find((b) => b.id === quote.bookId);
  $<HTMLImageElement>('#photoViewerImage')!.src = photo;
  $('#photoViewerMeta')!.textContent = `${book?.title || 'Libro'}${
    quote.chapter ? ` · ${quote.chapter}` : ''
  }${quote.page != null ? ` · Página ${quote.page}` : ''}`;
  $('#photoViewerTitle')!.textContent = 'Foto de una cita';
  $('#photoViewerComment')!.textContent = [quote.text, quote.analysis ? `Mi comentario: ${quote.analysis}` : '']
    .filter(Boolean).join('\n\n');
  $('#editPhotoAnnotation')?.classList.add('hidden');
  $('#askPhotoGemini')!.onclick = () => {
    $<HTMLDialogElement>('#photoViewerDialog')?.close();
    void openGemini({
      bookId: quote.bookId,
      quoteId: quote.id,
      image: photo,
      extraText: quote.analysis ? commentDiscussionPrompt('mi comentario sobre esta cita y su fotografía') : '',
    });
  };
  $<HTMLDialogElement>('#photoViewerDialog')?.showModal();
}

function previewNoteJSON(raw: string) {
  try {
    const { obj, notes } = validateNotesJSON(raw);
    pendingImport = { obj, notes };
    const sections = new Set(notes.map((n: any) => n.section)).size;
    $('#jsonPreview')!.textContent =
      `Libro declarado: ${obj.book?.title || '(sin título)'}\nLibro destino: ${
        activeBook?.title || '(ninguno)'
      }\nNotas válidas: ${notes.length} · Secciones detectadas: ${sections}\n\n` +
      notes
        .slice(0, 8)
        .map(
          (n: any) =>
            `Sección ${n.section} · #${n.number}${
              n.referencePage != null ? ` · referencia p. ${n.referencePage}` : ''
            }${n.endPage != null ? ` · nota p. ${n.endPage}` : ''}: ${n.text.slice(0, 100)}`,
        )
        .join('\n') +
      (notes.length > 8 ? '\n…' : '');
    ($<HTMLButtonElement>('#importNotesBtn')!).disabled = !activeBook;
    return true;
  } catch (err: any) {
    pendingImport = null;
    $('#jsonPreview')!.textContent = 'No se puede importar: ' + err.message;
    ($<HTMLButtonElement>('#importNotesBtn')!).disabled = true;
    return false;
  }
}

function openAnnotation(bookId: string, entry: Entry | null = null) {
  annotationAsComment = Boolean(
    $<HTMLDialogElement>('#detailDialog')?.open && detailTab === 'entries' && activeBook?.id === bookId,
  );
  $<HTMLFormElement>('#annotationForm')?.reset();
  ($<HTMLInputElement>('#annotationBook')!).value = bookId;
  ($<HTMLInputElement>('#annotationId')!).value = entry?.id || '';
  $('#annotationTitle')!.textContent = annotationAsComment
    ? entry ? 'Editar comentario' : 'Nuevo comentario'
    : entry ? 'Editar anotación' : 'Nueva anotación';
  ($<HTMLInputElement>('#annotationPage')!).value = entry?.page != null
    ? String(entry.page)
    : annotationAsComment ? String(activeBook?.currentPage || 0) : '';
  ($<HTMLInputElement>('#annotationHeading')!).value = entry?.title || '';
  ($<HTMLTextAreaElement>('#annotationText')!).value = entry?.text || '';
  ($<HTMLTextAreaElement>('#annotationPersonalComment')!).value = entry?.comment || '';
  $('#annotationPageField')?.classList.toggle('hidden', annotationAsComment);
  $<HTMLInputElement>('#annotationPage')!.required = !annotationAsComment;
  $('#annotationHeadingField')?.classList.toggle('hidden', annotationAsComment);
  $('#annotationPersonalCommentLabel')?.classList.toggle('hidden', annotationAsComment);
  $<HTMLTextAreaElement>('#annotationPersonalComment')!.classList.toggle('hidden', annotationAsComment);
  $('#annotationPhotoField')?.classList.toggle('hidden', annotationAsComment);
  $('#annotationTextLabel')!.textContent = annotationAsComment ? 'Tu comentario' : 'Comentario / observación';
  $<HTMLTextAreaElement>('#annotationText')!.placeholder = annotationAsComment
    ? 'Este personaje me parece… ¿Qué idea, duda o interpretación querés conversar?'
    : '¿Qué querés conservar de esta página?';
  $('#askAnnotationGemini')!.textContent = annotationAsComment ? 'Guardar y preguntarle a la IA' : 'Guardar y debatir con IA';
  $('#annotationForm')!.querySelector<HTMLButtonElement>('.dialog-actions .primary')!.textContent = annotationAsComment
    ? 'Guardar comentario'
    : 'Guardar anotación';
  photoData = entry?.photo || null;
  updateAnnotationPhotoPreview(
    entry?.photo ? 'Ya hay una fotografía. Podés sacar o elegir otra para reemplazarla.' : '',
  );
  $<HTMLDialogElement>('#annotationDialog')?.showModal();
}

async function openPhoto(entryId: string) {
  const entry = await get<Entry>('entries', entryId);
  if (!entry?.photo) return;
  const book = books.find((x) => x.id === entry.bookId);
  $<HTMLImageElement>('#photoViewerImage')!.src = entry.photo;
  $('#photoViewerMeta')!.textContent = `${book?.title || 'Libro'} · Página ${entry.page}`;
  $('#photoViewerTitle')!.textContent = entry.title || 'Fotografía';
  $('#photoViewerComment')!.textContent = [
    entry.text || '',
    entry.comment ? `Mi comentario: ${entry.comment}` : '',
  ].filter(Boolean).join('\n\n');
  $('#editPhotoAnnotation')?.classList.remove('hidden');
  $('#editPhotoAnnotation')!.onclick = () => {
    $<HTMLDialogElement>('#photoViewerDialog')?.close();
    openAnnotation(entry.bookId, entry);
  };
  $('#askPhotoGemini')!.onclick = () => {
    $<HTMLDialogElement>('#photoViewerDialog')?.close();
    void openGemini({
      bookId: entry.bookId,
      entryId: entry.id,
      image: entry.photo!,
      extraText: entry.comment ? commentDiscussionPrompt('mi comentario sobre esta fotografía') : '',
    });
  };
  $<HTMLDialogElement>('#photoViewerDialog')?.showModal();
}

async function renderJournal() {
  const entries = await all<Entry>('entries');
  entries.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  $('#journalList')!.innerHTML =
    entries
      .map((x) => {
        const b = books.find((book) => book.id === x.bookId);
        return `<article class="journal-item" data-ai-entry="${esc(x.id)}">
          <small>${esc(b?.title || 'Libro eliminado')} · PÁGINA ${x.page}</small>
          <h3>${esc(x.title || 'Sin título')}</h3>
          <p>${esc(x.text || '')}</p>
          ${x.comment ? `<p class="entry-personal-comment"><strong>Mi comentario:</strong> ${esc(x.comment)}</p>` : ''}
          ${renderSubannotations(x.subannotations)}
          ${renderAiSubcomments(x.aiSubcomments)}
          ${
            x.photo
              ? `<img class="annotation-photo-thumb" data-open-photo="${esc(x.id)}" src="${esc(x.photo)}" alt="Abrir fotografía">`
              : ''
          }
          <div class="annotation-actions">
            <button class="mini" data-edit-entry="${esc(x.id)}">Editar anotación</button>
            ${aiIconButton('data-ask-entry', x.id, x.comment ? 'Debatir mi comentario con la IA' : 'Preguntar a la IA')}
          </div>
        </article>`;
      })
      .join('') || '<p class="empty-inline">Tus anotaciones y fotografías aparecerán acá.</p>';
}

function conflictPreview(record: Record<string, any>): string {
  const content = record.title || record.text || record.summary || record.review || '';
  return String(content).replace(/\s+/g, ' ').slice(0, 180) || 'El contenido de este registro cambió.';
}

async function renderSyncConflicts() {
  const host = $('#syncConflictsList');
  if (!host) return;
  const conflicts = await getSyncConflicts();
  host.replaceChildren();
  if (!conflicts.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No hay conflictos pendientes.';
    host.append(empty);
    return;
  }

  const storeLabels: Record<SyncConflict['storeName'], string> = {
    books: 'Libro', notes: 'Nota', entries: 'Anotación', quotes: 'Cita',
    analyses: 'Análisis', conversations: 'Conversación',
    characters: 'Personaje', characterRelations: 'Vínculo entre personajes',
  };
  for (const conflict of conflicts) {
    const card = document.createElement('article');
    card.className = 'sync-conflict-card';
    const title = document.createElement('strong');
    title.textContent = `${storeLabels[conflict.storeName]} · ${conflict.recordId}`;
    const detail = document.createElement('p');
    detail.textContent = `Versión local: ${conflictPreview(conflict.local)} · Versión remota: ${conflictPreview(conflict.remote)}`;
    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    for (const choice of ['local', 'remote'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = choice === 'local' ? 'secondary' : 'mini';
      button.dataset.conflictId = conflict.id;
      button.dataset.conflictChoice = choice;
      button.textContent = choice === 'local' ? 'Usar versión local' : 'Usar versión remota';
      actions.append(button);
    }
    card.append(title, detail, actions);
    host.append(card);
  }
}

async function openSyncConflictsDialog() {
  const dialog = $<HTMLDialogElement>('#syncConflictsDialog');
  if (!dialog) return;
  await renderSyncConflicts();
  if (!dialog.open) dialog.showModal();
}

async function updateAccountUI(status: SyncStatus, message: string, user: any) {
  const accountBtn = $('#accountBtn');
  const statusText = $('#syncStatusText');
  const signedOutView = $('#accountSignedOutView');
  const signedInView = $('#accountSignedInView');
  const avatar = $<HTMLImageElement>('#accountAvatar');
  const nameEl = $('#accountName');
  const emailEl = $('#accountEmail');

  if (statusText) {
    statusText.replaceChildren(document.createTextNode(message));
    if (status === 'conflict') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mini';
      button.textContent = 'Revisar conflictos';
      button.addEventListener('click', () => void openSyncConflictsDialog());
      statusText.append(document.createTextNode(' '), button);
    }
  }

  if (user) {
    const shortName = (user.displayName || user.email || 'Cuenta').split(' ')[0];
    if (accountBtn) accountBtn.textContent = `● ${shortName}`;
    signedOutView?.classList.add('hidden');
    signedInView?.classList.remove('hidden');
    if (nameEl) nameEl.textContent = user.displayName || 'Usuario de Librarium';
    if (emailEl) emailEl.textContent = user.email || '';
    if (avatar) {
      if (user.photoURL) {
        avatar.src = user.photoURL;
        avatar.classList.remove('hidden');
      } else {
        avatar.classList.add('hidden');
      }
    }
  } else {
    if (accountBtn) accountBtn.textContent = 'Iniciar sesión';
    signedOutView?.classList.remove('hidden');
    signedInView?.classList.add('hidden');
  }

  const adminCard = $('#adminFeedbackCard');
  const isAdmin = await isFeedbackAdmin(user);
  if (adminCard) {
    adminCard.classList.toggle('hidden', !isAdmin);
  }
  if (isAdmin) {
    void loadAdminFeature().then((feature) => Promise.all([
      feature.refreshAdminFeedbackSummary(),
      feature.archiveAdminSiteVisitsInBackground(),
    ]));
  } else {
    resetAdminBadges();
  }

  if ($<HTMLDialogElement>('#feedbackDialog')?.open) {
    void loadAdminFeature().then((feature) => feature.renderMyFeedbackList());
  }
}

function isInAppBrowser(): boolean {
  return /FBAN|FBAV|Instagram|WhatsApp|Telegram|Line\/|MicroMessenger/i.test(navigator.userAgent || '');
}

async function handleGoogleSignIn() {
  const statusEl = $('#syncStatusText');
  const dlg = $<HTMLDialogElement>('#settingsDialog');
  if (isInAppBrowser()) {
    if (statusEl) {
      statusEl.textContent =
        'Estás usando un navegador interno (WhatsApp/Instagram). Abrí Librarium en Chrome o Safari desde el menú ⋮ para iniciar sesión con Google.';
    }
    if (dlg && !dlg.open) dlg.showModal();
    return;
  }
  try {
    await signInWithGoogle();
  } catch (err: any) {
    if (statusEl) {
      if (err?.code === 'auth/popup-closed-by-user') {
        statusEl.textContent = 'Se cerró la ventana de inicio de sesión.';
      } else if (err?.code === 'auth/popup-blocked') {
        statusEl.textContent =
          'El navegador bloqueó la ventana de Google. Permití las ventanas emergentes e intentá de nuevo.';
      } else if (err?.code === 'auth/cancelled-popup-request') {
        statusEl.textContent = 'Se canceló el intento anterior. Volvé a tocar Continuar con Google.';
      } else if (err?.code === 'auth/disallowed-useragent') {
        statusEl.textContent =
          'Este navegador no admite inicio de sesión con Google. Abrí Librarium en Chrome o Safari.';
      } else if (err?.code === 'auth/network-request-failed') {
        statusEl.textContent = 'Sin conexión para conectar con Google. Verificá tu internet e intentá nuevamente.';
      } else if (err?.code === 'auth/unauthorized-domain') {
        statusEl.textContent = `El dominio actual (${window.location.hostname}) no está autorizado en Firebase Auth.`;
      } else {
        statusEl.textContent = `No se pudo iniciar sesión: ${err?.message || err}`;
      }
    }
    if (dlg && !dlg.open) dlg.showModal();
  }
}

async function handleGoogleSignOut() {
  await signOutUser();
}

function initAccountSettings() {
  $('#settingsOpen')!.onclick = async () => {
    $<HTMLDialogElement>('#settingsDialog')?.showModal();
    if (await isFeedbackAdmin(getSyncState().user)) void loadAdminFeature().then((feature) => feature.refreshAdminFeedbackSummary());
  };
  $('#accountBtn')!.onclick = () => {
    const { user } = getSyncState();
    if (user) {
      $<HTMLDialogElement>('#settingsDialog')?.showModal();
    } else {
      void handleGoogleSignIn();
    }
  };
  $('#googleSignInBtn')?.addEventListener('click', () => void handleGoogleSignIn());
  $('#googleSignOutBtn')?.addEventListener('click', () => void handleGoogleSignOut());
  $('#syncNowBtn')?.addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('#syncNowBtn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Sincronizando…';
    try {
      const count = await migrateLocalDataToCloud();
      $('#syncStatusText')!.textContent = count
        ? `Se subieron ${count} registros locales a la nube.`
        : 'Tu biblioteca local ya estaba al día con la nube.';
    } catch (err: any) {
      $('#syncStatusText')!.textContent = `Error al sincronizar: ${err?.message || err}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sincronizar datos locales';
    }
  });
  $('#syncConflictsList')?.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-conflict-choice]');
    if (!button?.dataset.conflictId) return;
    button.disabled = true;
    try {
      await resolveSyncConflict(
        button.dataset.conflictId,
        button.dataset.conflictChoice as 'local' | 'remote',
      );
      await renderSyncConflicts();
    } catch (error: any) {
      await showConfirmDialog({
        eyebrow: 'SINCRONIZACIÓN',
        title: 'No se pudo aplicar la versión',
        message: String(error?.message || error),
        noticeOnly: true,
      });
    } finally {
      button.disabled = false;
    }
  });
}

function initAskGesture() {
  const ITEM = '.note-row[data-ai-note],.journal-item[data-ai-entry]';
  const SKIP = 'button:not(.note-read-toggle),a,input,textarea,select';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pressed: HTMLElement | null = null;
  let sx = 0;
  let sy = 0;
  let fired = false;
  let firedAt = 0;
  let suppressUntil = 0;

  const resolve = (t: EventTarget | null): HTMLElement | null => {
    if (!(t instanceof Element)) return null;
    const el = t.closest<HTMLElement>(ITEM);
    return el && !t.closest(SKIP) ? el : null;
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pressed?.classList.remove('ai-pressing');
    pressed = null;
  };
  const ask = async (el: HTMLElement) => {
    firedAt = Date.now();
    if (el.dataset.aiNote) {
      const note = await get<Note>('notes', el.dataset.aiNote);
      if (note) void openGemini({
        noteId: note.id,
        extraText: note.comment ? commentDiscussionPrompt('mi comentario sobre esta nota final') : '',
      });
    } else if (el.dataset.aiEntry) {
      const entry = await get<Entry>('entries', el.dataset.aiEntry);
      if (entry) void openGemini({
        entryId: entry.id,
        extraText: entry.comment ? commentDiscussionPrompt('mi comentario sobre esta anotación o fotografía') : '',
      });
    }
  };

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.isPrimary === false) return;
    const el = resolve(e.target);
    if (!el) return;
    clear();
    pressed = el;
    sx = e.clientX;
    sy = e.clientY;
    el.classList.add('ai-pressing');
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      clear();
      navigator.vibrate?.(15);
      try {
        getSelection()?.removeAllRanges();
      } catch {}
      ask(el);
    }, 550);
  });
  document.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clear();
  });
  document.addEventListener('pointerup', () => {
    clear();
    if (fired) {
      fired = false;
      suppressUntil = Date.now() + 350;
    }
  });
  document.addEventListener('pointercancel', () => {
    clear();
    fired = false;
  });
  document.addEventListener(
    'click',
    (e) => {
      if (Date.now() < suppressUntil) {
        e.preventDefault();
        e.stopPropagation();
        suppressUntil = 0;
      }
    },
    true,
  );
  document.addEventListener('contextmenu', (e) => {
    const el = resolve(e.target);
    if (!el) return;
    e.preventDefault();
    if (Date.now() - firedAt < 1500) return;
    ask(el);
  });
}

type AiConvRow = {
  conv: Conversation;
  book: Book;
  label: string;
  target: string;
  question: string;
  answer: string;
  turns: number;
  seed: Parameters<typeof openGemini>[0];
};
let aiConvRows: AiConvRow[] = [];
let aiConvsReturn = false;
let aiConvsBannerTimer: ReturnType<typeof setTimeout> | undefined;

function plainSnippet(text: string, max: number): string {
  const clean = String(text || '').replace(/[*#`>_]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

async function loadAiConversationRows(): Promise<AiConvRow[]> {
  const [convs, notes, entries, quotes, analyses] = await Promise.all([
    all<Conversation>('conversations'),
    all<Note>('notes'),
    all<Entry>('entries'),
    all<Quote>('quotes'),
    all<BookAnalysis>('analyses'),
  ]);
  const rows: AiConvRow[] = [];
  for (const conv of convs) {
    if (!conv.history?.length) continue;
    const match = /^(note|entry|quote|book|review)(?:__|:)(.+)$/.exec(conv.id);
    if (!match) continue;
    const kind = match[1];
    const key = sanitizeId(match[2]);
    const findBook = (id?: string) => books.find((b) => b.id === (id || conv.bookId));
    let book: Book | undefined;
    let label = '';
    let target = '';
    let seed: AiConvRow['seed'] | null = null;

    if (kind === 'note') {
      const n = notes.find((x) => sanitizeId(x.id) === key);
      if (!n) continue;
      book = findBook(n.bookId);
      label = `Nota ${n.number}`;
      target = n.text;
      seed = { noteId: n.id };
    } else if (kind === 'entry') {
      const e = entries.find((x) => sanitizeId(x.id) === key);
      if (!e) continue;
      book = findBook(e.bookId);
      label = `Anotación · pág. ${e.page}`;
      target = e.title || e.text || '';
      seed = { entryId: e.id };
    } else if (kind === 'quote') {
      const q = quotes.find((x) => sanitizeId(x.id) === key);
      if (!q) continue;
      book = findBook(q.bookId);
      label = `Cita${q.page != null ? ` · pág. ${q.page}` : ''}`;
      target = q.text;
      seed = { quoteId: q.id };
    } else {
      book = books.find((b) => sanitizeId(b.id) === key) || findBook();
      if (!book) continue;
      if (kind === 'book') {
        const analysis = analyses.find((a) => a.bookId === book!.id);
        label = 'Síntesis del libro';
        target = analysis?.summary || '';
        seed = analysis ? { bookId: book.id, analysis } : { bookId: book.id, conversationKey: conv.id };
      } else {
        label = 'Mi reseña';
        target = book.review || '';
        seed = { bookId: book.id, conversationKey: conv.id };
      }
    }
    if (!book || !seed) continue;

    const lastUser = [...conv.history].reverse().find((t) => t.role === 'user');
    const lastModel = [...conv.history].reverse().find((t) => t.role === 'model');
    const userTexts = (lastUser?.parts || []).map((part) => part.text).filter(Boolean);
    rows.push({
      conv,
      book,
      label,
      target: plainSnippet(target, 110),
      question: plainSnippet(userTexts[userTexts.length - 1] || '', 120),
      answer: plainSnippet((lastModel?.parts || []).map((part) => part.text).join(' '), 160),
      turns: conv.history.filter((t) => t.role === 'user').length,
      seed,
    });
  }
  return rows.sort((a, b) => (b.conv.updatedAt || '').localeCompare(a.conv.updatedAt || ''));
}

function scheduleAiConvsBanner() {
  clearTimeout(aiConvsBannerTimer);
  aiConvsBannerTimer = setTimeout(() => void refreshAiConvsBanner(), 250);
}

async function refreshAiConvsBanner() {
  const banner = $('#aiConvsBanner');
  if (!banner) return;
  try {
    const rows = await loadAiConversationRows();
    const bookCount = new Set(rows.map((r) => r.book.id)).size;
    banner.classList.toggle('hidden', rows.length === 0);
    const summary = $('#aiConvsSummary');
    if (summary && rows.length) {
      summary.textContent = `${rows.length} ${rows.length === 1 ? 'charla' : 'charlas'} en ${bookCount} ${bookCount === 1 ? 'libro' : 'libros'} · última: ${rows[0].book.title}`;
    }
  } catch {
    banner.classList.add('hidden');
  }
}

function renderAiConversationList() {
  const host = $('#aiConvsList');
  if (!host) return;
  const q = ($<HTMLInputElement>('#aiConvsSearch')?.value || '').toLowerCase().trim();
  const visible = aiConvRows.filter((r) =>
    !q || `${r.book.title} ${r.book.author || ''} ${r.label} ${r.target} ${r.question} ${r.answer}`.toLowerCase().includes(q),
  );
  if (!visible.length) {
    host.innerHTML = `<p class="muted ai-convs-empty">${q ? 'No hay conversaciones que coincidan.' : 'Todavía no hay conversaciones con la IA.'}</p>`;
    return;
  }
  const groups = new Map<string, AiConvRow[]>();
  for (const row of visible) {
    if (!groups.has(row.book.id)) groups.set(row.book.id, []);
    groups.get(row.book.id)!.push(row);
  }
  host.innerHTML = [...groups.values()]
    .map((list) => {
      const book = list[0].book;
      return `<section class="ai-convs-group">
        <h3>${esc(book.title)}${book.author ? `<small>${esc(book.author)}</small>` : ''}</h3>
        ${list
          .map((r) => {
            const date = r.conv.updatedAt
              ? new Date(r.conv.updatedAt).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })
              : '';
            return `<button type="button" class="ai-conv-row" data-conv-id="${esc(r.conv.id)}">
              <span class="ai-conv-meta"><b>${esc(r.label)}</b><span>${r.turns} ${r.turns === 1 ? 'pregunta' : 'preguntas'}${date ? ` · ${esc(date)}` : ''}</span></span>
              ${r.target ? `<span class="ai-conv-target">${esc(r.target)}</span>` : ''}
              ${r.question ? `<span class="ai-conv-q"><em>Vos:</em> ${esc(r.question)}</span>` : ''}
              ${r.answer ? `<span class="ai-conv-a"><em>IA:</em> ${esc(r.answer)}</span>` : ''}
            </button>`;
          })
          .join('')}
      </section>`;
    })
    .join('');
}

async function openAiConversations() {
  const dialog = $<HTMLDialogElement>('#aiConvsDialog');
  if (!dialog) return;
  aiConvRows = await loadAiConversationRows();
  renderAiConversationList();
  if (!dialog.open) dialog.showModal();
}

/** Todo lo que se puede encontrar con la búsqueda global, lo más reciente primero. */
async function loadSearchDocs(): Promise<SearchDoc[]> {
  const [notes, entries, quotes, characters, chats] = await Promise.all([
    all<Note>('notes'),
    all<Entry>('entries'),
    all<Quote>('quotes'),
    all<Character>('characters'),
    loadAiConversationRows(),
  ]);
  const byId = new Map(books.map((b) => [sanitizeId(b.id), b]));
  const docs: SearchDoc[] = books.map((b) => ({
    kind: 'book',
    id: b.id,
    bookId: b.id,
    bookTitle: b.title,
    title: b.title,
    fields: [b.author, b.tags?.join(', '), b.review, b.publisher, b.isbn],
  }));
  const add = (kind: SearchDoc['kind'], item: { id: string; bookId: string }, title: string, fields: SearchDoc['fields']) => {
    const book = byId.get(sanitizeId(item.bookId));
    if (book) docs.push({ kind, id: item.id, bookId: book.id, bookTitle: book.title, title, fields });
  };
  const recent = <T extends { updatedAt?: string; createdAt?: string }>(items: T[]) =>
    items.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));

  notes.sort((a, b) => (a.section || 1) - (b.section || 1) || a.number - b.number);
  for (const n of notes) add('note', n, `Nota ${n.number}`, [n.text, n.comment, ...(n.subannotations || []).flatMap((s) => [s.phrase, s.question]), ...(n.aiSubcomments || []).flatMap((s) => [s.text, s.question])]);
  for (const e of recent(entries)) add('entry', e, e.title || `Anotación · pág. ${e.page}`, [e.text, e.comment, ...(e.subannotations || []).flatMap((s) => [s.phrase, s.question]), ...(e.aiSubcomments || []).flatMap((s) => [s.text, s.question])]);
  for (const q of recent(quotes)) add('quote', q, q.page != null ? `Cita · pág. ${q.page}` : 'Cita', [q.text, q.analysis, q.chapter, ...(q.subannotations || []).flatMap((s) => [s.phrase, s.question]), ...(q.aiSubcomments || []).flatMap((s) => [s.text, s.question])]);
  for (const c of characters) {
    add('character', c, c.name, [c.aliases?.join(', '), c.description, c.occupation, c.affiliation, c.traits?.join(', '), c.comments]);
  }
  for (const row of chats) {
    // En los turnos propios, la pregunta es la última parte; las anteriores son contexto que arma la app.
    const turns = row.conv.history.map((t) =>
      (t.role === 'user' ? t.parts.slice(-1) : t.parts).map((part) => part.text || '').join(' '),
    );
    add('chat', { id: row.conv.id, bookId: row.book.id }, row.label, [...turns.map((t) => plainSnippet(t, t.length)), row.target]);
  }
  return docs;
}

async function openSearchResult(doc: SearchDoc) {
  if (doc.kind === 'chat') {
    const row = (await loadAiConversationRows()).find((r) => r.conv.id === doc.id);
    if (row) await openGemini(row.seed);
    return;
  }
  await openDetail(doc.bookId);
  if (doc.kind === 'book' || !activeBook) return;
  detailTab = ({ note: 'notes', entry: 'entries', quote: 'quotes', character: 'characters' } as const)[doc.kind];
  await renderDetail();
  if (doc.kind === 'character') {
    await (await loadCharactersFeature()).openCharacterSheet(doc.id);
    return;
  }
  const attribute = { note: 'data-ai-note', entry: 'data-ai-entry', quote: 'data-quote-id' }[doc.kind];
  const found = $('#detailPanel')?.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(doc.id)}"]`);
  if (!found) return;
  found.scrollIntoView({ block: 'center' });
  found.classList.add('quote-highlight');
  setTimeout(() => found.classList.remove('quote-highlight'), 2500);
}

async function openGemini(
  seed: {
    noteId?: string;
    entryId?: string | null;
    quoteId?: string;
    bookId?: string;
    image?: string | null;
    extraText?: string;
    analysis?: BookAnalysis;
    conversationKey?: string;
  } = {},
) {
  const note = seed.noteId ? (await get<Note>('notes', seed.noteId)) || null : null;
  const entry = seed.entryId ? (await get<Entry>('entries', seed.entryId)) || null : null;
  const quote = seed.quoteId ? (await get<Quote>('quotes', seed.quoteId)) || null : null;
  const analysis = seed.analysis || null;
  const bookId = note?.bookId || entry?.bookId || quote?.bookId || analysis?.bookId || seed.bookId;
  const book =
    (bookId ? await get<Book>('books', bookId) : undefined) ||
    books.find((b) => b.id === bookId) ||
    null;

  geminiItem = { book, note, entry, quote, analysis };
  geminiConversationId = note
    ? `note__${sanitizeId(note.id)}`
    : entry
      ? `entry__${sanitizeId(entry.id)}`
      : quote
        ? `quote__${sanitizeId(quote.id)}`
        : seed.conversationKey
          ? sanitizeId(seed.conversationKey)
          : analysis && book
            ? `book__${sanitizeId(book.id)}`
            : null;

  geminiHistory = [];
  geminiConversationHadImages = false;
  geminiExtraContext = seed.extraText || '';
  geminiAttachedImage = seed.image ?? entry?.photo ?? null;

  $('#geminiMessages')!.replaceChildren();
  ($<HTMLTextAreaElement>('#geminiQuestion')!).value = '';
  autosizeGeminiInput();
  setGeminiContextCollapsed(true);

  if (geminiConversationId) {
    const legacyId = geminiConversationId.replace('__', ':');
    const saved =
      (await get<Conversation>('conversations', geminiConversationId)) ||
      (await get<Conversation>('conversations', legacyId));
    if (saved) {
      geminiHistory = saved.history || [];
      geminiConversationHadImages = !!saved.hadImages;
      if (geminiHistory.length && !seed.image) geminiAttachedImage = null;
      restoreGeminiTranscript(geminiHistory);
      if (geminiConversationHadImages) {
        addGeminiMessage(
          'system',
          'Se recuperó la conversación. Las imágenes originales no se guardan en el historial para ahorrar espacio.',
        );
      }
    }
  }

  $('#clearGeminiHistory')?.classList.toggle('hidden', !geminiConversationId || !geminiHistory.length);
  renderGeminiContextCard();
  syncGeminiNoKeyBanner();
  $<HTMLDialogElement>('#geminiDialog')?.showModal();
  fitGeminiToViewport();
  scrollGeminiToBottom(false);
  // En pantallas táctiles no abrimos el teclado solo: taparía la cita y la conversación.
  if (!window.matchMedia('(pointer: coarse)').matches) $<HTMLTextAreaElement>('#geminiQuestion')?.focus();
}

function scrollGeminiToBottom(smooth = true) {
  const box = $<HTMLDivElement>('#geminiMessages');
  if (!box) return;
  box.style.scrollBehavior = smooth ? 'smooth' : 'auto';
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

function autosizeGeminiInput() {
  const input = $<HTMLTextAreaElement>('#geminiQuestion');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.3)}px`;
}

function setGeminiContextCollapsed(collapsed: boolean) {
  const card = $('#geminiContextCard');
  if (!card) return;
  card.classList.toggle('collapsed', collapsed);
  card.setAttribute('aria-expanded', String(!collapsed));
}

// Cuando aparece el teclado del celular, el chat se achica al área visible para que
// la barra de escritura quede siempre a la vista.
function fitGeminiToViewport() {
  const dialog = $<HTMLDialogElement>('#geminiDialog');
  const vv = window.visualViewport;
  if (!dialog || !vv) return;
  if (!dialog.open) {
    dialog.style.height = '';
    dialog.style.top = '';
    return;
  }
  dialog.style.height = `${vv.height}px`;
  dialog.style.top = `${vv.offsetTop}px`;
  scrollGeminiToBottom(false);
}

function renderGeminiContextCard() {
  if (!geminiItem) return;
  const { book, note, entry, quote, analysis } = geminiItem;
  let label = 'Anotación nueva';
  let body = geminiExtraContext;
  if (note) {
    label = `Nota ${note.number}${(note.section || 1) > 1 ? ` · Sección ${note.section}` : ''}`;
    body = note.text;
  } else if (entry) {
    label = `Anotación · pág. ${entry.page}${entry.title ? ` · ${entry.title}` : ''}`;
    body = entry.text || '';
  } else if (quote) {
    label = `Cita${quote.chapter ? ` · ${quote.chapter}` : ''}${quote.page != null ? ` · pág. ${quote.page}` : ''}`;
    body = quote.text;
  } else if (analysis) {
    label = `Síntesis del libro (${analysis.sourceCount} fragmentos)`;
    body = analysis.summary;
  }

  const personalComment = note?.comment || entry?.comment || quote?.analysis;
  const comment = personalComment
    ? `<p class="ctx-comment"><strong>Mi comentario:</strong> ${esc(personalComment)}</p>`
    : '';
  const contextImage = geminiAttachedImage || entry?.photo || quote?.photos?.[0] || null;
  const img = contextImage
    ? `<img class="ctx-thumb" src="${esc(contextImage)}" alt="Foto de la anotación o cita">`
    : '';

  $('#geminiContextCard')!.innerHTML = `${img}<div class="ctx-body"><p class="eyebrow">${esc(
    book?.title || 'Libro',
  )} · ${esc(label)}</p><p class="ctx-text">${esc(body) || '<em>(sin texto)</em>'}</p>${comment}</div>`;
}

function renderGeminiInline(text: string): string {
  let html = esc(text);
  const code: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_, value) => {
    const token = `\uE000${code.length}\uE001`;
    code.push(`<code>${value}</code>`);
    return token;
  });
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  return html.replace(/\uE000(\d+)\uE001/g, (_, i) => code[Number(i)] || '');
}

function renderGeminiMarkdown(text: string): string {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list = '';
  let codeLines: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderGeminiInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = '';
    }
  };
  const closeBlocks = () => {
    flushParagraph();
    closeList();
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (codeLines) {
        html.push(`<pre><code>${esc(codeLines.join('\n'))}</code></pre>`);
        codeLines = null;
      } else {
        closeBlocks();
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      closeBlocks();
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      html.push(`<h${level}>${renderGeminiInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s{0,3}(---+|\*\*\*+)\s*$/.test(line)) {
      closeBlocks();
      html.push('<hr>');
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) {
        closeList();
        html.push(`<${type}>`);
        list = type;
      }
      html.push(`<li>${renderGeminiInline((bullet || numbered)![1])}</li>`);
      continue;
    }
    const quoteMatch = line.match(/^\s*&gt;\s?(.*)$/);
    if (quoteMatch) {
      closeBlocks();
      html.push(`<blockquote>${renderGeminiInline(quoteMatch[1])}</blockquote>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  if (codeLines) html.push(`<pre><code>${esc(codeLines.join('\n'))}</code></pre>`);
  closeBlocks();
  return html.join('');
}

function renderUpdatesList() {
  const container = $('#updatesList');
  if (!container) return;
  const releases = changelogMarkdown.split(/^## /m).slice(1);
  container.innerHTML = releases.map((release) => {
    const newline = release.indexOf('\n');
    const heading = newline < 0 ? release.trim() : release.slice(0, newline).trim();
    const body = newline < 0 ? '' : release.slice(newline + 1).trim();
    return `<article class="updates-release"><h3>${esc(heading)}</h3><div class="updates-release-body">${renderGeminiMarkdown(body)}</div></article>`;
  }).join('');
}

function attachGeminiMessageActions(wrapper: HTMLElement, answer: string, sourceQuestion = geminiLastQuestion) {
  wrapper.querySelector('.gemini-msg-actions')?.remove();
  const bar = document.createElement('div');
  bar.className = 'gemini-msg-actions';
  const extracted = extractKeyPhrase(answer);
  const answerPlainText = [markdownToPlainText(extracted.answer), extracted.phrase].filter(Boolean).join('\n\n');

  const makeBtn = (label: string, onClick: (btn: HTMLButtonElement) => void | Promise<void>) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gemini-msg-action';
    btn.textContent = label;
    btn.onclick = () => void onClick(btn);
    bar.append(btn);
    return btn;
  };

  const markSaved = (btn: HTMLButtonElement, savedText = 'Guardado ✓') => {
    const prev = btn.textContent || '';
    btn.classList.add('saved');
    btn.textContent = savedText;
    setTimeout(() => {
      if (btn.isConnected) {
        btn.classList.remove('saved');
        btn.textContent = prev;
      }
    }, 2200);
  };

  makeBtn('Copiar', async (btn) => {
    const ok = await copyPlainText(answerPlainText);
    if (ok) markSaved(btn, 'Copiado ✓');
  });

  const ctx = geminiItem;
  if (extracted.phrase) {
    const key = document.createElement('p');
    key.className = 'gemini-key-phrase';
    key.innerHTML = `<strong>${esc(extracted.phrase)}</strong>`;
    wrapper.querySelector('.gemini-message.model')?.append(key);
    const source = ctx?.note || ctx?.entry || ctx?.quote;
    if (source) {
      const savedList = 'subannotations' in source ? (source.subannotations || []) : [];
      const duplicate = savedList.some((item: Subannotation) => item.phrase === extracted.phrase);
      const saveButton = makeBtn(duplicate ? 'Guardada ✓' : 'Guardar anotación', async (btn) => {
        if (btn.disabled || !ctx || !source) return;
        const fresh = ctx.note ? await get<Note>('notes', source.id) : ctx.entry ? await get<Entry>('entries', source.id) : await get<Quote>('quotes', source.id);
        if (!fresh) return;
        const list = (fresh as any).subannotations || [];
        if (list.some((item: Subannotation) => item.phrase === extracted.phrase)) { btn.textContent = 'Guardada ✓'; btn.disabled = true; return; }
        const sub: Subannotation = { id: uid(), phrase: extracted.phrase!, question: sourceQuestion, createdAt: new Date().toISOString() };
        (fresh as any).subannotations = mergeSubannotations(list, [sub]);
        const saved = ctx.note ? await pushNoteToCloud(fresh as Note) : ctx.entry ? await pushEntryToCloud(fresh as Entry) : await pushQuoteToCloud(fresh as Quote);
        if (ctx.note) ctx.note = saved as Note; else if (ctx.entry) ctx.entry = saved as Entry; else if (ctx.quote) ctx.quote = saved as Quote;
        btn.textContent = 'Guardada ✓'; btn.disabled = true;
        if ($<HTMLDialogElement>('#detailDialog')?.open) await renderDetail();
        if ($('#quotesView')?.classList.contains('active')) await renderQuoteCollection();
        if ($('#notebookView')?.classList.contains('active')) await renderJournal();
      });
      if (duplicate) saveButton.disabled = true;
    }
  }
  const source = ctx?.note || ctx?.entry || ctx?.quote;
  if (ctx && source) {
    const existing = 'aiSubcomments' in source ? (source.aiSubcomments || []) : [];
    const alreadySaved = existing.some((item: AISubcomment) => item.text === answerPlainText && item.question === sourceQuestion);
    const saveCommentButton = makeBtn(alreadySaved ? 'Comentario guardado ✓' : 'Guardar comentario', async (btn) => {
      if (btn.disabled || !ctx) return;
      const fresh = ctx.note ? await get<Note>('notes', source.id) : ctx.entry ? await get<Entry>('entries', source.id) : await get<Quote>('quotes', source.id);
      if (!fresh) return;
      const replies = (fresh as Note | Entry | Quote).aiSubcomments || [];
      if (replies.some((item) => item.text === answerPlainText && item.question === sourceQuestion)) {
        btn.textContent = 'Comentario guardado ✓'; btn.disabled = true; return;
      }
      const reply: AISubcomment = { id: uid(), text: answerPlainText, question: sourceQuestion, createdAt: new Date().toISOString() };
      (fresh as Note | Entry | Quote).aiSubcomments = mergeSubannotations(replies, [reply]);
      const saved = ctx.note ? await pushNoteToCloud(fresh as Note) : ctx.entry ? await pushEntryToCloud(fresh as Entry) : await pushQuoteToCloud(fresh as Quote);
      if (ctx.note) ctx.note = saved as Note; else if (ctx.entry) ctx.entry = saved as Entry; else if (ctx.quote) ctx.quote = saved as Quote;
      btn.textContent = 'Comentario guardado ✓'; btn.disabled = true;
      renderGeminiContextCard();
      if ($<HTMLDialogElement>('#detailDialog')?.open) await renderDetail();
      if ($('#quotesView')?.classList.contains('active')) await renderQuoteCollection();
      if ($('#notebookView')?.classList.contains('active')) await renderJournal();
    });
    if (alreadySaved) saveCommentButton.disabled = true;
  }

  if (ctx?.book) {
    const targetBook = ctx.book;
    makeBtn('＋ Nueva anotación', async (btn) => {
      const page =
        ctx.note?.referencePage ??
        ctx.quote?.page ??
        ctx.entry?.page ??
        targetBook.currentPage ??
        0;
      const heading = ctx.note
        ? `IA · Nota ${ctx.note.number}`
        : ctx.quote
          ? `IA · Cita${ctx.quote.chapter ? ` (${ctx.quote.chapter})` : ''}`
          : 'Nota del asistente de lectura';
      await pushEntryToCloud({
        id: uid(),
        bookId: targetBook.id,
        page: Math.max(0, Number(page) || 0),
        title: heading.slice(0, 300),
        text: answerPlainText.slice(0, 20000),
        photo: null,
        createdAt: new Date().toISOString(),
      });
      if ($<HTMLDialogElement>('#detailDialog')?.open && activeBook?.id === targetBook.id) {
        await renderDetail();
      }
      if ($('#notebookView')?.classList.contains('active')) await renderJournal();
      markSaved(btn, 'Anotación creada ✓');
    });
  }

  wrapper.append(bar);
}

document.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-delete-subannotation],[data-delete-ai-subcomment]');
  if (!button) return;
  const row = button.closest<HTMLElement>('[data-ai-note],[data-ai-entry],[data-quote-id]');
  if (!row) return;
  const isReply = Boolean(button.dataset.deleteAiSubcomment);
  const id = button.dataset.deleteAiSubcomment || button.dataset.deleteSubannotation!;
  const noteId = row.dataset.aiNote;
  const entryId = row.dataset.aiEntry;
  const quoteId = row.dataset.quoteId;
  if (noteId) { const record = await get<Note>('notes', noteId); if (record) { if (isReply) record.aiSubcomments = (record.aiSubcomments || []).filter((item) => item.id !== id); else record.subannotations = (record.subannotations || []).filter((item) => item.id !== id); await pushNoteToCloud(record); } }
  else if (entryId) { const record = await get<Entry>('entries', entryId); if (record) { if (isReply) record.aiSubcomments = (record.aiSubcomments || []).filter((item) => item.id !== id); else record.subannotations = (record.subannotations || []).filter((item) => item.id !== id); await pushEntryToCloud(record); } }
  else if (quoteId) { const record = await get<Quote>('quotes', quoteId); if (record) { if (isReply) record.aiSubcomments = (record.aiSubcomments || []).filter((item) => item.id !== id); else record.subannotations = (record.subannotations || []).filter((item) => item.id !== id); await pushQuoteToCloud(record); } }
  if ($<HTMLDialogElement>('#detailDialog')?.open) await renderDetail();
  if ($('#quotesView')?.classList.contains('active')) await renderQuoteCollection();
  if ($('#notebookView')?.classList.contains('active')) await renderJournal();
});

const GEMINI_FINISH_LABELS: Record<string, string> = {
  MAX_TOKENS: 'llegó al límite de longitud',
  SAFETY: 'Gemini la frenó por sus filtros de seguridad',
  RECITATION: 'Gemini la frenó por posible texto copiado',
  STALLED: 'se cortó la conexión',
};

function markGeminiIncomplete(wrapper: HTMLElement, reason: string) {
  const label = GEMINI_FINISH_LABELS[reason] || (reason ? `motivo: ${reason}` : 'se cortó la conexión');
  const note = document.createElement('div');
  note.className = 'gemini-message system';
  note.textContent = `La respuesta quedó incompleta (${label}).`;
  wrapper.append(note);
  let bar = wrapper.querySelector('.gemini-msg-actions');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'gemini-msg-actions';
    wrapper.append(bar);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gemini-msg-action';
  btn.textContent = 'Continuar respuesta';
  btn.onclick = () => {
    btn.remove();
    ($<HTMLTextAreaElement>('#geminiQuestion')!).value = 'Continuá tu respuesta anterior exactamente desde donde quedó, sin repetir lo ya dicho.';
    $<HTMLFormElement>('#geminiForm')?.requestSubmit();
  };
  bar.prepend(btn);
}

function createGeminiModelTurn(initialText = ''): { wrapper: HTMLElement; bubble: HTMLElement } {
  const wrapper = document.createElement('div');
  wrapper.className = 'gemini-model-turn';
  const bubble = document.createElement('div');
  bubble.className = 'gemini-message model';
  if (initialText) bubble.innerHTML = renderGeminiMarkdown(extractKeyPhrase(initialText).answer);
  else bubble.innerHTML = '<span class="gemini-thinking" aria-label="Pensando">Pensando<span>.</span><span>.</span><span>.</span></span>';
  wrapper.append(bubble);
  $('#geminiMessages')!.append(wrapper);
  wrapper.scrollIntoView({ block: 'nearest' });
  return { wrapper, bubble };
}

function addGeminiMessage(role: 'user' | 'model' | 'system' | 'error', text: string) {
  if (role === 'model') {
    const { wrapper } = createGeminiModelTurn(text);
    attachGeminiMessageActions(wrapper, text);
    return;
  }
  const p = document.createElement('div');
  p.className = `gemini-message ${role}`;
  p.textContent = text;
  $('#geminiMessages')!.append(p);
  p.scrollIntoView({ block: 'nearest' });
}

function restoreGeminiTranscript(history: ConversationTurn[]) {
  let lastQuestion = '';
  for (const item of history) {
    if (item.role !== 'user' && item.role !== 'model') continue;
    const texts = (item.parts || []).map((part) => part.text).filter(Boolean);
    if (!texts.length) continue;
    if (item.role === 'user') lastQuestion = texts[texts.length - 1];
    if (item.role === 'model') {
      const { wrapper } = createGeminiModelTurn(texts.join('\n'));
      attachGeminiMessageActions(wrapper, texts.join('\n'), lastQuestion);
    } else addGeminiMessage(item.role, texts[texts.length - 1]);
  }
}

function boundedGeminiHistory(history: ConversationTurn[]): ConversationTurn[] {
  const normalized = history
    .map((item) => ({
      role: item.role,
      parts: (item.parts || [])
        .filter((part) => typeof part.text === 'string')
        .map((part) => ({ text: part.text.slice(0, 12000) })),
    }))
    .filter((item) => item.parts.length);
  const limited =
    normalized.length > 40 ? [normalized[0], ...normalized.slice(-39)] : normalized;
  while (JSON.stringify(limited).length > 180000 && limited.length > 2) {
    limited.splice(1, 2);
  }
  return limited;
}

async function saveGeminiHistory() {
  if (!geminiConversationId || !geminiItem?.book) return;
  const targetType = geminiItem.note
    ? 'note'
    : geminiItem.entry
      ? 'entry'
      : geminiItem.quote
        ? 'quote'
        : 'book';
  await pushConversationToCloud({
    id: geminiConversationId,
    bookId: geminiItem.book.id,
    targetType,
    history: boundedGeminiHistory(geminiHistory),
    hadImages: geminiConversationHadImages,
    updatedAt: new Date().toISOString(),
  });
  $('#clearGeminiHistory')?.classList.toggle('hidden', !geminiHistory.length);
  scheduleAiConvsBanner();
}

async function clearGeminiHistory() {
  if (!geminiConversationId) return;
  const ok = await showConfirmDialog({
    eyebrow: 'ASISTENTE DE LECTURA',
    title: '¿Borrar historial de esta charla?',
    message: 'Se eliminarán los mensajes guardados de esta conversación.',
    confirmLabel: 'Borrar historial',
    danger: true,
  });
  if (!ok) return;
  await deleteFromCloud('conversations', geminiConversationId);
  geminiHistory = [];
  geminiConversationHadImages = false;
  $('#geminiMessages')!.replaceChildren();
  $('#clearGeminiHistory')?.classList.add('hidden');
  scheduleAiConvsBanner();
}

async function sendGeminiQuestion(e: Event) {
  e.preventDefault();
  if (geminiStreamController) return;
  const qInput = $<HTMLTextAreaElement>('#geminiQuestion')!;
  const question = qInput.value.trim();
  geminiLastQuestion = question;
  if (!question) return;
  const antiSpoilerEnabled = $<HTMLInputElement>('#geminiAntiSpoiler')?.checked ?? true;
  const button = $<HTMLButtonElement>('#geminiSend')!;
  const stopBtn = $<HTMLButtonElement>('#geminiStopBtn');
  const actionsWrap = $('.gemini-compose-actions');
  button.disabled = true;
  stopBtn?.classList.remove('hidden');
  actionsWrap?.classList.add('streaming');
  const imageConversation = Boolean(
    geminiAttachedImage || geminiConversationHadImages || geminiItem?.entry?.photo || geminiItem?.quote?.photos?.length,
  );
  const aiSettings = getAISettingsForTask(imageConversation ? 'image' : 'chat');
  addGeminiMessage('user', question);
  qInput.value = '';
  autosizeGeminiInput();

  const controller = new AbortController();
  geminiStreamController = controller;
  // Si la conexión se cuelga (sin respuesta inicial o sin nuevos datos), cortamos en vez de quedarnos en "Pensando…".
  let stalled = false;
  let attemptCtl: AbortController | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = (ms: number) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { stalled = true; attemptCtl?.abort(); }, ms);
  };
  let modelTurn: { wrapper: HTMLElement; bubble: HTMLElement } | null = null;
  let answer = '';
  let finishReason = '';
  let usedModel: string = aiSettings.model;

  try {
    let systemInstruction = aiStyleInstruction(aiSettings);
    if (antiSpoilerEnabled && geminiItem?.book) {
      // Read the latest saved progress so the boundary stays current if it changed
      // while this chat window was open.
      const currentBook = await get<Book>('books', geminiItem.book.id);
      if (currentBook) geminiItem.book = currentBook;
      const page = Math.max(0, Number(geminiItem.book.currentPage) || 0);
      systemInstruction += `\n\nMODO EVITAR SPOILERS: la persona está aproximadamente en la página ${page} de «${geminiItem.book.title}». Usá esa página como referencia aproximada de su avance y evitá revelar o anticipar hechos posteriores, giros o destinos. Si la ubicación de un dato no es clara, respondé sin revelar detalles de trama que puedan adelantarse. Esta preferencia no exige hablar de spoilers ni impide responder preguntas generales de forma segura.`;
    }
    systemInstruction += `\n\nAl final de cada respuesta agregá una línea separada exactamente con este marcador y una sola oración breve (máximo 25 palabras): ${KEY_PHRASE_MARKER} frase clave. La frase tiene que contestar de manera tajante la pregunta concreta, no resumir vagamente tu respuesta ni prometer que la contestaste. Si preguntan nombres, fechas, causas o una lista, incluí esos datos concretos en la frase; no omitas la respuesta principal. Debe entenderse sola. Si no hay respuesta segura, decilo con claridad. Respetá siempre Evitar spoilers también en esa frase y limitá los datos al avance de lectura indicado. No escribas el marcador en ningún otro lugar.`;
    const parts: any[] = [];
    if (!geminiHistory.length) {
      const { book, note, entry, quote, analysis } = geminiItem || {};
      const context: string[] = [];
      if (book) {
        context.push(
          `Libro asociado: «${book.title}»${book.author ? ` de ${book.author}` : ''}. Tené en cuenta este título para interpretar la nota o el pasaje. No inventes detalles de una edición que no se proporcionó.`,
        );
      }
      if (note) {
        context.push(
          `Nota final ${note.number}${(note.section || 1) > 1 ? ` (sección ${note.section})` : ''}${
            note.referencePage != null ? `, referencia p. ${note.referencePage}` : ''
          }${note.endPage != null ? `, aparece en p. ${note.endPage}` : ''}:`,
          note.text,
        );
        if (note.comment) context.push(`Comentario personal: ${note.comment}`);
      } else if (entry) {
        context.push(
          `Anotación de la página ${entry.page}: ${entry.title || 'Sin título'}`,
          entry.text || '(sin comentario)',
        );
        if (entry.comment) context.push(`Comentario personal del lector: ${entry.comment}`);
        if (entry.photo) context.push('Se adjunta también la fotografía asociada.');
      } else if (quote) {
        context.push(
          `Cita guardada${quote.chapter ? ` · ${quote.chapter}` : ''}${
            quote.page != null ? ` · página ${quote.page}` : ''
          }:\n${quote.text}`,
        );
        if (quote.analysis) context.push(`Análisis o comentario personal: ${quote.analysis}`);
        if (quote.photos?.length) {
          context.push(`La cita tiene ${quote.photos.length} foto(s); se adjuntan con la consulta inicial.`);
        }
      } else if (analysis && book) {
        const quotes = (await all<Quote>('quotes')).filter((q) => q.bookId === book.id);
        context.push(
          `Síntesis del libro (${analysis.sourceCount} fragmentos):\n${analysis.summary}`,
        );
        if (analysis.themes?.length) {
          context.push(`Ejes temáticos: ${analysis.themes.join(', ')}`);
        }
        if (quotes.length) {
          context.push(
            `Citas reunidas:\n${quotes
              .slice(0, 30)
              .map((q, i) => `CITA-${i + 1}${q.page != null ? ` (p. ${q.page})` : ''}: ${q.text}`)
              .join('\n')}`,
          );
        }
      }
      if (context.length) {
        context.push(
          'Usá este material como contexto principal sobre la nota o el pasaje. Si la pregunta pide relacionarlo con otros autores, obras, épocas o ideas, respondé la relación solicitada con conocimiento general y no aclares de entrada que esos temas no aparecen en la cita. No atribuyas a la fuente datos que provienen de la comparación.',
        );
        parts.push({ text: context.filter(Boolean).join('\n\n') });
      }
    }

    if (geminiExtraContext) {
      parts.push({ text: `Instrucción y reflexión para esta consulta: ${geminiExtraContext}` });
    }

    if (geminiHistory.length && geminiItem?.book) {
      parts.push({
        text: `Libro asociado a esta conversación: «${geminiItem.book.title}». Tené en cuenta el título al responder.`,
      });
    }
    parts.push({ text: question });

    const images = geminiAttachedImage
      ? [geminiAttachedImage]
      : !geminiHistory.length
        ? geminiItem?.entry?.photo
          ? [geminiItem.entry.photo]
          : geminiItem?.quote?.photos || []
        : [];
    for (const image of images) {
      const [header, data] = image.split(',', 2);
      const mimeType = header.match(/data:(.*?);base64/)?.[1] || 'image/jpeg';
      parts.push({ inlineData: { mimeType, data } });
    }
    if (images.length) geminiConversationHadImages = true;
    geminiAttachedImage = null;

    const baseContents = [...geminiHistory, { role: 'user' as const, parts }];
    modelTurn = createGeminiModelTurn();
    const turn = modelTurn;
    const messagesBox = $('#geminiMessages')!;
    // Modelo elegido primero y después los de respaldo. Si uno falla, se corta o deja la respuesta a mitad, sigue el próximo.
    const { FALLBACK_MODELS } = await import('./gemini-direct');
    const models = [aiSettings.model, ...FALLBACK_MODELS.filter((m) => m !== aiSettings.model)];
    const failedModels: string[] = [];
    let lastError: Error | null = null;
    const retryNote = document.createElement('div');
    retryNote.className = 'gemini-message system';

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      if (i > 0) {
        retryNote.textContent = `${failedModels.at(-1)} falló; ${answer.trim() ? 'continuando' : 'reintentando'} con ${model}…`;
        turn.wrapper.append(retryNote);
      }
      const attempt = new AbortController();
      attemptCtl = attempt;
      const onUserAbort = () => attempt.abort();
      controller.signal.addEventListener('abort', onUserAbort, { once: true });
      stalled = false;
      finishReason = '';
      let streamError: string | null = null;

      const processEventBlock = (block: string) => {
        const lines = block.split('\n');
        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) return;
        let payload: any = {};
        try {
          payload = JSON.parse(dataLines.join('\n'));
        } catch {
          return;
        }

        if (eventName === 'meta' && payload.model) {
          usedModel = payload.model;
        } else if (eventName === 'chunk' && payload.text) {
          answer += payload.text;
          turn.bubble.innerHTML = renderGeminiMarkdown(visibleStreamingAnswer(answer));
          messagesBox.scrollTop = messagesBox.scrollHeight;
        } else if (eventName === 'message' && Array.isArray(payload.candidates)) {
          const reason = payload.candidates.map((candidate: any) => candidate.finishReason).find(Boolean);
          if (reason) finishReason = String(reason);
          const piece = payload.candidates
            .flatMap((candidate: any) => candidate.content?.parts || [])
            .filter((part: any) => !part.thought)
            .map((part: any) => part.text || '')
            .join('');
          if (piece) {
            answer += piece;
            turn.bubble.innerHTML = renderGeminiMarkdown(visibleStreamingAnswer(answer));
            messagesBox.scrollTop = messagesBox.scrollHeight;
          }
        } else if (eventName === 'message' && payload.promptFeedback?.blockReason && !answer.trim()) {
          streamError = `La consulta fue bloqueada por Gemini (${payload.promptFeedback.blockReason}).`;
        } else if (eventName === 'message' && payload.error) {
          streamError = payload.error.message || 'Error al generar respuesta.';
        } else if (eventName === 'done') {
          if (payload.text && !answer.trim()) answer = String(payload.text);
          if (payload.model) usedModel = payload.model;
        } else if (eventName === 'error') {
          streamError = payload.error || 'Error al generar respuesta.';
        }
      };

      try {
        armWatchdog(i === 0 ? 60000 : 45000);
        // Si ya hay texto parcial de un intento anterior, el nuevo modelo continúa desde ahí.
        const attemptContents = answer.trim()
          ? [
              ...baseContents,
              { role: 'model' as const, parts: [{ text: answer.trim() }] },
              { role: 'user' as const, parts: [{ text: 'Continuá tu respuesta anterior exactamente desde donde quedó, sin repetir lo ya dicho ni agregar introducciones.' }] },
            ]
          : baseContents;
        const response = await requestGeminiFeature('chat-stream', {
          contents: attemptContents,
          systemInstruction,
          model,
          thinking: aiSettings.thinking,
          singleModel: true,
        }, attempt.signal);

        if (!response.ok || !response.body) {
          let message = `Error HTTP ${response.status}`;
          try { message = (await response.json()).error || message; } catch {}
          const httpError: any = Error(message);
          httpError.status = response.status;
          throw httpError;
        }
        usedModel = response.headers.get('X-Librarium-Model') || model;
        armWatchdog(60000);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          armWatchdog(45000);
          // Normalizamos sobre el buffer completo: un "\r\n" partido entre dos pedazos no se reconocía y el mensaje quedaba trabado.
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            if (block.trim()) processEventBlock(block);
          }
        }
        if (buffer.trim()) processEventBlock(buffer);
        if (streamError && !answer.trim()) throw Error(streamError);
        if (!answer.trim()) throw Error('Gemini no devolvió texto.');
        // Una respuesta completa siempre termina con finishReason STOP.
        if (finishReason === 'STOP') { lastError = null; break; }
        lastError = Error('La respuesta quedó incompleta.');
        if (finishReason === 'SAFETY' || finishReason === 'RECITATION') break;
      } catch (err: any) {
        if (controller.signal.aborted) throw err; // el usuario apretó "Detener" o cerró el chat
        lastError = stalled ? Error('La IA tardó demasiado en responder.') : err;
        // Errores de clave o de pedido no se arreglan cambiando de modelo.
        if ([400, 401, 403].includes(err?.status)) break;
      } finally {
        controller.signal.removeEventListener('abort', onUserAbort);
        clearTimeout(watchdog);
      }
      failedModels.push(model);
    }

    const finalAnswer = answer.trim();
    if (!finalAnswer) throw lastError || Error('Gemini no devolvió texto.');
    retryNote.remove();
    const complete = finishReason === 'STOP' ? extractKeyPhrase(finalAnswer) : { answer: finalAnswer, phrase: null };
    turn.bubble.innerHTML = renderGeminiMarkdown(complete.answer);
    attachGeminiMessageActions(turn.wrapper, finalAnswer, question);
    if (finishReason !== 'STOP') markGeminiIncomplete(turn.wrapper, finishReason || 'STALLED');
    geminiHistory = [...baseContents, { role: 'model', parts: [{ text: finalAnswer }] }];
    geminiExtraContext = '';
    addGeminiMessage(
      'system',
      failedModels.length
        ? `Respondió ${usedModel} porque ${failedModels.join(', ')} falló · razonamiento ${thinkingLabel(aiSettings.thinking)}.`
        : `Modelo ${usedModel} · razonamiento ${thinkingLabel(aiSettings.thinking)}.`,
    );
    await saveGeminiHistory();
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      const partial = answer.trim();
      if (partial && modelTurn) {
        modelTurn.bubble.innerHTML = renderGeminiMarkdown(visibleStreamingAnswer(partial));
        attachGeminiMessageActions(modelTurn.wrapper, partial);
        addGeminiMessage('system', 'Respuesta detenida.');
      } else {
        modelTurn?.wrapper.remove();
        addGeminiMessage('system', 'Consulta detenida.');
      }
    } else {
      modelTurn?.wrapper.remove();
      if (isAIKeyError(err)) {
        const box = document.createElement('div');
        box.className = 'gemini-message error gemini-error-box';
        const span = document.createElement('span');
        span.textContent = err?.message || 'Configurá tu API key personal de Gemini para conversar.';
        const cta = document.createElement('button');
        cta.type = 'button';
        cta.className = 'ai-key-cta';
        cta.textContent = 'Configurar mi API key';
        cta.onclick = () => openAISettingsGuide();
        box.append(span, cta);
        $('#geminiMessages')!.append(box);
        box.scrollIntoView({ block: 'nearest' });
      } else {
        addGeminiMessage('error', `No pude consultar Gemini: ${err.message}`);
      }
    }
  } finally {
    clearTimeout(watchdog);
    if (geminiStreamController === controller) geminiStreamController = null;
    button.disabled = false;
    stopBtn?.classList.add('hidden');
    actionsWrap?.classList.remove('streaming');
  }
}

let isLoadingSampleBook = false;

async function loadSampleBook() {
  if (isLoadingSampleBook) return;
  isLoadingSampleBook = true;
  const btn = $<HTMLButtonElement>('#emptySampleBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Cargando ejemplo…';
  }
  try {
    const sampleId = 'sample_meditaciones';
    const existing = await get<Book>('books', sampleId);
    if (existing) {
      await openDetail(existing.id);
      return;
    }

    const now = new Date().toISOString();
    const book = await pushBookToCloud({
      id: sampleId,
      title: 'Meditaciones',
      author: 'Marco Aurelio',
      publisher: 'Libro de ejemplo',
      year: '180',
      edition: 'Edición de prueba',
      isbn: '',
      totalPages: 224,
      currentPage: 68,
      status: 'reading',
      cover: null,
      coverUrl: null,
      tags: ['Filosofía', 'Estoicismo', 'Clásico'],
      rating: 5,
      review:
        'Un libro para volver en momentos de ruido: recordatorios breves y directos sobre qué depende de uno y cómo sostener la calma cotidiana.',
      readingLog: { [localDayKey()]: 14 },
      createdAt: now,
      updatedAt: now,
    });

    await pushNoteToCloud({
      id: 'sample_meditaciones_note_1',
      bookId: book.id,
      number: 1,
      section: 1,
      referencePage: 34,
      endPage: 205,
      text: 'El término griego «hegemonikón» designa el principio rector o facultad racional que gobierna el juicio interior frente a las impresiones externas.',
      comment: 'Clave para entender por qué distingue entre el hecho externo y el juicio que agregamos encima.',
      read: true,
      createdAt: now,
    });

    await pushNoteToCloud({
      id: 'sample_meditaciones_note_2',
      bookId: book.id,
      number: 2,
      section: 1,
      referencePage: 65,
      endPage: 206,
      text: 'Alusión a Heráclito sobre el cambio continuo de todas las cosas y la aceptación serena de lo transitorio.',
      comment: '',
      read: false,
      createdAt: now,
    });

    await pushQuoteToCloud({
      id: 'sample_meditaciones_quote_1',
      bookId: book.id,
      text: 'Tienes poder sobre tu mente, no sobre los acontecimientos externos. Date cuenta de esto y encontrarás fuerza.',
      chapter: 'Libro IV',
      page: 64,
      analysis: 'Idea central del cuaderno: separar lo que puedo decidir hoy de lo que escapa a mi control.',
      photos: [],
      photoMediaIds: [],
      createdAt: now,
      updatedAt: now,
    });

    await pushEntryToCloud({
      id: 'sample_meditaciones_entry_1',
      bookId: book.id,
      page: 68,
      title: 'Notas al margen sobre la atención',
      text: 'Marco Aurelio escribe para sí mismo, sin tono de tratado académico; por eso funcionan tan bien las frases cortas como ejercicio diario.',
      comment: 'Probar releer estas anotaciones al terminar el Libro VI.',
      photo: null,
      createdAt: now,
    });

    books = await all<Book>('books');
    render();
    await openDetail(book.id);
  } finally {
    isLoadingSampleBook = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Probar con un libro de ejemplo';
    }
  }
}

function initEnvironmentNotices() {
  const inAppBanner = $('#inAppBrowserNotice');
  const dismissInApp = $('#dismissInAppNotice');
  if (inAppBanner && isInAppBrowser()) {
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem('librarium-inapp-dismissed') === '1';
    } catch {}
    if (!dismissed) inAppBanner.classList.remove('hidden');
  }
  dismissInApp?.addEventListener('click', () => {
    inAppBanner?.classList.add('hidden');
    try {
      sessionStorage.setItem('librarium-inapp-dismissed', '1');
    } catch {}
  });

  const offlineBanner = $('#offlineNotice');
  const syncOfflineBanner = () => {
    offlineBanner?.classList.toggle('hidden', navigator.onLine !== false);
  };
  syncOfflineBanner();
  window.addEventListener('online', syncOfflineBanner);
  window.addEventListener('offline', syncOfflineBanner);
}

/** Antes de cerrar el libro o cambiar de pestaña, avisa si hay un formulario de personaje sin guardar. */
function guardUnsavedCharacterForm() {
  const dialog = $<HTMLDialogElement>('#detailDialog');
  if (!dialog) return;
  const pending = () => dialog.open && detailTab === 'characters' && Boolean(charactersFeature?.hasUnsavedChanges());
  const ifDiscarded = async (then: () => void) => {
    if (!charactersFeature || !(await charactersFeature.confirmDiscard())) return;
    charactersFeature.leaveCharacterForm();
    then();
  };
  dialog.addEventListener(
    'click',
    (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-close], [data-detail-tab], #openBookCharacters');
      if (!target || !pending()) return;
      event.preventDefault();
      event.stopPropagation();
      void ifDiscarded(() => target.click());
    },
    true,
  );
  // Escape y el gesto «atrás» de Android.
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !pending()) return;
    event.preventDefault();
    void ifDiscarded(() => dialog.close());
  });
  dialog.addEventListener('cancel', (event) => {
    if (!pending()) return;
    event.preventDefault();
    void ifDiscarded(() => dialog.close());
  });
  window.addEventListener('beforeunload', (event) => {
    if (pending()) event.preventDefault();
  });
}

function wireEvents() {
  guardUnsavedCharacterForm();
  document.addEventListener('click', (event) => {
    const trigger = (event.target as HTMLElement).closest<HTMLElement>('#footerFeedbackBtn,#openFeedbackBtn,#openFeedbackInboxBtn,#openUsersDirectoryBtn');
    if (!trigger || adminFeaturesInitialized || trigger.dataset.adminLazyReady) return;
    trigger.dataset.adminLazyReady = '1';
    event.preventDefault();
    event.stopImmediatePropagation();
    void loadAdminFeature().then(() => trigger.click()).catch((error) => console.error('No se pudo cargar el panel de comentarios:', error));
  }, true);
  $$('.tab').forEach((b) => {
    b.onclick = () => switchView(b.dataset.view!);
  });

  $('#bookSearch')?.addEventListener('input', render);
  $('#bookFilter')?.addEventListener('change', render);
  $('#bookTagFilter')?.addEventListener('change', render);
  $('#bookSort')?.addEventListener('change', render);

  $('#toggleFiltersBtn')?.addEventListener('click', () => {
    const panel = $('#libraryFilters');
    const btn = $('#toggleFiltersBtn');
    if (!panel || !btn) return;
    const isHidden = panel.classList.toggle('hidden');
    btn.setAttribute('aria-expanded', String(!isHidden));
  });

  $('#clearFiltersBtn')?.addEventListener('click', () => {
    const search = $<HTMLInputElement>('#bookSearch');
    const status = $<HTMLSelectElement>('#bookFilter');
    const tag = $<HTMLSelectElement>('#bookTagFilter');
    const sort = $<HTMLSelectElement>('#bookSort');
    if (search) search.value = '';
    if (status) status.value = 'all';
    if (tag) tag.value = 'all';
    if (sort) sort.value = 'recent';
    render();
  });

  $('#emptyAdd')!.onclick = $('#addBookBtn')!.onclick = () => openBookForm();
  $('#emptySampleBtn')?.addEventListener('click', () => void loadSampleBook());
  $('#geminiOpenKeySettings')?.addEventListener('click', () => openAISettingsGuide());
  $$('[data-close]').forEach((b) => {
    b.onclick = () => b.closest('dialog')?.close();
  });

  $('#manualMode')!.onclick = () => {
    $('#catalogPanel')?.classList.add('hidden');
    $('#manualMode')?.classList.add('active');
    $('#searchMode')?.classList.remove('active');
  };
  $('#searchMode')!.onclick = () => {
    $('#catalogPanel')?.classList.remove('hidden');
    $('#searchMode')?.classList.add('active');
    $('#manualMode')?.classList.remove('active');
  };

  $('#catalogSearch')!.onclick = async () => {
    const q = $<HTMLInputElement>('#catalogQuery')!.value.trim();
    if (!q) return;
    $('#catalogResults')!.textContent = 'Buscando…';
    try {
      const r = await fetch(
        'https://openlibrary.org/search.json?q=' + encodeURIComponent(q) + '&limit=8',
      );
      const data = await r.json();
      $('#catalogResults')!.innerHTML =
        (data.docs || [])
          .map(
            (x: any) => `<div class="catalog-result">
              <img src="${x.cover_i ? `https://covers.openlibrary.org/b/id/${x.cover_i}-S.jpg` : ''}" alt="">
              <div><strong>${esc(x.title)}</strong><br>${esc(
                (x.author_name || []).slice(0, 2).join(', '),
              )} · ${x.first_publish_year || 'Año desconocido'}</div>
              <button class="secondary" type="button" data-pick="${esc(x.key)}">Elegir</button>
            </div>`,
          )
          .join('') || 'No se encontraron resultados.';

      $$('[data-pick]').forEach((btn) => {
        btn.onclick = () => {
          const x = (data.docs || []).find((doc: any) => doc.key === btn.dataset.pick);
          if (!x) return;
          ($<HTMLInputElement>('#title')!).value = x.title || '';
          ($<HTMLInputElement>('#author')!).value = (x.author_name || []).join(', ');
          ($<HTMLInputElement>('#year')!).value = x.first_publish_year || '';
          ($<HTMLInputElement>('#publisher')!).value = (x.publisher || [])[0] || '';
          ($<HTMLInputElement>('#isbn')!).value = (x.isbn || [])[0] || '';
          ($<HTMLInputElement>('#coverUrl')!).value = x.cover_i
            ? `https://covers.openlibrary.org/b/id/${x.cover_i}-L.jpg`
            : '';
          ($<HTMLInputElement>('#totalPages')!).value = x.number_of_pages_median || '';
          $('#manualMode')?.click();
        };
      });
    } catch {
      $('#catalogResults')!.textContent =
        'No se pudo consultar el catálogo. Podés completar los datos manualmente.';
    }
  };

  const handleCoverFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      updateCoverPreview('Elegí un archivo de imagen.');
      return;
    }
    coverData = await optimizeImagePhoto(file, 1200, 0.8);
    updateCoverPreview('Foto de portada optimizada y lista.');
  };

  $('#coverFileBtn')?.addEventListener('click', () => {
    $<HTMLInputElement>('#coverFile')?.click();
  });
  $('#coverCameraBtn')?.addEventListener('click', () => {
    openCameraCapture({
      title: 'Foto de portada',
      cameraInput: $<HTMLInputElement>('#coverCameraInput')!,
      fallbackInput: $<HTMLInputElement>('#coverFile')!,
      onFile: handleCoverFile,
    });
  });
  $('#clearCoverBtn')?.addEventListener('click', () => {
    coverData = null;
    ($<HTMLInputElement>('#coverUrl')!).value = '';
    ($<HTMLInputElement>('#coverFile')!).value = '';
    ($<HTMLInputElement>('#coverCameraInput')!).value = '';
    updateCoverPreview('');
  });
  $('#coverUrl')?.addEventListener('input', () => {
    if (!coverData || !coverData.startsWith('data:')) {
      coverData = null;
      const hasUrl = Boolean(($<HTMLInputElement>('#coverUrl')!).value.trim());
      updateCoverPreview(hasUrl ? 'Portada desde URL.' : '');
    }
  });
  ['#coverFile', '#coverCameraInput'].forEach((selector) => {
    $<HTMLInputElement>(selector)?.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) await handleCoverFile(file);
      input.value = '';
    });
  });

  $('#lookupIsbnBtn')!.onclick = () => lookupISBN($<HTMLInputElement>('#isbn')!.value);
  $('#stopIsbnScanner')!.onclick = stopISBNScanner;
  $('#bookDialog')?.addEventListener('close', stopISBNScanner);

  $('#scanIsbnBtn')!.onclick = async () => {
    const status = $('#isbnStatus')!;
    const BarcodeDetectorCtor = (window as any).BarcodeDetector;
    if (!BarcodeDetectorCtor) {
      status.textContent =
        'Este navegador no admite escaneo de códigos. Escribí el ISBN y tocá Buscar.';
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      status.textContent =
        'No se puede abrir la cámara en este contexto. Escribí el ISBN y tocá Buscar.';
      return;
    }
    try {
      const supported: string[] = await BarcodeDetectorCtor.getSupportedFormats();
      const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((x) => supported.includes(x));
      if (!formats.length) throw Error('No hay formatos de código compatibles.');
      const detector = new BarcodeDetectorCtor({ formats });
      isbnScannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      const video = $<HTMLVideoElement>('#isbnVideo')!;
      video.srcObject = isbnScannerStream;
      $('#isbnScanner')?.classList.remove('hidden');
      status.textContent = 'Apuntá la cámara al código de barras del libro.';
      await video.play();
      const scan = async () => {
        if (!isbnScannerStream) return;
        try {
          const codes = await detector.detect(video);
          const code = codes.find((x: any) => x.rawValue);
          if (code) {
            const isbn = normalizeISBN(code.rawValue);
            stopISBNScanner();
            if (!isbn) {
              status.textContent =
                'El código leído no parece un ISBN válido. Probá encuadrar el código EAN de la contratapa.';
              return;
            }
            ($<HTMLInputElement>('#isbn')!).value = isbn;
            await lookupISBN(isbn);
            return;
          }
        } catch {}
        if (isbnScannerStream) setTimeout(scan, 140);
      };
      void scan();
    } catch (err: any) {
      stopISBNScanner();
      status.textContent =
        err?.name === 'NotAllowedError'
          ? 'No se concedió acceso a la cámara. Podés escribir el ISBN manualmente.'
          : 'No se pudo iniciar el escáner. Escribí el ISBN y tocá Buscar.';
    }
  };

  $('#bookForm')!.onsubmit = async (e) => {
    e.preventDefault();
    const id = $<HTMLInputElement>('#bookId')!.value || uid();
    const old = await get<Book>('books', id);
    const url = $<HTMLInputElement>('#coverUrl')!.value.trim();
    const rawRating = $<HTMLInputElement>('#bookRatingValue')!.value;
    const ratingVal = rawRating ? Number(rawRating) : null;
    const book: Book = {
      ...old,
      id,
      title: $<HTMLInputElement>('#title')!.value.trim(),
      author: $<HTMLInputElement>('#author')!.value.trim(),
      publisher: $<HTMLInputElement>('#publisher')!.value.trim(),
      year: $<HTMLInputElement>('#year')!.value,
      edition: $<HTMLInputElement>('#edition')!.value,
      isbn: $<HTMLInputElement>('#isbn')!.value,
      totalPages: Number($<HTMLInputElement>('#totalPages')!.value) || 0,
      currentPage: Number($<HTMLInputElement>('#currentPage')!.value) || 0,
      status: $<HTMLSelectElement>('#status')!.value as BookStatus,
      cover: coverData || url || null,
      coverUrl: !coverData && url ? url : old?.coverUrl || null,
      tags: parseTagsInput($<HTMLInputElement>('#bookTagsInput')!.value),
      rating: ratingVal && ratingVal >= 1 && ratingVal <= 5 ? ratingVal : null,
      review: $<HTMLTextAreaElement>('#bookReviewInput')!.value.trim(),
      createdAt: old?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const saved = await pushBookToCloud(book);
    books = await all<Book>('books');
    render();
    if (activeBook?.id === saved.id && $<HTMLDialogElement>('#detailDialog')?.open) {
      activeBook = saved;
      await renderDetail();
    }
    $<HTMLDialogElement>('#bookDialog')?.close();
  };

  $('#bookGrid')!.onclick = $('#readingGrid')!.onclick = (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (c) void openDetail(c.dataset.id!);
  };
  const onGridKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const c = (e.target as HTMLElement).closest<HTMLElement>('.book-card[data-id]');
    if (!c) return;
    e.preventDefault();
    void openDetail(c.dataset.id!);
  };
  $('#bookGrid')?.addEventListener('keydown', onGridKeydown);
  $('#readingGrid')?.addEventListener('keydown', onGridKeydown);

  document.addEventListener(
    'error',
    (e) => {
      const target = e.target;
      if (target instanceof HTMLImageElement && target.classList.contains('cover')) {
        const placeholder = document.createElement('div');
        placeholder.className = 'cover cover-placeholder';
        placeholder.textContent = target.dataset.coverTitle || 'Librarium';
        target.replaceWith(placeholder);
      }
    },
    true,
  );

  $('#readingProgressForm')!.onsubmit = async (e) => {
    e.preventDefault();
    if (!activeBook) return;
    const pageInput = $<HTMLInputElement>('#readingProgressPage')!;
    const next = Math.max(0, Math.floor(Number(pageInput.value) || 0));
    const previous = Math.max(0, Number(activeBook.currentPage) || 0);
    if (activeBook.totalPages && next > activeBook.totalPages) {
      pageInput.setCustomValidity(`Este libro tiene ${activeBook.totalPages} páginas.`);
      pageInput.reportValidity();
      return;
    }
    pageInput.setCustomValidity('');
    if (next > previous) {
      const day = localDayKey();
      activeBook.readingLog = {
        ...(activeBook.readingLog || {}),
        [day]: (Number(activeBook.readingLog?.[day]) || 0) + (next - previous),
      };
    }
    activeBook.currentPage = next;
    activeBook.updatedAt = new Date().toISOString();
    activeBook = await pushBookToCloud(activeBook);
    books = await all<Book>('books');
    $<HTMLDialogElement>('#readingProgressDialog')?.close();
    render();
    await renderDetail();
  };

  const handleQuotePhotoFiles = async (files: File[]) => {
    if (!files.length) return;
    if (quotePhotoData.length + files.length > 5) {
      $('#quotePhotoStatus')!.textContent =
        'El máximo es 5 fotos por cita. Quitá alguna para agregar otras.';
      return;
    }
    try {
      if (files.some((file) => !file.type.startsWith('image/'))) {
        throw Error('Elegí archivos de imagen.');
      }
      $('#quotePhotoStatus')!.textContent = 'Optimizando fotos…';
      const optimized: string[] = [];
      for (const file of files) optimized.push(await optimizeImagePhoto(file, 1400, 0.78));
      quotePhotoData.push(...optimized);
      renderQuotePhotoPreview();
      $('#quotePhotoStatus')!.textContent =
        `${quotePhotoData.length} de 5 fotos. Se guardarán optimizadas y sincronizadas.`;
    } catch (error: any) {
      $('#quotePhotoStatus')!.textContent = error.message;
    }
  };

  $('#quoteFileBtn')?.addEventListener('click', () => {
    $<HTMLInputElement>('#quotePhotos')?.click();
  });
  $('#quoteCameraBtn')?.addEventListener('click', () => {
    openCameraCapture({
      title: 'Foto para la cita',
      cameraInput: $<HTMLInputElement>('#quoteCameraInput')!,
      fallbackInput: $<HTMLInputElement>('#quotePhotos')!,
      canCapture: () => {
        if (quotePhotoData.length >= 5) {
          $('#quotePhotoStatus')!.textContent =
            'El máximo es 5 fotos por cita. Quitá alguna para agregar otras.';
          return false;
        }
        return true;
      },
      onFile: async (file) => handleQuotePhotoFiles([file]),
    });
  });
  ['#quotePhotos', '#quoteCameraInput'].forEach((selector) => {
    $<HTMLInputElement>(selector)?.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const files = Array.from(input.files || []);
      await handleQuotePhotoFiles(files);
      input.value = '';
    });
  });

  $('#quotePhotoPreview')!.onclick = async (e) => {
    const target = e.target as HTMLElement;
    const transcribe = target.closest<HTMLButtonElement>('[data-transcribe-quote-photo]');
    if (transcribe) {
      await transcribeQuotePhoto(Number(transcribe.dataset.transcribeQuotePhoto), transcribe);
      return;
    }
    const remove = target.closest<HTMLElement>('[data-remove-quote-photo]');
    if (!remove) return;
    quotePhotoData.splice(Number(remove.dataset.removeQuotePhoto), 1);
    renderQuotePhotoPreview();
    $('#quotePhotoStatus')!.textContent = `${quotePhotoData.length} de 5 fotos guardadas.`;
  };

  $('#quoteForm')!.onsubmit = async (e) => {
    e.preventDefault();
    const id = $<HTMLInputElement>('#quoteId')!.value || uid();
    const old = await get<Quote>('quotes', id);
    const quote: Quote = {
      ...old,
      id,
      bookId: $<HTMLInputElement>('#quoteBookId')!.value,
      text: $<HTMLTextAreaElement>('#quoteText')!.value.trim(),
      chapter: $<HTMLInputElement>('#quoteChapter')!.value.trim(),
      page:
        $<HTMLInputElement>('#quotePage')!.value === ''
          ? null
          : Number($<HTMLInputElement>('#quotePage')!.value),
      analysis: $<HTMLTextAreaElement>('#quoteAnalysis')!.value.trim(),
      photos: [...quotePhotoData],
      photoMediaIds: old?.photoMediaIds || [],
      createdAt: old?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await pushQuoteToCloud(quote);
    quotePhotoData = [];
    $<HTMLDialogElement>('#quoteDialog')?.close();
    if ($<HTMLDialogElement>('#detailDialog')?.open && activeBook?.id === quote.bookId) {
      await renderDetail();
    }
    if ($('#quotesView')?.classList.contains('active')) {
      await renderQuoteCollection();
    }
  };

  $('#noteDialog')?.addEventListener('close', () => {
    pendingImport = null;
    ($<HTMLButtonElement>('#importNotesBtn')!).disabled = true;
  });

  $('#jsonText')?.addEventListener('input', (e) => {
    const val = (e.target as HTMLTextAreaElement).value;
    if (val.trim()) previewNoteJSON(val);
    else {
      pendingImport = null;
      $('#jsonPreview')!.textContent = 'Pegá un JSON o seleccioná un archivo…';
      ($<HTMLButtonElement>('#importNotesBtn')!).disabled = true;
    }
  });

  $('#copyNotesGuide')!.onclick = async () => {
    const guide = `Convertí las notas finales que pego al final de este mensaje en JSON válido para importar en Librarium. Devolvé únicamente el JSON, sin Markdown ni explicaciones. No inventes ni corrijas datos: conservá fielmente textos, numeración y páginas. Si el material está dividido en partes y la numeración vuelve a 1, mantené las notas en el orden original; Librarium detectará el reinicio y creará secciones. Devolvé JSON crudo, sin HTML ni Markdown. Cada nota debe incluir number (entero) y text (cadena). Incluí end_page solo si se conoce la página impresa donde aparece la nota. Incluí reference_page solo si se conoce la página del texto principal donde se cita la nota; si las notas no tienen referencia, omití por completo ese campo. No pongas null ni inventes páginas. Usá read:false en todas las notas. Escapá correctamente comillas y saltos de línea para que el resultado sea JSON válido.\n\nDevolvé esta estructura (el campo reference_page es opcional):\n{\n  "schema_version": 1,\n  "book": {"title": "Título", "author": "Autor"},\n  "notes": [\n    {"number": 1, "reference_page": 12, "end_page": 245, "text": "Texto completo de la nota", "read": false},\n    {"number": 2, "end_page": 246, "text": "Nota sin página de referencia", "read": false}\n  ]\n}\n\nTítulo del libro: [completar]\nAutor: [completar]\n\nNotas finales:\n[pegar aquí las notas, incluyendo solo las páginas que figuren en la fuente]`;
    try {
      await navigator.clipboard.writeText(guide);
      $('#copyNotesGuide')!.textContent = 'Instrucciones copiadas';
    } catch {
      const box = document.createElement('textarea');
      box.value = guide;
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.append(box);
      box.select();
      const ok = document.execCommand('copy');
      box.remove();
      $('#copyNotesGuide')!.textContent = ok
        ? 'Instrucciones copiadas'
        : 'No se pudieron copiar';
    }
    setTimeout(() => ($('#copyNotesGuide')!.textContent = 'Copiar guía para un modelo'), 2200);
  };

  $('#jsonFile')?.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      ($<HTMLTextAreaElement>('#jsonText')!).value = text;
      previewNoteJSON(text);
    } catch (err: any) {
      pendingImport = null;
      $('#jsonPreview')!.textContent = 'No se pudo leer el archivo: ' + err.message;
      ($<HTMLButtonElement>('#importNotesBtn')!).disabled = true;
    }
  });

  $('#noteForm')!.onsubmit = async (e) => {
    e.preventDefault();
    if (!activeBook || !pendingImport || !previewNoteJSON($<HTMLTextAreaElement>('#jsonText')!.value)) {
      return;
    }
    const existing = (await all<Note>('notes')).filter((n) => n.bookId === activeBook!.id);
    const conflicts = pendingImport.notes.filter((n) =>
      existing.some((x) => Number(x.number) === n.number && (x.section || 1) === n.section),
    );
    if (conflicts.length) {
      $('#jsonPreview')!.textContent =
        `No se importó ninguna nota. Ya existen estos números en ${activeBook.title}: ${conflicts
          .map((n) => `sección ${n.section}, nota ${n.number}`)
          .join('; ')}. Eliminá o renumerá esas notas y volvé a importar.`;
      ($<HTMLButtonElement>('#importNotesBtn')!).disabled = true;
      return;
    }
    for (const n of pendingImport.notes) {
      await pushNoteToCloud({
        id: `${activeBook.id}_note_s${n.section}_n${n.number}`,
        bookId: activeBook.id,
        number: n.number,
        section: n.section,
        referencePage: n.referencePage,
        endPage: n.endPage,
        text: n.text,
        comment: n.comment,
        read: n.read,
      });
    }
    $<HTMLDialogElement>('#noteDialog')?.close();
    await renderDetail();
  };

  $('#manualHasReference')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    $('#manualReferenceLabel')?.classList.toggle('hidden', !checked);
    const refInput = $<HTMLInputElement>('#manualReferencePage')!;
    refInput.disabled = !checked;
    refInput.required = checked;
    if (!checked) refInput.value = '';
  });

  $('#manualNoteForm')!.onsubmit = async (e) => {
    e.preventDefault();
    if (!activeBook) return;
    const number = Number($<HTMLInputElement>('#manualNoteNumber')!.value);
    const text = $<HTMLTextAreaElement>('#manualNoteText')!.value.trim();
    const page = (id: string) => {
      const val = $<HTMLInputElement>(id)!.value;
      return val === '' ? null : Number(val);
    };
    const existing = (await all<Note>('notes')).filter((n) => n.bookId === activeBook!.id);
    if (existing.some((n) => Number(n.number) === number && (n.section || 1) === 1)) {
      $('#manualNoteError')!.textContent =
        `Ya existe la nota ${number} en la sección 1 de este libro. Usá otro número o eliminá la existente.`;
      return;
    }
    await pushNoteToCloud({
      id: `${activeBook.id}_note_s1_n${number}`,
      bookId: activeBook.id,
      number,
      section: 1,
      referencePage: $<HTMLInputElement>('#manualHasReference')!.checked
        ? page('#manualReferencePage')
        : null,
      endPage: page('#manualEndPage'),
      text,
      read: false,
    });
    $<HTMLDialogElement>('#manualNoteDialog')?.close();
    await renderDetail();
  };

  const handleAnnotationPhotoFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      updateAnnotationPhotoPreview('Elegí un archivo de imagen.');
      return;
    }
    photoData = await optimizeImagePhoto(file, 1400, 0.8);
    updateAnnotationPhotoPreview('Nueva fotografía optimizada y lista; reemplazará la anterior al guardar.');
  };

  $('#annotationFileBtn')?.addEventListener('click', () => {
    $<HTMLInputElement>('#annotationPhoto')?.click();
  });
  $('#annotationCameraBtn')?.addEventListener('click', () => {
    openCameraCapture({
      title: 'Foto para la anotación',
      cameraInput: $<HTMLInputElement>('#annotationCameraInput')!,
      fallbackInput: $<HTMLInputElement>('#annotationPhoto')!,
      onFile: handleAnnotationPhotoFile,
    });
  });
  $('#clearAnnotationPhotoBtn')?.addEventListener('click', () => {
    photoData = null;
    ($<HTMLInputElement>('#annotationPhoto')!).value = '';
    ($<HTMLInputElement>('#annotationCameraInput')!).value = '';
    updateAnnotationPhotoPreview('Fotografía eliminada.');
  });
  ['#annotationPhoto', '#annotationCameraInput'].forEach((selector) => {
    $<HTMLInputElement>(selector)?.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const f = input.files?.[0];
      if (f) await handleAnnotationPhotoFile(f);
      input.value = '';
    });
  });

  $('#cameraSnapBtn')?.addEventListener('click', () => {
    const video = $<HTMLVideoElement>('#cameraVideo');
    const shotPreview = $<HTMLImageElement>('#cameraShotPreview');
    const status = $('#cameraCaptureStatus');
    const snapBtn = $<HTMLButtonElement>('#cameraSnapBtn');
    const retakeBtn = $<HTMLButtonElement>('#cameraRetakeBtn');
    const useBtn = $<HTMLButtonElement>('#cameraUseBtn');
    const flipBtn = $<HTMLButtonElement>('#cameraFlipBtn');
    if (!video || !shotPreview || !video.videoWidth || !video.videoHeight) return;

    const maxSide = 1800;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        stopCameraCapture();
        cameraCapturedBlob = blob;
        cameraShotUrl = URL.createObjectURL(blob);
        shotPreview.src = cameraShotUrl;
        shotPreview.classList.remove('hidden');
        video.classList.add('hidden');
        snapBtn?.classList.add('hidden');
        flipBtn?.classList.add('hidden');
        retakeBtn?.classList.remove('hidden');
        useBtn?.classList.remove('hidden');
        if (status) status.textContent = 'Revisá la foto o repetila antes de usarla.';
      },
      'image/jpeg',
      0.9,
    );
  });

  $('#cameraRetakeBtn')?.addEventListener('click', () => {
    void startCameraStream();
  });

  $('#cameraFlipBtn')?.addEventListener('click', () => {
    cameraFacingMode = cameraFacingMode === 'environment' ? 'user' : 'environment';
    void startCameraStream();
  });

  $('#cameraUseBtn')?.addEventListener('click', async () => {
    if (!cameraCapturedBlob) return;
    const file = new File([cameraCapturedBlob], `foto-${Date.now()}.jpg`, {
      type: 'image/jpeg',
    });
    const handler = cameraOnCapture;
    $<HTMLDialogElement>('#cameraCaptureDialog')?.close();
    if (handler) await handler(file);
  });

  $('#cameraFallbackFileBtn')?.addEventListener('click', () => {
    const fallback = cameraFallbackInput;
    $<HTMLDialogElement>('#cameraCaptureDialog')?.close();
    fallback?.click();
  });

  $('#cameraCaptureDialog')?.addEventListener('close', () => {
    stopCameraCapture();
    cameraOnCapture = null;
    cameraFallbackInput = null;
  });

  $('#annotationForm')!.onsubmit = async (e) => {
    e.preventDefault();
    const id = $<HTMLInputElement>('#annotationId')!.value;
    const old = id ? await get<Entry>('entries', id) : undefined;
    const entry: Entry = {
      ...old,
      id: id || uid(),
      bookId: $<HTMLInputElement>('#annotationBook')!.value,
      page: Number($<HTMLInputElement>('#annotationPage')!.value),
      title: $<HTMLInputElement>('#annotationHeading')!.value.trim(),
      text: $<HTMLTextAreaElement>('#annotationText')!.value.trim(),
      comment: $<HTMLTextAreaElement>('#annotationPersonalComment')!.value.trim(),
      photo: photoData || old?.photo || null,
      photoMediaId: old?.photoMediaId || null,
      createdAt: old?.createdAt || new Date().toISOString(),
    };
    await pushEntryToCloud(entry);
    photoData = null;
    $<HTMLDialogElement>('#annotationDialog')?.close();
    if ($<HTMLDialogElement>('#detailDialog')?.open) await renderDetail();
    if ($('#notebookView')?.classList.contains('active')) await renderJournal();
  };

  $('#noteCommentForm')!.onsubmit = async (e) => {
    e.preventDefault();
    const id = $<HTMLInputElement>('#commentNoteId')!.value;
    const n = await get<Note>('notes', id);
    if (!n) return;
    n.comment = $<HTMLTextAreaElement>('#noteCommentText')!.value.trim();
    await pushNoteToCloud(n);
    $<HTMLDialogElement>('#noteCommentDialog')?.close();
    await renderDetail();
  };

  $('#askCommentGemini')!.onclick = async () => {
    const n = await get<Note>('notes', $<HTMLInputElement>('#commentNoteId')!.value);
    if (!n) return;
    const comment = $<HTMLTextAreaElement>('#noteCommentText')!.value.trim();
    n.comment = comment;
    await pushNoteToCloud(n);
    $<HTMLDialogElement>('#noteCommentDialog')?.close();
    await renderDetail();
    void openGemini({
      noteId: n.id,
      extraText: comment ? commentDiscussionPrompt('mi comentario sobre esta nota final') : 'Quiero conversar sobre esta nota final.',
    });
  };

  $('#askAnnotationGemini')!.onclick = async () => {
    const form = $<HTMLFormElement>('#annotationForm')!;
    if (!form.reportValidity()) return;
    const bookId = $<HTMLInputElement>('#annotationBook')!.value;
    const id = $<HTMLInputElement>('#annotationId')!.value;
    const old = id ? await get<Entry>('entries', id) : undefined;
    const entry: Entry = {
      ...old,
      id: id || uid(),
      bookId,
      page: Number($<HTMLInputElement>('#annotationPage')!.value),
      title: $<HTMLInputElement>('#annotationHeading')!.value.trim(),
      text: $<HTMLTextAreaElement>('#annotationText')!.value.trim(),
      comment: $<HTMLTextAreaElement>('#annotationPersonalComment')!.value.trim(),
      photo: photoData || old?.photo || null,
      photoMediaId: old?.photoMediaId || null,
      createdAt: old?.createdAt || new Date().toISOString(),
    };
    await pushEntryToCloud(entry);
    photoData = null;
    $<HTMLDialogElement>('#annotationDialog')?.close();
    if ($<HTMLDialogElement>('#detailDialog')?.open) await renderDetail();
    if ($('#notebookView')?.classList.contains('active')) await renderJournal();
    void openGemini({
      bookId,
      entryId: entry.id,
      image: entry.photo || null,
      extraText: annotationAsComment
        ? `Tomá como referencia principal el comentario que escribí sobre «${activeBook?.title || 'este libro'}». Quiero dialogar sobre mi interpretación y después haré una pregunta concreta en el chat. No supongas que quiero spoilers; respondé según lo que pregunte.`
        : entry.comment
          ? commentDiscussionPrompt('mi comentario sobre esta anotación o fotografía')
          : 'Ayudame a pensar críticamente esta anotación y su fotografía.',
    });
  };

  $('#journalList')!.onclick = async (e) => {
    const target = e.target as HTMLElement;
    const photo = target.closest<HTMLElement>('[data-open-photo]');
    const edit = target.closest<HTMLElement>('[data-edit-entry]');
    const ask = target.closest<HTMLElement>('[data-ask-entry]');
    if (photo) void openPhoto(photo.dataset.openPhoto!);
    else if (edit) {
      const entry = await get<Entry>('entries', edit.dataset.editEntry!);
      if (entry) openAnnotation(entry.bookId, entry);
    } else if (ask) {
      const entry = await get<Entry>('entries', ask.dataset.askEntry!);
      if (entry) {
        void openGemini({
          bookId: entry.bookId,
          entryId: entry.id,
          image: entry.photo || null,
          extraText: entry.comment ? commentDiscussionPrompt('mi comentario sobre esta anotación o fotografía') : '',
        });
      }
    }
  };

  $('#backupBtn')!.onclick = async () => {
    const data = {
      app: 'Librarium',
      version: 4,
      exportedAt: new Date().toISOString(),
      books: await all('books'),
      notes: await all('notes'),
      entries: await all('entries'),
      quotes: await all('quotes'),
      analyses: await all('analyses'),
      characters: await all('characters'),
      characterRelations: await all('characterRelations'),
      conversations: await all('conversations'),
    };
    download(data, 'librarium-copia-' + new Date().toISOString().slice(0, 10) + '.json');
  };

  $('#restoreBtn')!.onclick = () => $('#restoreFile')?.click();

  $('#restoreFile')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const d = parseBackupJSON(await file.text());
      const ok = await showConfirmDialog({
        eyebrow: 'RESTAURAR COPIA',
        title: '¿Incorporar copia de seguridad?',
        message: 'Se incorporarán los datos de la copia. Los registros con el mismo ID se actualizarán.',
        confirmLabel: 'Restaurar',
      });
      if (!ok) return;
      const restored = await restoreBackupData(d, {
        book: pushBookToCloud,
        note: pushNoteToCloud,
        entry: pushEntryToCloud,
        quote: pushQuoteToCloud,
        analysis: pushAnalysisToCloud,
        character: (record) => pushCharacterToCloud(record as Character),
        characterRelation: (record) => pushCharacterRelationToCloud(record as CharacterRelation),
        conversation: pushConversationToCloud,
      }, {
        existingBookIds: new Set((await all<Book>('books')).map((book) => book.id)),
        existingCharacterIds: new Set((await all<Character>('characters')).map((character) => character.id)),
      });
      books = await all<Book>('books');
      render();
      await showConfirmDialog({
        eyebrow: 'COPIA DE SEGURIDAD',
        title: 'Copia restaurada',
        message: `Se incorporaron ${restored} registros del archivo.`,
        noticeOnly: true,
      });
    } catch (err: any) {
      await showConfirmDialog({
        eyebrow: 'COPIA DE SEGURIDAD',
        title: 'No se pudo restaurar',
        message: String(err?.message || err),
        noticeOnly: true,
      });
    } finally {
      input.value = '';
    }
  });

  // Gemini dialog wiring
  $('#geminiForm')!.onsubmit = sendGeminiQuestion;
  $('#geminiStopBtn')?.addEventListener('click', () => {
    geminiStreamController?.abort();
  });
  $('#clearGeminiHistory')!.onclick = clearGeminiHistory;
  const geminiDialog = $<HTMLDialogElement>('#geminiDialog');
  const geminiCard = $('#geminiContextCard');
  geminiCard?.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a,button')) return;
    setGeminiContextCollapsed(!geminiCard.classList.contains('collapsed'));
  });
  geminiCard?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setGeminiContextCollapsed(!geminiCard.classList.contains('collapsed'));
  });
  window.visualViewport?.addEventListener('resize', fitGeminiToViewport);
  window.visualViewport?.addEventListener('scroll', fitGeminiToViewport);
  geminiDialog?.addEventListener('close', () => {
    geminiStreamController?.abort();
    geminiAttachedImage = null;
    geminiDialog.style.height = '';
    geminiDialog.style.top = '';
    // Si el chat se abrió desde la lista de conversaciones, al cerrarlo volvemos a ella.
    if (aiConvsReturn) {
      aiConvsReturn = false;
      void openAiConversations();
    }
  });
  $('#aiConvsBanner')?.addEventListener('click', () => void openAiConversations());
  $('#aiConvsSearch')?.addEventListener('input', renderAiConversationList);
  $('#aiConvsList')?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-conv-id]');
    const row = aiConvRows.find((r) => r.conv.id === button?.dataset.convId);
    if (!row) return;
    $<HTMLDialogElement>('#aiConvsDialog')?.close();
    aiConvsReturn = true;
    void openGemini(row.seed);
  });
  $('#aiAutofillBookBtn')?.addEventListener('click', () => void autofillBookWithAI());

  $$('[data-ai-prompt]').forEach((b) => {
    b.onclick = () => {
      ($<HTMLTextAreaElement>('#geminiQuestion')!).value = b.dataset.aiPrompt || '';
      $<HTMLFormElement>('#geminiForm')?.requestSubmit();
    };
  });
  $('#geminiQuestion')?.addEventListener('input', autosizeGeminiInput);
  $('#geminiQuestion')?.addEventListener('keydown', (e) => {
    const desktopEnter = e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches;
    if (desktopEnter || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      $<HTMLFormElement>('#geminiForm')?.requestSubmit();
    }
  });

  $('#footerUpdatesBtn')?.addEventListener('click', () => {
    renderUpdatesList();
    $<HTMLDialogElement>('#updatesDialog')?.showModal();
  });

  initAskGesture();
}

export async function initApp() {
  initTheme();
  await openDB();
  books = await all<Book>('books');
  wireEvents();
  initEnvironmentNotices();
  render();
  initAISettings();
  initSearch({ loadDocs: loadSearchDocs, open: openSearchResult });
  initAccountSettings();
  initInstall();
  setupServiceWorkerUpdates();

  initSync(
    async () => {
      books = await all<Book>('books');
      render();
      if ($('#notebookView')?.classList.contains('active')) await renderJournal();
      if ($('#quotesView')?.classList.contains('active')) await renderQuoteCollection();
      if ($<HTMLDialogElement>('#detailDialog')?.open && activeBook) {
        const refreshed = books.find((b) => b.id === activeBook!.id);
        if (refreshed) {
          activeBook = refreshed;
          const isEditingReview =
            detailTab === 'review' &&
            document.activeElement?.id === 'detailReviewText';
          const isEditingCharacters = detailTab === 'characters' && Boolean(charactersFeature?.isCharactersBusy());
          if (!isEditingReview && !isEditingCharacters) await renderDetail();
        }
      }
    },
    (status, message, user) => {
      void updateAccountUI(status, message, user);
    },
  );
}

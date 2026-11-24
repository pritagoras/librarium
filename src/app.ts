import { all, get, openDB } from './db';
import { signInWithGoogle, signOutUser } from './firebase';
import {
  deleteFromCloud,
  getSyncState,
  initSync,
  migrateLocalDataToCloud,
  pushAnalysisToCloud,
  pushBookToCloud,
  pushConversationToCloud,
  pushEntryToCloud,
  pushNoteToCloud,
  pushQuoteToCloud,
  sanitizeId,
} from './sync';
import type {
  AISettings,
  Book,
  BookAnalysis,
  BookStatus,
  Conversation,
  ConversationTurn,
  Entry,
  Note,
  Quote,
  SortOption,
  SyncStatus,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(s: string): T | null =>
  document.querySelector(s) as T | null;
const $$ = <T extends HTMLElement = HTMLElement>(s: string): T[] =>
  Array.from(document.querySelectorAll(s)) as T[];

const statusNames: Record<BookStatus, string> = {
  pending: 'Pendiente',
  reading: 'En lectura',
  paused: 'Pausado',
  finished: 'Terminado',
};

type DetailTab = 'notes' | 'entries' | 'photos' | 'quotes' | 'review' | 'settings';

let books: Book[] = [];
let activeBook: Book | null = null;
let detailTab: DetailTab = 'notes';
let pendingImport: { obj: any; notes: any[] } | null = null;
let coverData: string | null = null;
let photoData: string | null = null;
let quotePhotoData: string[] = [];
let quoteOCRGeneration = 0;
let isbnScannerStream: MediaStream | null = null;
let installPromptEvent: any = null;
let isAnalyzingBook = false;

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

const AI_SETTINGS_KEY = 'librarium-ai-settings';
const AI_SETTINGS_DEFAULTS: AISettings = {
  model: 'gemini-4-hydrogen',
  thinking: 'auto',
  style: 'natural',
  customStyle: '',
};

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

function showConfirmDialog(options: {
  eyebrow?: string;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  noticeOnly?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = $<HTMLDialogElement>('#confirmDialog');
    if (!dlg) {
      resolve(false);
      return;
    }
    $('#confirmEyebrow')!.textContent =
      options.eyebrow || (options.noticeOnly ? 'AVISO' : 'CONFIRMAR');
    $('#confirmTitle')!.textContent = options.title;
    $('#confirmMessage')!.textContent = options.message;
    const cancelBtn = $<HTMLButtonElement>('#confirmCancelBtn')!;
    const okBtn = $<HTMLButtonElement>('#confirmOkBtn')!;
    cancelBtn.textContent = options.cancelLabel || 'Cancelar';
    cancelBtn.classList.toggle('hidden', Boolean(options.noticeOnly));
    okBtn.textContent =
      options.confirmLabel || (options.noticeOnly ? 'Entendido' : 'Confirmar');
    okBtn.className = options.danger ? 'danger-solid' : 'primary';

    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(result);
    };
    const onClose = () => finish(false);
    dlg.addEventListener('close', onClose, { once: true });
    cancelBtn.onclick = () => finish(false);
    okBtn.onclick = () => finish(true);
    if (!dlg.open) dlg.showModal();
    okBtn.focus();
  });
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

function applyTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const sw = $<HTMLInputElement>('#themeSwitch');
  if (sw) sw.checked = dark;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#242622' : '#f4efe5');
}

function initTheme() {
  let dark = false;
  try {
    dark = localStorage.getItem('librarium-theme') === 'dark';
  } catch {}
  applyTheme(dark);
  const sw = $<HTMLInputElement>('#themeSwitch');
  if (sw) {
    sw.onchange = (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      applyTheme(checked);
      try {
        localStorage.setItem('librarium-theme', checked ? 'dark' : 'light');
      } catch {}
    };
  }
}

function initInstall() {
  const button = $<HTMLButtonElement>('#installAppBtn');
  const help = $('#installAppHelp');
  if (!button || !help) return;

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true;

  const showHelp = () => {
    const ua = navigator.userAgent;
    if (
      /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    ) {
      help.textContent = 'En Safari: Compartir → Añadir a pantalla de inicio.';
    } else if (/android/i.test(ua)) {
      help.textContent =
        'En Chrome: menú ⋮ → Instalar aplicación o Añadir a pantalla de inicio.';
    } else {
      help.textContent = 'Usá la opción Instalar aplicación del menú del navegador.';
    }
  };

  if (standalone) {
    button.textContent = 'Librarium instalada';
    button.disabled = true;
    help.textContent = 'Ya está en tu pantalla de inicio.';
    return;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPromptEvent = event;
  });

  button.onclick = async () => {
    if (!installPromptEvent) {
      showHelp();
      return;
    }
    installPromptEvent.prompt();
    const choice = await installPromptEvent.userChoice;
    installPromptEvent = null;
    if (choice.outcome === 'accepted') {
      button.textContent = 'Instalando…';
      help.textContent = 'Seguí los pasos que muestra el navegador.';
    } else {
      showHelp();
    }
  };

  window.addEventListener('appinstalled', () => {
    button.textContent = 'Librarium instalada';
    button.disabled = true;
    help.textContent = 'Ya está en tu pantalla de inicio.';
  });
}

function setupServiceWorkerUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const notice = $('#updateNotice');
  const applyBtn = $('#applyUpdateBtn');
  const dismissBtn = $('#dismissUpdateBtn');
  if (!notice || !applyBtn || !dismissBtn) return;

  const show = () => notice.classList.remove('hidden');
  let refreshing = false;
  let registrationRef: ServiceWorkerRegistration | null = null;
  const inspectedWorkers = new WeakSet<ServiceWorker>();

  const inspect = (registration: ServiceWorkerRegistration) => {
    if (registration.waiting && navigator.serviceWorker.controller) show();
    const worker = registration.installing;
    if (worker && !inspectedWorkers.has(worker)) {
      inspectedWorkers.add(worker);
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) show();
      });
    }
  };

  const check = () => {
    if (!registrationRef || document.visibilityState !== 'visible') return;
    registrationRef.update().then(() => inspect(registrationRef!)).catch(() => {});
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  navigator.serviceWorker
    .register('./service-worker.js', { updateViaCache: 'none' })
    .then((registration) => {
      registrationRef = registration;
      registration.addEventListener('updatefound', () => inspect(registration));
      inspect(registration);
      check();
      setInterval(check, 5 * 60 * 1000);
      document.addEventListener('visibilitychange', check);
      window.addEventListener('pageshow', check);
      window.addEventListener('focus', check);
      window.addEventListener('online', check);
    })
    .catch(() => {});

  applyBtn.onclick = () => {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg?.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      else window.location.reload();
    });
  };
  dismissBtn.onclick = () => notice.classList.add('hidden');
}

function switchView(v: string) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === `${v}View`));
  if (v === 'notebook') void renderJournal();
  if (v === 'quotes') void renderQuoteCollection();
}

function coverHTML(b: Book): string {
  const src = b.cover || b.coverUrl;
  return src
    ? `<img class="cover" src="${esc(src)}" alt="Portada de ${esc(b.title)}" referrerpolicy="no-referrer">`
    : `<div class="cover cover-placeholder">${esc(b.title)}</div>`;
}

function card(b: Book): string {
  const pct = b.totalPages
    ? Math.min(100, Math.round(((b.currentPage || 0) / b.totalPages) * 100))
    : 0;
  const ratingText = b.rating ? `★ ${b.rating}/5` : '';
  const tagsList = (b.tags || []).slice(0, 3).join(' · ');
  const metaExtras = [ratingText, tagsList].filter(Boolean).join(' · ');
  return `<article class="book-card" data-id="${esc(b.id)}">
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
  $('#catalogPanel')?.classList.add('hidden');
  $('#manualMode')?.classList.add('active');
  $('#searchMode')?.classList.remove('active');
  $<HTMLDialogElement>('#bookDialog')?.showModal();
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
      <button type="button" class="secondary" id="chatBookSynthesis">Conversar sobre esta síntesis</button>
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

  const detailContent = $('#detailContent')!;
  detailContent.innerHTML = `<header class="book-page-header">
    <div class="book-page-cover">${coverHTML(b)}</div>
    <div class="book-page-heading">
      <p class="eyebrow">${statusNames[b.status] || 'Pendiente'}</p>
      <h1>${esc(b.title)}</h1>
      <p class="muted">${esc(b.author || 'Autor desconocido')}</p>
      ${metaParts.length ? `<p class="book-detail-meta-line">${metaParts.join(' · ')}</p>` : ''}
      <button type="button" id="readingProgressOpen" class="reading-progress-trigger">
        <strong>Página ${b.currentPage || 0}${b.totalPages ? ` de ${b.totalPages}` : ''}</strong>
        <span>${
          b.totalPages
            ? `${Math.min(100, Math.round(((b.currentPage || 0) / b.totalPages) * 100))}% · `
            : ''
        }Hoy leíste ${pagesToday} ${pagesToday === 1 ? 'página' : 'páginas'}</span>
        <small>Tocá para actualizar tu avance</small>
      </button>
    </div>
  </header>
  <div class="detail-tabs">
    ${(
      [
        ['notes', 'Notas finales'],
        ['entries', 'Anotaciones'],
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
      </div>
      <div class="review-panel">
        <div class="rating-field">
          <span class="field-label">Tu puntuación</span>
          <div id="detailStarsPicker" class="star-picker" role="group" aria-label="Puntuación del libro"></div>
        </div>
        <label style="display:flex;flex-direction:column;gap:8px;font-size:12px;font-weight:600;color:var(--brown)">
          Reseña o balance de lectura
          <textarea id="detailReviewText" maxlength="10000" placeholder="¿Qué ideas te quedaron? ¿A quién se lo recomendarías?">${esc(b.review || '')}</textarea>
        </label>
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
          <div class="note-actions">
            <button type="button" class="ask-gemini" data-ask-note="${esc(n.id)}" title="Preguntar a la IA sobre esta nota">Preguntar a la IA</button>
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
          <h2>${detailTab === 'entries' ? 'Anotaciones' : 'Fotografías'}</h2>
          <p class="muted">${filtered.length} ${
            detailTab === 'entries' ? 'registros' : 'fotografías'
          } · Mantené apretada una para preguntarle a la IA (o clic derecho).</p>
        </div>
        <button class="primary" id="addAnnotation">＋ Nueva anotación</button>
      </div>
      ${
        filtered
          .map(
            (x) => `<article class="journal-item" data-ai-entry="${esc(x.id)}">
              <small>PÁGINA ${x.page} · ${new Date(x.createdAt).toLocaleDateString('es-AR')}</small>
              <h3>${esc(x.title || 'Sin título')}</h3>
              <p>${esc(x.text || '')}</p>
              ${
                x.photo
                  ? `<img class="annotation-photo-thumb" data-open-photo="${esc(x.id)}" src="${esc(x.photo)}" alt="Abrir fotografía">`
                  : ''
              }
              <div class="annotation-actions">
                <button class="mini" data-edit-entry="${esc(x.id)}">Editar anotación</button>
                <button class="mini" data-ask-entry="${esc(x.id)}">Preguntar a la IA</button>
                <button class="mini" data-delete-entry="${esc(x.id)}">Eliminar</button>
              </div>
            </article>`,
          )
          .join('') ||
        `<p class="empty-inline">Todavía no hay ${
          detailTab === 'entries' ? 'anotaciones' : 'fotografías'
        }.</p>`
      }`;
  }

  $('#readingProgressOpen')?.addEventListener('click', () => openReadingProgressDialog(b));
  $('#addQuote')?.addEventListener('click', () => openQuoteForm(b.id));
  if (detailTab === 'quotes') bindQuoteActions(p);
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
    x.onclick = () => openGemini({ noteId: x.dataset.askNote });
  });

  $$('[data-ask-entry]').forEach((x) => {
    x.onclick = () => openGemini({ entryId: x.dataset.askEntry });
  });

  $$('[data-delete-entry]').forEach((x) => {
    x.onclick = async () => {
      const ok = await showConfirmDialog({
        eyebrow: 'ANOTACIÓN',
        title: '¿Eliminar este registro?',
        message: 'Se eliminará la anotación junto con su foto si tuviera una.',
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
    await deleteFromCloud('conversations', `book__${b.id}`);
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
  const entries = (await all<Entry>('entries')).filter((e) => e.bookId === book.id && (e.text || e.title));
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

  isAnalyzingBook = true;
  await renderDetail();

  try {
    const aiSettings = getAISettings();
    const res = await fetch('/api/gemini/book-synthesis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookTitle: book.title,
        bookAuthor: book.author || '',
        bookTags: book.tags || [],
        items,
        model: aiSettings.model,
        thinking: aiSettings.thinking,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error HTTP ${res.status}`);

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
    await showConfirmDialog({
      eyebrow: 'SÍNTESIS LITERARIA',
      title: 'No se pudo completar el análisis',
      message: String(err?.message || err),
      noticeOnly: true,
    });
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
    ${quote.analysis ? `<p class="quote-analysis"><strong>Mi análisis:</strong> ${esc(quote.analysis)}</p>` : ''}
    ${photos ? `<div class="quote-photos">${photos}</div>` : ''}
    <div class="annotation-actions">
      <button type="button" class="mini" data-edit-quote="${esc(quote.id)}">Editar cita</button>
      <button type="button" class="mini" data-ask-quote="${esc(quote.id)}">Conversar con IA</button>
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
      if (quote) void openGemini({ bookId: quote.bookId, quoteId: quote.id });
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

function optimizeQuotePhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
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
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(Error('No se pudo leer una de las fotos.'));
    };
    image.src = url;
  });
}

async function transcribeQuotePhoto(index: number, button: HTMLButtonElement) {
  const image = quotePhotoData[index];
  if (!image) return;
  const generation = quoteOCRGeneration;
  const label = button.textContent || 'Extraer texto';
  $$<HTMLButtonElement>('[data-transcribe-quote-photo],[data-remove-quote-photo]').forEach(
    (item) => (item.disabled = true),
  );
  button.textContent = 'Leyendo…';
  $('#quotePhotoStatus')!.textContent =
    'Gemini está leyendo la foto. Después vas a poder corregir el texto.';
  try {
    const [header, data] = image.split(',', 2);
    const mimeType = header.match(/data:(.*?);base64/)?.[1] || 'image/jpeg';
    const res = await fetch('/api/gemini/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mimeType, data, model: getAISettings().model }),
    });
    const result = await res.json();
    if (!res.ok) throw Error(result.error || `Error HTTP ${res.status}`);
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
        $('#quotePhotoStatus')!.textContent = 'Conservé el texto que ya tenías.';
        return;
      }
    }
    quoteText.value = transcript;
    quoteText.focus();
    $('#quotePhotoStatus')!.textContent = 'Texto extraído. Revisalo y corregilo antes de guardar la cita.';
  } catch (error: any) {
    if (generation === quoteOCRGeneration && $<HTMLDialogElement>('#quoteDialog')?.open) {
      $('#quotePhotoStatus')!.textContent = `No se pudo extraer el texto: ${error.message}`;
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
  $('#photoViewerComment')!.textContent = quote.text;
  $('#editPhotoAnnotation')?.classList.add('hidden');
  $('#askPhotoGemini')!.onclick = () => {
    $<HTMLDialogElement>('#photoViewerDialog')?.close();
    void openGemini({ bookId: quote.bookId, quoteId: quote.id, image: photo });
  };
  $<HTMLDialogElement>('#photoViewerDialog')?.showModal();
}

function slug(s: string) {
  return (s || 'librarium')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function download(obj: unknown, name: string) {
  const a = document.createElement('a');
  const u = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.href = u;
  a.download = name;
  a.click();
  URL.revokeObjectURL(u);
}

function decodePastedJSON(raw: string) {
  const s = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return JSON.parse(s);
  } catch {}
  const cleaned = s
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) =>
      String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10)),
    )
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\\\s*(\r?\n)/g, '$1')
    .replace(/\\\s*$/g, '');
  return JSON.parse(cleaned);
}

function validateNotesJSON(raw: string) {
  const obj = decodePastedJSON(raw);
  if (!obj || !Array.isArray(obj.notes) || !obj.notes.length) {
    throw Error("El JSON debe incluir un arreglo 'notes' con al menos una nota.");
  }
  let section = 1;
  let lastNumber = 0;
  const seen = new Set<string>();
  const notes = obj.notes.map((n: any, i: number) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      throw Error(`La nota ${i + 1} debe ser un objeto.`);
    }
    const number = Number(n.number);
    if (!Number.isInteger(number) || number < 1) {
      throw Error(`La nota ${i + 1} necesita un número entero mayor que cero.`);
    }
    if (n.section != null) {
      const explicit = Number(n.section);
      if (!Number.isInteger(explicit) || explicit < 1) {
        throw Error(`La sección de la nota ${number} debe ser un entero positivo.`);
      }
      section = explicit;
    } else if (i > 0 && number <= lastNumber) {
      section++;
    }
    lastNumber = number;
    const key = `${section}:${number}`;
    if (seen.has(key)) {
      throw Error(`El número ${number} aparece más de una vez en la sección ${section}.`);
    }
    seen.add(key);
    if (typeof n.text !== 'string' || !n.text.trim()) {
      throw Error(`La nota ${number} necesita texto.`);
    }
    const page = (v: unknown, label: string) => {
      if (v == null || v === '') return null;
      const x = Number(v);
      if (!Number.isInteger(x) || x < 0) {
        throw Error(`La página ${label} de la nota ${number} debe ser un entero igual o mayor que cero, o null.`);
      }
      return x;
    };
    return {
      number,
      section,
      referencePage: page(n.reference_page ?? n.referencePage, 'de referencia'),
      endPage: page(n.end_page ?? n.endPage, 'de nota'),
      text: n.text,
      comment: typeof n.comment === 'string' ? n.comment : '',
      read: Boolean(n.read),
    };
  });
  return { obj, notes };
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
  $<HTMLFormElement>('#annotationForm')?.reset();
  ($<HTMLInputElement>('#annotationBook')!).value = bookId;
  ($<HTMLInputElement>('#annotationId')!).value = entry?.id || '';
  $('#annotationTitle')!.textContent = entry ? 'Editar anotación' : 'Nueva anotación';
  ($<HTMLInputElement>('#annotationPage')!).value = entry?.page != null ? String(entry.page) : '';
  ($<HTMLInputElement>('#annotationHeading')!).value = entry?.title || '';
  ($<HTMLTextAreaElement>('#annotationText')!).value = entry?.text || '';
  $('#annotationPhotoStatus')!.textContent = entry?.photo
    ? 'Ya hay una fotografía. Elegí otra solo si querés reemplazarla.'
    : '';
  photoData = entry?.photo || null;
  $<HTMLDialogElement>('#annotationDialog')?.showModal();
}

async function openPhoto(entryId: string) {
  const entry = await get<Entry>('entries', entryId);
  if (!entry?.photo) return;
  const book = books.find((x) => x.id === entry.bookId);
  $<HTMLImageElement>('#photoViewerImage')!.src = entry.photo;
  $('#photoViewerMeta')!.textContent = `${book?.title || 'Libro'} · Página ${entry.page}`;
  $('#photoViewerTitle')!.textContent = entry.title || 'Fotografía';
  $('#photoViewerComment')!.textContent = entry.text || '';
  $('#editPhotoAnnotation')?.classList.remove('hidden');
  $('#editPhotoAnnotation')!.onclick = () => {
    $<HTMLDialogElement>('#photoViewerDialog')?.close();
    openAnnotation(entry.bookId, entry);
  };
  $('#askPhotoGemini')!.onclick = () => {
    $<HTMLDialogElement>('#photoViewerDialog')?.close();
    void openGemini({ bookId: entry.bookId, entryId: entry.id, image: entry.photo! });
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
          ${
            x.photo
              ? `<img class="annotation-photo-thumb" data-open-photo="${esc(x.id)}" src="${esc(x.photo)}" alt="Abrir fotografía">`
              : ''
          }
          <div class="annotation-actions">
            <button class="mini" data-edit-entry="${esc(x.id)}">Editar anotación</button>
            <button class="mini" data-ask-entry="${esc(x.id)}">Preguntar a la IA</button>
          </div>
        </article>`;
      })
      .join('') || '<p class="empty-inline">Tus anotaciones y fotografías aparecerán acá.</p>';
}

function getAISettings(): AISettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}');
    const model =
      parsed.model === 'gemini-3.1-flash-lite' ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen';
    return { ...AI_SETTINGS_DEFAULTS, ...parsed, model };
  } catch {
    return { ...AI_SETTINGS_DEFAULTS };
  }
}

function saveAISettings() {
  const settings: AISettings = {
    model: ($<HTMLSelectElement>('#aiModel')?.value as AISettings['model']) || 'gemini-4-hydrogen',
    thinking: ($<HTMLSelectElement>('#aiThinking')?.value as AISettings['thinking']) || 'auto',
    style: ($<HTMLSelectElement>('#aiStyle')?.value as AISettings['style']) || 'natural',
    customStyle: ($<HTMLTextAreaElement>('#aiCustomStyle')?.value || '').trim().slice(0, 600),
  };
  try {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
    $('#aiSettingsStatus')!.textContent = 'Preferencias guardadas en este navegador.';
  } catch {
    $('#aiSettingsStatus')!.textContent = 'No se pudieron guardar las preferencias.';
  }
  $('#aiCustomStyleWrap')?.classList.toggle('hidden', settings.style !== 'custom');
}

function aiStyleInstruction(settings = getAISettings()): string {
  const styles: Record<string, string> = {
    natural: 'Respondé en español, con claridad y tono natural. Explicá los términos difíciles cuando ayude.',
    concise: 'Respondé en español de forma breve y directa. Priorizá la respuesta principal y evitá repeticiones.',
    detailed:
      'Respondé en español con detalle y análisis ordenado. Desarrollá las ideas importantes sin agregar datos no respaldados.',
    socratic:
      'Respondé en español con preguntas orientadoras que ayuden a pensar el pasaje, junto con una explicación útil.',
  };
  const base = styles[settings.style] || styles.natural;
  const contextPolicy =
    'Tomá la nota, el pasaje y el libro como contexto. Si el usuario pide relacionarlos, compararlos o aplicarlos a otro autor, obra, época o concepto, contestá directamente esa consigna con conocimiento general pertinente. No empieces aclarando que ese autor o tema no aparece en el fragmento, ni limites la respuesta al material citado, salvo que el usuario pida expresamente un análisis exclusivo de ese material. Separá con naturalidad lo que dice la fuente de la comparación o interpretación cuando sea útil. Evitá advertencias y aclaraciones genéricas; mencioná una limitación solo si cambia de verdad la respuesta.';
  return `${base}\n${contextPolicy}${
    settings.style === 'custom' && settings.customStyle
      ? `\nPreferencias adicionales: ${settings.customStyle}`
      : ''
  }`;
}

function updateAccountUI(_status: SyncStatus, message: string, user: any) {
  const accountBtn = $('#accountBtn');
  const statusText = $('#syncStatusText');
  const signedOutView = $('#accountSignedOutView');
  const signedInView = $('#accountSignedInView');
  const avatar = $<HTMLImageElement>('#accountAvatar');
  const nameEl = $('#accountName');
  const emailEl = $('#accountEmail');

  if (statusText) statusText.textContent = message;

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
}

function initSettings() {
  const ai = getAISettings();
  ($<HTMLSelectElement>('#aiModel')!).value = ai.model;
  ($<HTMLSelectElement>('#aiThinking')!).value = ai.thinking;
  ($<HTMLSelectElement>('#aiStyle')!).value = ai.style;
  ($<HTMLTextAreaElement>('#aiCustomStyle')!).value = ai.customStyle;
  $('#aiCustomStyleWrap')?.classList.toggle('hidden', ai.style !== 'custom');

  ['#aiModel', '#aiThinking', '#aiStyle'].forEach((selector) =>
    $(selector)?.addEventListener('change', saveAISettings),
  );
  $('#aiCustomStyle')?.addEventListener('input', saveAISettings);

  $('#settingsOpen')!.onclick = () => $<HTMLDialogElement>('#settingsDialog')?.showModal();
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
}

async function handleGoogleSignIn() {
  const statusEl = $('#syncStatusText');
  const dlg = $<HTMLDialogElement>('#settingsDialog');
  try {
    await signInWithGoogle();
  } catch (err: any) {
    if (statusEl) {
      if (err?.code === 'auth/popup-closed-by-user') {
        statusEl.textContent = 'Se cerró la ventana de inicio de sesión.';
      } else if (err?.code === 'auth/unauthorized-domain') {
        statusEl.textContent = `El dominio actual (${window.location.hostname}) no está autorizado en Firebase Auth. Agregalo en Firebase Console → Authentication → Settings → Authorized domains (proyecto celtic-aloe-r9brs).`;
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
  const ask = (el: HTMLElement) => {
    firedAt = Date.now();
    if (el.dataset.aiNote) void openGemini({ noteId: el.dataset.aiNote });
    else if (el.dataset.aiEntry) void openGemini({ entryId: el.dataset.aiEntry });
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

async function openGemini(
  seed: {
    noteId?: string;
    entryId?: string | null;
    quoteId?: string;
    bookId?: string;
    image?: string | null;
    extraText?: string;
    analysis?: BookAnalysis;
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
        : analysis && book
          ? `book__${sanitizeId(book.id)}`
          : null;

  geminiHistory = [];
  geminiConversationHadImages = false;
  geminiExtraContext = seed.extraText || '';
  geminiAttachedImage = seed.image ?? entry?.photo ?? null;

  $('#geminiMessages')!.replaceChildren();
  ($<HTMLTextAreaElement>('#geminiQuestion')!).value = '';
  ($<HTMLInputElement>('#geminiImage')!).value = '';

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
          'Se recuperó la conversación. Las imágenes consultadas antes no se guardan en el historial para ahorrar espacio; podés volver a adjuntarlas.',
        );
      }
    }
  }

  $('#clearGeminiHistory')?.classList.toggle('hidden', !geminiConversationId || !geminiHistory.length);
  renderGeminiContextCard();
  $('#geminiImageStatus')!.textContent = geminiAttachedImage
    ? 'Se incluirá la foto seleccionada. También podés elegir otra.'
    : quote?.photos?.length
      ? `Se incluirán las ${quote.photos.length} fotos de esta cita en la primera consulta.`
      : 'También podés adjuntar una foto de un pasaje.';
  $<HTMLDialogElement>('#geminiDialog')?.showModal();
  $<HTMLTextAreaElement>('#geminiQuestion')?.focus();
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

  const personalComment = note?.comment || quote?.analysis;
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

function addGeminiMessage(role: 'user' | 'model' | 'system' | 'error', text: string) {
  const p = document.createElement('div');
  p.className = `gemini-message ${role}`;
  if (role === 'model') p.innerHTML = renderGeminiMarkdown(text);
  else p.textContent = text;
  $('#geminiMessages')!.append(p);
  p.scrollIntoView({ block: 'nearest' });
}

function restoreGeminiTranscript(history: ConversationTurn[]) {
  for (const item of history) {
    if (item.role !== 'user' && item.role !== 'model') continue;
    const texts = (item.parts || []).map((part) => part.text).filter(Boolean);
    if (!texts.length) continue;
    addGeminiMessage(item.role, item.role === 'user' ? texts[texts.length - 1] : texts.join('\n'));
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
}

async function sendGeminiQuestion(e: Event) {
  e.preventDefault();
  const qInput = $<HTMLTextAreaElement>('#geminiQuestion')!;
  const question = qInput.value.trim();
  if (!question) return;
  const button = $<HTMLButtonElement>('#geminiSend')!;
  button.disabled = true;
  button.textContent = 'Consultando…';
  const aiSettings = getAISettings();
  addGeminiMessage('user', question);
  qInput.value = '';

  try {
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
      if (geminiExtraContext) context.push(geminiExtraContext);
      if (context.length) {
        context.push(
          'Usá este material como contexto principal sobre la nota o el pasaje. Si la pregunta pide relacionarlo con otros autores, obras, épocas o ideas, respondé la relación solicitada con conocimiento general y no aclares de entrada que esos temas no aparecen en la cita. No atribuyas a la fuente datos que provienen de la comparación.',
        );
        parts.push({ text: context.filter(Boolean).join('\n\n') });
      }
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
    ($<HTMLInputElement>('#geminiImage')!).value = '';
    $('#geminiImageStatus')!.textContent = 'También podés adjuntar una foto de un pasaje.';

    const contents = [...geminiHistory, { role: 'user' as const, parts }];
    const response = await fetch('/api/gemini/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: aiStyleInstruction(aiSettings),
        model: aiSettings.model,
        thinking: aiSettings.thinking,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `Error HTTP ${response.status}`);

    const answer = String(result.text || '').trim();
    if (!answer) throw Error('Gemini no devolvió texto.');
    geminiHistory = [...contents, { role: 'model', parts: [{ text: answer }] }];
    geminiExtraContext = '';
    if (result.model && result.model !== aiSettings.model) {
      addGeminiMessage('system', `Respondió ${result.model}; tu modelo preferido estaba saturado.`);
    }
    addGeminiMessage('model', answer);
    await saveGeminiHistory();
  } catch (err: any) {
    addGeminiMessage('error', `No pude consultar Gemini: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Enviar';
  }
}

function wireEvents() {
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

  $('#coverFile')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) coverData = await fileData(file);
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

  $('#quotePhotos')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    if (quotePhotoData.length + files.length > 5) {
      $('#quotePhotoStatus')!.textContent =
        'El máximo es 5 fotos por cita. Quitá alguna para agregar otras.';
      input.value = '';
      return;
    }
    try {
      if (files.some((file) => !file.type.startsWith('image/'))) {
        throw Error('Elegí archivos de imagen.');
      }
      $('#quotePhotoStatus')!.textContent = 'Optimizando fotos…';
      const optimized: string[] = [];
      for (const file of files) optimized.push(await optimizeQuotePhoto(file));
      quotePhotoData.push(...optimized);
      renderQuotePhotoPreview();
      $('#quotePhotoStatus')!.textContent =
        `${quotePhotoData.length} de 5 fotos. Se guardarán optimizadas y sincronizadas.`;
    } catch (error: any) {
      $('#quotePhotoStatus')!.textContent = error.message;
    } finally {
      input.value = '';
    }
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

  $('#annotationPhoto')?.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) {
      photoData = await fileData(f);
      $('#annotationPhotoStatus')!.textContent =
        'Nueva fotografía seleccionada; reemplazará la anterior al guardar.';
    }
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
    $<HTMLDialogElement>('#noteCommentDialog')?.close();
    void openGemini({
      noteId: n.id,
      extraText: comment
        ? `Comentario que estoy escribiendo: ${comment}`
        : 'Quiero conversar sobre esta nota y mi comentario personal.',
    });
  };

  $('#askAnnotationGemini')!.onclick = () => {
    const bookId = $<HTMLInputElement>('#annotationBook')!.value;
    const entryId = $<HTMLInputElement>('#annotationId')!.value || null;
    const page = $<HTMLInputElement>('#annotationPage')!.value;
    const title = $<HTMLInputElement>('#annotationHeading')!.value.trim();
    const text = $<HTMLTextAreaElement>('#annotationText')!.value.trim();
    const image = photoData;
    const extraText = `Anotación que estoy editando${page ? ` (página ${page})` : ''}${
      title ? `: ${title}` : ''
    }.\n${text || '(todavía no escribí un comentario)'}`;
    $<HTMLDialogElement>('#annotationDialog')?.close();
    void openGemini({ bookId, entryId, image, extraText });
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
        });
      }
    }
  };

  $('#backupBtn')!.onclick = async () => {
    const data = {
      app: 'Librarium',
      version: 3,
      exportedAt: new Date().toISOString(),
      books: await all('books'),
      notes: await all('notes'),
      entries: await all('entries'),
      quotes: await all('quotes'),
      analyses: await all('analyses'),
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
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.books) || !Array.isArray(d.notes) || !Array.isArray(d.entries)) {
        throw Error('Copia no reconocida');
      }
      const ok = await showConfirmDialog({
        eyebrow: 'RESTAURAR COPIA',
        title: '¿Incorporar copia de seguridad?',
        message: 'Se incorporarán los datos de la copia. Los registros con el mismo ID se actualizarán.',
        confirmLabel: 'Restaurar',
      });
      if (!ok) return;
      for (const b of d.books) {
        await pushBookToCloud({
          ...b,
          tags: Array.isArray(b.tags) ? b.tags : [],
          rating: b.rating ?? null,
          review: b.review || '',
        });
      }
      for (const n of d.notes) await pushNoteToCloud(n);
      for (const x of d.entries) await pushEntryToCloud(x);
      for (const q of Array.isArray(d.quotes) ? d.quotes : []) await pushQuoteToCloud(q);
      for (const a of Array.isArray(d.analyses) ? d.analyses : []) await pushAnalysisToCloud(a);
      for (const c of Array.isArray(d.conversations) ? d.conversations : []) {
        if (c.bookId) await pushConversationToCloud(c);
      }
      books = await all<Book>('books');
      render();
      await showConfirmDialog({
        eyebrow: 'COPIA DE SEGURIDAD',
        title: 'Copia restaurada',
        message: 'Se incorporaron todos los libros y registros del archivo.',
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
  $('#geminiImage')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    geminiAttachedImage = null;
    if (!f) {
      $('#geminiImageStatus')!.textContent = 'También podés adjuntar una foto de un pasaje.';
      return;
    }
    if (!f.type.startsWith('image/')) {
      input.value = '';
      $('#geminiImageStatus')!.textContent = 'Elegí un archivo de imagen.';
      return;
    }
    if (f.size > 15 * 1024 * 1024) {
      input.value = '';
      $('#geminiImageStatus')!.textContent = 'La imagen supera 15 MB; elegí una más liviana.';
      return;
    }
    geminiAttachedImage = await fileData(f);
    $('#geminiImageStatus')!.textContent = `Imagen lista: ${f.name}`;
  });
  $('#geminiForm')!.onsubmit = sendGeminiQuestion;
  $('#clearGeminiHistory')!.onclick = clearGeminiHistory;
  $('#geminiDialog')?.addEventListener('close', () => {
    geminiAttachedImage = null;
    ($<HTMLInputElement>('#geminiImage')!).value = '';
  });
  $$('[data-ai-prompt]').forEach((b) => {
    b.onclick = () => {
      ($<HTMLTextAreaElement>('#geminiQuestion')!).value = b.dataset.aiPrompt || '';
      $<HTMLFormElement>('#geminiForm')?.requestSubmit();
    };
  });
  $('#geminiQuestion')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $<HTMLFormElement>('#geminiForm')?.requestSubmit();
    }
  });
  initAskGesture();
}

export async function initApp() {
  initTheme();
  await openDB();
  books = await all<Book>('books');
  wireEvents();
  render();
  initSettings();
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
          if (!isEditingReview) await renderDetail();
        }
      }
    },
    (status, message, user) => {
      updateAccountUI(status, message, user);
    },
  );
}

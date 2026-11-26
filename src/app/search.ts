/**
 * Pantalla de búsqueda global. Los datos y la navegación los aporta app.ts;
 * la coincidencia vive en `search-model.ts`.
 */
import { SEARCH_KINDS, SEARCH_KIND_LABELS, searchDocs, type SearchDoc, type SearchHit, type SearchKind } from './search-model';

const PAGE = 20;

export interface SearchDeps {
  loadDocs(): Promise<SearchDoc[]>;
  /** Abre el registro encontrado. */
  open(doc: SearchDoc): void | Promise<void>;
}

let deps: SearchDeps;
let docs: SearchDoc[] = [];
let hits: SearchHit[] = [];
let filter: SearchKind | 'all' = 'all';
const shown = new Map<SearchKind, number>();
/** Hay un resultado abierto: al cerrarlo se vuelve a la búsqueda. */
let returning = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char),
  );

function run() {
  const query = $<HTMLInputElement>('searchInput').value.trim();
  hits = searchDocs(docs, query);
  shown.clear();
  paint(query);
}

function paint(query = $<HTMLInputElement>('searchInput').value.trim()) {
  const counts = new Map<SearchKind, number>();
  for (const hit of hits) counts.set(hit.doc.kind, (counts.get(hit.doc.kind) || 0) + 1);
  if (filter !== 'all' && !counts.get(filter)) filter = 'all';

  $('searchFilters').innerHTML = hits.length
    ? (['all', ...SEARCH_KINDS.filter((kind) => counts.get(kind))] as Array<SearchKind | 'all'>)
        .map((kind) => {
          const label = kind === 'all' ? 'Todo' : SEARCH_KIND_LABELS[kind];
          const total = kind === 'all' ? hits.length : counts.get(kind);
          return `<button type="button" class="search-chip" data-search-kind="${kind}" aria-pressed="${filter === kind}">${label} <span>${total}</span></button>`;
        })
        .join('')
    : '';

  if (!hits.length) {
    const message =
      query.length < 2
        ? 'Escribí al menos 2 letras. Se busca en libros, notas, anotaciones, citas, personajes y charlas con la IA.'
        : `No hay resultados para «${query}».`;
    $('searchResults').innerHTML = `<p class="muted ai-convs-empty">${esc(message)}</p>`;
    return;
  }

  $('searchResults').innerHTML = SEARCH_KINDS.filter((kind) => counts.get(kind) && (filter === 'all' || filter === kind))
    .map((kind) => {
      const list = hits.filter((hit) => hit.doc.kind === kind);
      const limit = shown.get(kind) || PAGE;
      return `<section class="ai-convs-group">
        <h3>${SEARCH_KIND_LABELS[kind]}</h3>
        ${list
          .slice(0, limit)
          .map(
            (hit) => `<button type="button" class="ai-conv-row" data-search-hit="${hits.indexOf(hit)}">
              <span class="ai-conv-meta"><b>${esc(hit.doc.title)}</b>${hit.doc.kind === 'book' ? '' : `<span>${esc(hit.doc.bookTitle)}</span>`}</span>
              ${hit.snippet.length ? `<span class="search-snippet">${hit.snippet.map((p) => (p.mark ? `<mark>${esc(p.text)}</mark>` : esc(p.text))).join('')}</span>` : ''}
            </button>`,
          )
          .join('')}
        ${list.length > limit ? `<button type="button" class="secondary" data-search-more="${kind}">Ver más (${list.length - limit})</button>` : ''}
      </section>`;
    })
    .join('');
}

export async function openSearch() {
  const dialog = $<HTMLDialogElement>('searchDialog');
  if (!dialog.open) dialog.showModal();
  docs = await deps.loadDocs();
  run();
  $<HTMLInputElement>('searchInput').select();
}

export function initSearch(dependencies: SearchDeps) {
  deps = dependencies;
  const dialog = $<HTMLDialogElement>('searchDialog');

  $('searchOpen').addEventListener('click', () => {
    filter = 'all';
    $<HTMLInputElement>('searchInput').value = '';
    void openSearch();
  });
  $('searchInput').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  });
  $('searchFilters').addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-search-kind]');
    if (!chip) return;
    filter = chip.dataset.searchKind as SearchKind | 'all';
    paint();
  });
  $('searchResults').addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const more = target.closest<HTMLElement>('[data-search-more]')?.dataset.searchMore as SearchKind | undefined;
    if (more) {
      shown.set(more, (shown.get(more) || PAGE) + PAGE);
      paint();
      return;
    }
    const row = target.closest<HTMLElement>('[data-search-hit]');
    const hit = row && hits[Number(row.dataset.searchHit)];
    if (!hit) return;
    dialog.close();
    returning = true;
    await deps.open(hit.doc);
  });

  // «close» no se propaga: se escucha en captura. Se vuelve solo si no quedó otra ventana abierta.
  document.addEventListener(
    'close',
    (event) => {
      if (!returning || event.target === dialog) return;
      setTimeout(() => {
        if (!returning || document.querySelector('dialog[open]')) return;
        returning = false;
        void openSearch();
      }, 0);
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    $('searchOpen').click();
  });
}

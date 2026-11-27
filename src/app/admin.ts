import { showConfirmDialog } from './dialogs';
import {
  buildSafeAppContext,
  deleteFeedbackReport,
  fetchAdminSiteVisits,
  fetchAdminUserDirectory,
  fetchAllFeedbackReports,
  fetchMyFeedbackReports,
  submitFeedbackReport,
  syncAndFetchPersistentSiteStats,
  updateFeedbackReport,
} from '../feedback';
import { isFeedbackAdmin } from '../feedback-access';
import { getSyncState } from '../sync';
import { signInWithGoogle } from '../firebase';
import type {
  FeedbackItem,
  FeedbackKind,
  FeedbackStatus,
  PersistentSiteStatsSummary,
  SiteVisitStats,
  UserDirectoryEntry,
} from '../types';

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector(selector) as T | null;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string): T[] =>
  Array.from(document.querySelectorAll(selector)) as T[];
const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char),
  );
const statusNames: Record<string, string> = {
  pending: 'Pendiente',
  reading: 'En lectura',
  paused: 'Pausado',
  finished: 'Terminado',
};

function isInAppBrowser(): boolean {
  return /FBAN|FBAV|Instagram|WhatsApp|Telegram|Line\/|MicroMessenger/i.test(navigator.userAgent || '');
}

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
    const copied = document.execCommand('copy');
    box.remove();
    return copied;
  }
}

const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  bug: 'Error o falla',
  idea: 'Propuesta de cambio',
  other: 'Comentario',
};

const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: 'Pendiente',
  reviewed: 'En revisión',
  resolved: 'Resuelto',
  dismissed: 'Descartado',
};

let activeFeedbackKind: FeedbackKind = 'bug';
let inboxFeedbackItems: FeedbackItem[] = [];
let feedbackInboxFilter: 'all' | 'open' | 'bug' | 'idea' | 'resolved' = 'all';

function setFeedbackKind(kind: FeedbackKind) {
  activeFeedbackKind = kind;
  $$('#feedbackKindRow [data-feedback-kind]').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.feedbackKind === kind),
  );
  const textarea = $<HTMLTextAreaElement>('#feedbackMessage');
  if (textarea) {
    textarea.placeholder =
      kind === 'bug'
        ? 'Contanos qué estabas haciendo, qué pasó y si viste algún mensaje de error…'
        : kind === 'idea'
          ? '¿Qué función te gustaría sumar o qué parte de Librarium mejorarías?'
          : 'Dejanos tu comentario o duda sobre Librarium…';
  }
}

function syncFeedbackAuthUI() {
  const { user } = getSyncState();
  const signedIn = Boolean(user && user.emailVerified);
  $('#feedbackAuthNotice')?.classList.toggle('hidden', signedIn);
  const submitBtn = $<HTMLButtonElement>('#feedbackSubmitBtn');
  if (submitBtn) submitBtn.disabled = !signedIn;
}

function openFeedbackDialog(defaultKind: FeedbackKind = 'bug') {
  setFeedbackKind(defaultKind);
  const statusEl = $('#feedbackStatus');
  if (statusEl) statusEl.textContent = '';
  syncFeedbackAuthUI();
  $<HTMLDialogElement>('#feedbackDialog')?.showModal();
  void renderMyFeedbackList();
}

async function copyFeedbackAsText() {
  const statusEl = $('#feedbackStatus');
  const message = ($<HTMLTextAreaElement>('#feedbackMessage')?.value || '').trim();
  if (!message) {
    if (statusEl) statusEl.textContent = 'Escribí primero tu reporte o propuesta para poder copiarlo.';
    $<HTMLTextAreaElement>('#feedbackMessage')?.focus();
    return;
  }
  const includeTech = Boolean($<HTMLInputElement>('#feedbackIncludeTech')?.checked);
  const lines = [
    `[Librarium · ${FEEDBACK_KIND_LABELS[activeFeedbackKind]}]`,
    message,
  ];
  if (includeTech) lines.push(`Contexto: ${buildSafeAppContext()}`);
  const ok = await copyPlainText(lines.join('\n\n'));
  if (statusEl) {
    statusEl.textContent = ok
      ? 'Texto copiado al portapapeles. Ya podés pegarlo en el grupo.'
      : 'No se pudo copiar automáticamente; podés seleccionar el texto manualmente.';
  }
}

async function handleFeedbackSignIn() {
  const statusEl = $('#feedbackStatus');
  if (isInAppBrowser()) {
    if (statusEl) {
      statusEl.textContent =
        'Abriste Librarium desde un navegador interno (WhatsApp/Instagram). Abrila en Chrome o Safari desde ⋮ para iniciar sesión con Google, o usá «Copiar texto para grupo».';
    }
    return;
  }
  try {
    await signInWithGoogle();
    syncFeedbackAuthUI();
    if (statusEl) statusEl.textContent = 'Sesión iniciada. Ya podés enviar tu mensaje directo.';
    await renderMyFeedbackList();
  } catch (err: any) {
    if (statusEl) {
      statusEl.textContent =
        err?.code === 'auth/popup-closed-by-user'
          ? 'Se cerró la ventana de Google antes de completar el ingreso.'
          : `No se pudo iniciar sesión: ${err?.message || err}`;
    }
  }
}

async function handleFeedbackSubmit(e: Event) {
  e.preventDefault();
  const statusEl = $('#feedbackStatus');
  const submitBtn = $<HTMLButtonElement>('#feedbackSubmitBtn');
  const textarea = $<HTMLTextAreaElement>('#feedbackMessage');
  if (!textarea || !submitBtn) return;

  const message = textarea.value.trim();
  if (!message) {
    textarea.focus();
    return;
  }

  const includeTech = Boolean($<HTMLInputElement>('#feedbackIncludeTech')?.checked);
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent || 'Enviar';
  submitBtn.textContent = 'Enviando…';
  if (statusEl) statusEl.textContent = 'Enviando tu mensaje…';

  try {
    await submitFeedbackReport(activeFeedbackKind, message, includeTech);
    textarea.value = '';
    if (statusEl) statusEl.textContent = '¡Gracias! Tu mensaje quedó guardado para revisarlo pronto.';
    await renderMyFeedbackList();
    if (isFeedbackAdmin(getSyncState().user)) void refreshAdminFeedbackSummary();
  } catch (err: any) {
    if (statusEl) {
      statusEl.textContent =
        navigator.onLine === false
          ? 'Sin conexión. Podés usar «Copiar texto» o reintentar cuando vuelva internet.'
          : `No se pudo enviar: ${err?.message || 'error de conexión'}`;
    }
  } finally {
    submitBtn.textContent = originalLabel;
    syncFeedbackAuthUI();
  }
}

export async function renderMyFeedbackList() {
  const section = $('#myFeedbackSection');
  const host = $('#myFeedbackList');
  if (!section || !host) return;
  const { user } = getSyncState();
  if (!user || !user.emailVerified) {
    section.classList.add('hidden');
    host.replaceChildren();
    return;
  }
  try {
    const items = await fetchMyFeedbackReports();
    if (!items.length) {
      section.classList.add('hidden');
      host.replaceChildren();
      return;
    }
    section.classList.remove('hidden');
    host.innerHTML = items
      .map((item) => {
        const date = new Date(item.createdAt).toLocaleDateString('es-AR', {
          day: 'numeric',
          month: 'short',
        });
        return `<article class="feedback-card">
          <div class="feedback-card-head">
            <div class="feedback-badges">
              <span class="feedback-badge kind-${escapeHtml(item.kind)}">${escapeHtml(FEEDBACK_KIND_LABELS[item.kind])}</span>
              <span class="feedback-badge status-${escapeHtml(item.status)}">${escapeHtml(FEEDBACK_STATUS_LABELS[item.status])}</span>
            </div>
            <span class="feedback-meta">${escapeHtml(date)}</span>
          </div>
          <p class="feedback-body">${escapeHtml(item.message)}</p>
          ${item.adminNote ? `<p class="feedback-admin-reply"><strong>Respuesta:</strong> ${escapeHtml(item.adminNote)}</p>` : ''}
        </article>`;
      })
      .join('');
  } catch {
    section.classList.add('hidden');
  }
}

let lastBackgroundVisitArchiveAt = 0;

export function updateAdminPendingBadges(openCount: number) {
  const settingsBtn = $('#settingsOpen');
  const settingsBadge = $('#settingsOpenBadge');
  const inboxBadge = $('#inboxPendingBadge');
  const label = openCount > 99 ? '99+' : String(openCount);
  const show = openCount > 0;

  if (settingsBadge) {
    settingsBadge.textContent = show ? label : '';
    settingsBadge.classList.toggle('hidden', !show);
  }
  if (inboxBadge) {
    inboxBadge.textContent = show ? label : '';
    inboxBadge.classList.toggle('hidden', !show);
  }
  if (settingsBtn) {
    settingsBtn.setAttribute(
      'aria-label',
      show
        ? `Ajustes (${openCount} ${openCount === 1 ? 'reporte pendiente' : 'reportes pendientes'})`
        : 'Ajustes',
    );
  }
}

export async function archiveAdminSiteVisitsInBackground() {
  if (!isFeedbackAdmin(getSyncState().user)) return;
  if (Date.now() - lastBackgroundVisitArchiveAt < 2 * 60 * 1000) return;
  lastBackgroundVisitArchiveAt = Date.now();
  try {
    const serverVisits = await fetchAdminSiteVisits();
    if (serverVisits) await syncAndFetchPersistentSiteStats(serverVisits);
  } catch {
    // Non-critical background archival
  }
}

export async function refreshAdminFeedbackSummary() {
  const summaryEl = $('#adminFeedbackSummary');
  if (!isFeedbackAdmin(getSyncState().user)) {
    updateAdminPendingBadges(0);
    return;
  }
  try {
    const items = await fetchAllFeedbackReports();
    const openCount = items.filter((item) => item.status === 'open').length;
    updateAdminPendingBadges(openCount);
    if (summaryEl) {
      summaryEl.textContent = items.length
        ? `${openCount} ${openCount === 1 ? 'pendiente' : 'pendientes'} · ${items.length} ${items.length === 1 ? 'envío total' : 'envíos totales'}.`
        : 'Todavía no hay reportes ni propuestas.';
    }
  } catch {
    if (summaryEl) {
      summaryEl.textContent = 'Revisá los envíos de las personas que usan Librarium.';
    }
  }
}

async function openFeedbackInboxDialog() {
  const dlg = $<HTMLDialogElement>('#feedbackInboxDialog');
  if (!dlg || !isFeedbackAdmin(getSyncState().user)) return;
  if (!dlg.open) dlg.showModal();
  await loadFeedbackInbox();
}

async function loadFeedbackInbox() {
  const statusEl = $('#feedbackInboxStatus');
  const listEl = $('#feedbackInboxList');
  if (!listEl) return;
  if (statusEl) statusEl.textContent = 'Cargando envíos…';
  try {
    inboxFeedbackItems = await fetchAllFeedbackReports();
    renderFeedbackInboxList();
    void refreshAdminFeedbackSummary();
  } catch (err: any) {
    if (statusEl) statusEl.textContent = `No se pudieron cargar los reportes: ${err?.message || err}`;
    listEl.replaceChildren();
  }
}

function renderFeedbackInboxList() {
  const statusEl = $('#feedbackInboxStatus');
  const listEl = $('#feedbackInboxList');
  if (!listEl) return;

  const filtered = inboxFeedbackItems.filter((item) => {
    if (feedbackInboxFilter === 'all') return true;
    if (feedbackInboxFilter === 'open' || feedbackInboxFilter === 'resolved') {
      return item.status === feedbackInboxFilter;
    }
    return item.kind === feedbackInboxFilter;
  });

  if (statusEl) {
    const openCount = inboxFeedbackItems.filter((item) => item.status === 'open').length;
    statusEl.textContent = `${filtered.length} ${filtered.length === 1 ? 'elemento mostrado' : 'elementos mostrados'} (${openCount} ${openCount === 1 ? 'pendiente' : 'pendientes'} en total).`;
  }

  if (!filtered.length) {
    listEl.innerHTML = '<p class="empty-inline">No hay reportes en esta vista.</p>';
    return;
  }

  listEl.innerHTML = filtered
    .map((item) => {
      const date = new Date(item.createdAt).toLocaleString('es-AR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `<article class="feedback-card" data-inbox-id="${escapeHtml(item.id)}">
        <div class="feedback-card-head">
          <div class="feedback-badges">
            <span class="feedback-badge kind-${escapeHtml(item.kind)}">${escapeHtml(FEEDBACK_KIND_LABELS[item.kind])}</span>
            <span class="feedback-badge status-${escapeHtml(item.status)}">${escapeHtml(FEEDBACK_STATUS_LABELS[item.status])}</span>
          </div>
          <span class="feedback-meta">${escapeHtml(date)}</span>
        </div>
        <div class="feedback-meta"><strong>${escapeHtml(item.authorName)}</strong>${item.authorEmail ? ` · ${escapeHtml(item.authorEmail)}` : ''}</div>
        <p class="feedback-body">${escapeHtml(item.message)}</p>
        ${item.appContext ? `<p class="feedback-tech">${escapeHtml(item.appContext)}</p>` : ''}
        <div class="feedback-admin-controls">
          <div class="feedback-admin-row">
            <select data-inbox-status aria-label="Estado del reporte">
              <option value="open" ${item.status === 'open' ? 'selected' : ''}>Pendiente</option>
              <option value="reviewed" ${item.status === 'reviewed' ? 'selected' : ''}>En revisión</option>
              <option value="resolved" ${item.status === 'resolved' ? 'selected' : ''}>Resuelto</option>
              <option value="dismissed" ${item.status === 'dismissed' ? 'selected' : ''}>Descartado</option>
            </select>
            <input type="text" data-inbox-note maxlength="1000" value="${escapeHtml(item.adminNote)}" placeholder="Nota o respuesta opcional visible para quien lo envió…">
          </div>
          <div class="feedback-admin-actions">
            <button type="button" class="danger-btn" data-inbox-delete="${escapeHtml(item.id)}">Eliminar</button>
            <button type="button" class="secondary" data-inbox-save="${escapeHtml(item.id)}">Guardar</button>
          </div>
        </div>
      </article>`;
    })
    .join('');

  listEl.querySelectorAll<HTMLButtonElement>('[data-inbox-save]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.inboxSave!;
      const cardEl = btn.closest<HTMLElement>('[data-inbox-id]');
      const statusSelect = cardEl?.querySelector<HTMLSelectElement>('[data-inbox-status]');
      const noteInput = cardEl?.querySelector<HTMLInputElement>('[data-inbox-note]');
      if (!statusSelect || !noteInput) return;
      const nextStatus = statusSelect.value as FeedbackStatus;
      const nextNote = noteInput.value;
      btn.disabled = true;
      btn.textContent = 'Guardando…';
      try {
        await updateFeedbackReport(id, nextStatus, nextNote);
        const target = inboxFeedbackItems.find((x) => x.id === id);
        if (target) {
          target.status = nextStatus;
          target.adminNote = nextNote.trim();
        }
        renderFeedbackInboxList();
        void refreshAdminFeedbackSummary();
      } catch (err: any) {
        if (statusEl) statusEl.textContent = `No se pudo actualizar: ${err?.message || err}`;
        btn.disabled = false;
        btn.textContent = 'Guardar';
      }
    };
  });

  listEl.querySelectorAll<HTMLButtonElement>('[data-inbox-delete]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.inboxDelete!;
      const ok = await showConfirmDialog({
        eyebrow: 'BUZÓN DE REPORTES',
        title: '¿Eliminar este reporte?',
        message: 'Se borrará de Firestore de forma permanente.',
        confirmLabel: 'Eliminar',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        await deleteFeedbackReport(id);
        inboxFeedbackItems = inboxFeedbackItems.filter((x) => x.id !== id);
        renderFeedbackInboxList();
        void refreshAdminFeedbackSummary();
      } catch (err: any) {
        if (statusEl) statusEl.textContent = `No se pudo eliminar: ${err?.message || err}`;
        btn.disabled = false;
      }
    };
  });
}

let usersDirectoryItems: UserDirectoryEntry[] = [];
let siteVisitStats: SiteVisitStats | null = null;
let persistentAnonStats: PersistentSiteStatsSummary = { totalAnonAllTime: 0, byDate: {} };
let usersDirectoryFilter: 'all' | 'active' | 'today' | 'reading' = 'all';

function isUserOnlineNow(iso: string): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms <= 5 * 60 * 1000;
}

function isSameLocalDay(iso: string): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function formatLastSeen(iso: string): string {
  if (!iso) return 'Sin actividad reciente';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'Sin actividad reciente';
  const diffMin = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (diffMin <= 5) return 'Activo ahora';
  if (diffMin < 60) return `Última vez hace ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Última vez hace ${diffHours} h`;
  return `Última vez: ${new Date(ms).toLocaleString('es-AR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function formatShortDate(iso: string): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleDateString('es-AR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

async function openUsersDirectoryDialog() {
  const dlg = $<HTMLDialogElement>('#usersDirectoryDialog');
  if (!dlg || !isFeedbackAdmin(getSyncState().user)) return;
  if (!dlg.open) dlg.showModal();
  await loadUsersDirectory();
}

async function loadUsersDirectory() {
  const statusEl = $('#usersDirectoryStatus');
  const listEl = $('#usersDirectoryList');
  if (!listEl) return;
  if (statusEl) statusEl.textContent = 'Cargando usuarios, visitas y lecturas…';
  try {
    const [users, visits] = await Promise.all([
      fetchAdminUserDirectory(),
      fetchAdminSiteVisits(),
    ]);
    usersDirectoryItems = users;
    siteVisitStats = visits;
    persistentAnonStats = await syncAndFetchPersistentSiteStats(visits);
    lastBackgroundVisitArchiveAt = Date.now();
    renderUsersDirectory();
  } catch (err: any) {
    if (statusEl) statusEl.textContent = `No se pudieron cargar los usuarios: ${err?.message || err}`;
    listEl.replaceChildren();
  }
}

function getLast7UtcDays(): string[] {
  const days: string[] = [];
  const now = Date.now();
  for (let i = 0; i < 7; i++) {
    days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  }
  return days;
}

function formatDayChip(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) return 'Hoy';
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3) return dateStr;
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
  return dt.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
}

function renderUsersVisitsSummary() {
  const host = $('#usersVisitsSummary');
  if (!host) return;
  const totalUserVisits = usersDirectoryItems.reduce(
    (acc, u) => acc + (u.visitCount > 0 ? u.visitCount : 1),
    0,
  );
  const usersToday = usersDirectoryItems.filter((u) => isSameLocalDay(u.lastActiveAt)).length;
  const activeNow = usersDirectoryItems.filter((u) => isUserOnlineNow(u.lastActiveAt)).length;
  const todayKey = new Date().toISOString().slice(0, 10);
  const anonAllTime = Math.max(
    persistentAnonStats.totalAnonAllTime,
    siteVisitStats?.anonVisits || 0,
  );
  const anonToday = Math.max(
    persistentAnonStats.byDate[todayKey] || 0,
    siteVisitStats?.todayAnonVisits || 0,
  );
  const combinedTotal = totalUserVisits + anonAllTime;

  const cards: string[] = [
    `<div class="users-visit-stat">
      <span class="users-visit-stat-label">Visitas de cuentas (nube)</span>
      <strong>${totalUserVisits}</strong>
      <span class="users-visit-sub">${usersDirectoryItems.length} ${usersDirectoryItems.length === 1 ? 'cuenta' : 'cuentas'} · ${usersToday} hoy · ${activeNow} ahora</span>
    </div>`,
    `<div class="users-visit-stat">
      <span class="users-visit-stat-label">Sin cuenta (histórico nube)</span>
      <strong>${anonAllTime}</strong>
      <span class="users-visit-sub">Hoy: ${anonToday}${siteVisitStats ? ` · Servidor actual: ${siteVisitStats.anonVisits}` : ''}</span>
    </div>`,
    `<div class="users-visit-stat">
      <span class="users-visit-stat-label">Total histórico combinado</span>
      <strong>${combinedTotal}</strong>
      <span class="users-visit-sub">Cuentas registradas + visitantes anónimos archivados</span>
    </div>`,
  ];

  host.innerHTML = cards.join('');
  host.classList.remove('hidden');

  const dailyHost = $('#usersDailyBreakdown');
  if (!dailyHost) return;
  const days = getLast7UtcDays();
  const rowsData = days.map((date) => {
    const authUsers = usersDirectoryItems.filter((u) =>
      u.visitDays.includes(date) || u.lastActiveAt.slice(0, 10) === date,
    ).length;
    const anonVisits = persistentAnonStats.byDate[date] || 0;
    return { date, authUsers, anonVisits, total: authUsers + anonVisits };
  });
  const maxDayTotal = Math.max(1, ...rowsData.map((r) => r.total));

  dailyHost.innerHTML = `
    <div class="users-daily-head">
      <p class="eyebrow">HISTÓRICO ÚLTIMOS 7 DÍAS (PERSISTENTE EN NUBE)</p>
      <span class="users-daily-sub">Verde: cuentas · Marrón: sin cuenta</span>
    </div>
    <div class="users-daily-rows">
      ${rowsData
        .map((r) => {
          const authPct = Math.round((r.authUsers / maxDayTotal) * 100);
          const anonPct = Math.round((r.anonVisits / maxDayTotal) * 100);
          return `<div class="users-daily-row">
            <span class="users-daily-date">${escapeHtml(formatDayChip(r.date))}</span>
            <div class="users-daily-bar" aria-hidden="true">
              <i class="users-daily-seg-auth" style="width:${authPct}%"></i>
              <i class="users-daily-seg-anon" style="width:${anonPct}%"></i>
            </div>
            <span class="users-daily-counts">${r.authUsers} ctas · ${r.anonVisits} anón.</span>
          </div>`;
        })
        .join('')}
    </div>`;
  dailyHost.classList.remove('hidden');
}

function renderUsersDirectory() {
  const statusEl = $('#usersDirectoryStatus');
  const listEl = $('#usersDirectoryList');
  if (!listEl) return;

  renderUsersVisitsSummary();

  const q = ($<HTMLInputElement>('#usersDirectorySearch')?.value || '').trim().toLowerCase();
  const filtered = usersDirectoryItems.filter((u) => {
    if (usersDirectoryFilter === 'active' && !isUserOnlineNow(u.lastActiveAt)) return false;
    if (usersDirectoryFilter === 'today' && !isSameLocalDay(u.lastActiveAt)) return false;
    if (
      usersDirectoryFilter === 'reading' &&
      !u.bookSummaries.some((b) => b.status === 'reading')
    ) {
      return false;
    }
    if (!q) return true;
    const hay = [
      u.displayName,
      u.email,
      ...u.bookSummaries.map((b) => `${b.title} ${b.author}`),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  if (statusEl) {
    const totalBooks = usersDirectoryItems.reduce(
      (acc, u) => acc + Math.max(u.booksCount, u.bookSummaries.length),
      0,
    );
    statusEl.textContent = `Mostrando ${filtered.length} de ${usersDirectoryItems.length} ${usersDirectoryItems.length === 1 ? 'usuario' : 'usuarios'} · ${totalBooks} ${totalBooks === 1 ? 'libro registrado' : 'libros registrados'}.`;
  }

  if (!filtered.length) {
    listEl.innerHTML = '<p class="empty-inline">No hay usuarios que coincidan con este filtro.</p>';
    return;
  }

  listEl.innerHTML = filtered
    .map((u) => {
      const online = isUserOnlineNow(u.lastActiveAt);
      const presenceLabel = formatLastSeen(u.lastActiveAt);
      const initial = (u.displayName || u.email || 'L').trim().charAt(0).toUpperCase() || 'L';
      const avatarHtml = u.photoURL
        ? `<img class="user-dir-avatar" src="${escapeHtml(u.photoURL)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<span class="user-dir-avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`;

      const visitsLabel =
        u.visitCount > 0
          ? `<strong>${u.visitCount}</strong> ${u.visitCount === 1 ? 'visita' : 'visitas'}`
          : '<strong>1+</strong> visitas';
      const bookCount = Math.max(u.booksCount, u.bookSummaries.length);
      const readingCount = u.bookSummaries.filter((b) => b.status === 'reading').length;
      const finishedCount = u.bookSummaries.filter((b) => b.status === 'finished').length;

      const booksHtml = u.bookSummaries.length
        ? `<div class="user-books-list">
            ${u.bookSummaries
              .map((b) => {
                const pct = Math.max(0, Math.min(100, Math.round(b.percent || 0)));
                const pagesText =
                  b.totalPages > 0 ? ` · ${b.currentPage}/${b.totalPages} p.` : '';
                return `<div class="user-book-row">
                  <div class="user-book-head">
                    <div class="user-book-title-wrap">
                      <span class="user-book-title">${escapeHtml(b.title)}</span>
                      ${b.author ? `<span class="user-book-author">${escapeHtml(b.author)}</span>` : ''}
                    </div>
                    <div class="user-book-progress-meta">
                      <span class="user-book-status status-${escapeHtml(b.status)}">${escapeHtml(statusNames[b.status] || b.status)}</span>
                      <span class="user-book-pct">${pct}%${escapeHtml(pagesText)}</span>
                    </div>
                  </div>
                  <div class="user-book-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
                </div>`;
              })
              .join('')}
          </div>`
        : `<p class="empty-inline">Todavía no sincronizó libros o aún no abrió la app después de esta actualización.</p>`;

      return `<article class="user-dir-card">
        <div class="user-dir-head">
          <div class="user-dir-identity">
            ${avatarHtml}
            <div class="user-dir-who">
              <span class="user-dir-name">${escapeHtml(u.displayName || 'Lector')}</span>
              ${u.email ? `<span class="user-dir-email">${escapeHtml(u.email)}</span>` : ''}
            </div>
          </div>
          <div class="user-dir-meta">
            <span class="user-presence ${online ? 'online' : 'offline'}">
              <span class="user-presence-dot" aria-hidden="true"></span>
              ${escapeHtml(presenceLabel)}
            </span>
            <span>Alta: ${escapeHtml(formatShortDate(u.createdAt))}</span>
          </div>
        </div>
        <div class="user-dir-stats">
          <span>${visitsLabel}</span>
          <span><strong>${bookCount}</strong> ${bookCount === 1 ? 'libro' : 'libros'}</span>
          <span><strong>${readingCount}</strong> en lectura</span>
          <span><strong>${finishedCount}</strong> ${finishedCount === 1 ? 'terminado' : 'terminados'}</span>
        </div>
        ${booksHtml}
      </article>`;
    })
    .join('');
}


export function initAdminFeatures() {
  $('#footerFeedbackBtn')?.addEventListener('click', () => openFeedbackDialog('bug'));
  $('#openFeedbackBtn')?.addEventListener('click', () => openFeedbackDialog('bug'));
  $('#openFeedbackInboxBtn')?.addEventListener('click', () => void openFeedbackInboxDialog());
  $('#openUsersDirectoryBtn')?.addEventListener('click', () => void openUsersDirectoryDialog());
  $('#refreshFeedbackInboxBtn')?.addEventListener('click', () => void loadFeedbackInbox());
  $('#refreshUsersDirectoryBtn')?.addEventListener('click', () => void loadUsersDirectory());
  $('#usersDirectorySearch')?.addEventListener('input', renderUsersDirectory);
  $('#usersDirectoryFilters')?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-users-filter]');
    if (!button) return;
    usersDirectoryFilter = (button.dataset.usersFilter as typeof usersDirectoryFilter) || 'all';
    $$('#usersDirectoryFilters [data-users-filter]').forEach((item) =>
      item.classList.toggle('active', item === button),
    );
    renderUsersDirectory();
  });
  $('#feedbackKindRow')?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-feedback-kind]');
    if (button) setFeedbackKind((button.dataset.feedbackKind as FeedbackKind) || 'bug');
  });
  $('#feedbackInboxFilters')?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-inbox-filter]');
    if (!button) return;
    feedbackInboxFilter = (button.dataset.inboxFilter as typeof feedbackInboxFilter) || 'all';
    $$('#feedbackInboxFilters [data-inbox-filter]').forEach((item) =>
      item.classList.toggle('active', item === button),
    );
    renderFeedbackInboxList();
  });
  $('#feedbackSignInBtn')?.addEventListener('click', () => void handleFeedbackSignIn());
  $('#feedbackCopyBtn')?.addEventListener('click', () => void copyFeedbackAsText());
  $('#feedbackCopyFallbackBtn')?.addEventListener('click', () => void copyFeedbackAsText());
  $('#feedbackForm')?.addEventListener('submit', (event) => void handleFeedbackSubmit(event));
}


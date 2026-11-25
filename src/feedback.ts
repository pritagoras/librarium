import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { sanitizeId } from './sync';
import type {
  BookProgressSummary,
  BookStatus,
  FeedbackItem,
  FeedbackKind,
  FeedbackStatus,
  PersistentSiteStatsSummary,
  SiteVisitStats,
  UserDirectoryEntry,
} from './types';

export const FEEDBACK_ADMIN_EMAIL = '[redacted]';
const APP_CLIENT_VERSION = 'v42';

export function isFeedbackAdmin(user: User | null | undefined): boolean {
  return Boolean(
    user &&
      user.emailVerified &&
      user.email?.trim().toLowerCase() === FEEDBACK_ADMIN_EMAIL,
  );
}

function toIso(value: unknown): string {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof value === 'string' && value) return value;
  return new Date().toISOString();
}

function mapDoc(id: string, data: Record<string, unknown>): FeedbackItem {
  const kind = data.kind;
  const status = data.status;
  return {
    id,
    userId: String(data.userId || ''),
    authorName: String(data.authorName || 'Usuario'),
    authorEmail: String(data.authorEmail || ''),
    kind: kind === 'bug' || kind === 'idea' || kind === 'other' ? kind : 'other',
    message: String(data.message || ''),
    appContext: String(data.appContext || ''),
    status:
      status === 'open' || status === 'reviewed' || status === 'resolved' || status === 'dismissed'
        ? status
        : 'open',
    adminNote: String(data.adminNote || ''),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
  };
}

export function buildSafeAppContext(): string {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((window.navigator as { standalone?: boolean }).standalone);
  const mode = standalone ? 'App instalada' : 'Navegador';
  const theme = document.documentElement.dataset.theme === 'dark' ? 'Oscuro' : 'Claro';
  const viewport = `${window.innerWidth}x${window.innerHeight}`;
  const online = navigator.onLine === false ? 'Offline' : 'Online';
  const ua = navigator.userAgent || '';
  const browser = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac/i.test(ua)
          ? 'Mac'
          : 'Web';
  return `${APP_CLIENT_VERSION} · ${mode} · ${browser} · ${viewport} · ${theme} · ${online}`.slice(0, 300);
}

export async function submitFeedbackReport(
  kind: FeedbackKind,
  rawMessage: string,
  includeTechInfo: boolean,
): Promise<FeedbackItem> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Iniciá sesión con Google para enviar tu reporte desde la app.');
  }
  if (!user.emailVerified) {
    throw new Error('Tu cuenta de Google necesita tener el correo verificado.');
  }

  const message = rawMessage.trim().slice(0, 2000);
  if (!message) {
    throw new Error('Escribí un mensaje antes de enviar.');
  }

  const id = sanitizeId(
    `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  );
  const authorName = (user.displayName || user.email || 'Lector').trim().slice(0, 120);
  const authorEmail = (user.email || '').trim().slice(0, 254);
  const appContext = includeTechInfo ? buildSafeAppContext() : '';
  const path = `feedback/${id}`;

  try {
    await setDoc(doc(db, 'feedback', id), {
      id,
      userId: user.uid,
      authorName,
      authorEmail,
      kind,
      message,
      appContext,
      status: 'open',
      adminNote: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }

  const now = new Date().toISOString();
  return {
    id,
    userId: user.uid,
    authorName,
    authorEmail,
    kind,
    message,
    appContext,
    status: 'open',
    adminNote: '',
    createdAt: now,
    updatedAt: now,
  };
}

export async function fetchMyFeedbackReports(): Promise<FeedbackItem[]> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return [];

  try {
    const snap = await getDocs(
      query(collection(db, 'feedback'), where('userId', '==', user.uid)),
    );
    return snap.docs
      .map((d) => mapDoc(d.id, d.data() as Record<string, unknown>))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'feedback');
  }
}

export async function fetchAllFeedbackReports(): Promise<FeedbackItem[]> {
  const user = auth.currentUser;
  if (!isFeedbackAdmin(user)) {
    throw new Error('Acceso restringido al administrador de Librarium.');
  }

  try {
    const snap = await getDocs(collection(db, 'feedback'));
    return snap.docs
      .map((d) => mapDoc(d.id, d.data() as Record<string, unknown>))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'feedback');
  }
}

export async function updateFeedbackReport(
  id: string,
  status: FeedbackStatus,
  adminNote: string,
): Promise<void> {
  const user = auth.currentUser;
  if (!isFeedbackAdmin(user)) {
    throw new Error('Acceso restringido al administrador de Librarium.');
  }
  const cleanId = sanitizeId(id);
  const path = `feedback/${cleanId}`;
  try {
    await updateDoc(doc(db, 'feedback', cleanId), {
      status,
      adminNote: adminNote.trim().slice(0, 1000),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFeedbackReport(id: string): Promise<void> {
  const user = auth.currentUser;
  if (!isFeedbackAdmin(user)) {
    throw new Error('Acceso restringido al administrador de Librarium.');
  }
  const cleanId = sanitizeId(id);
  const path = `feedback/${cleanId}`;
  try {
    await deleteDoc(doc(db, 'feedback', cleanId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

const VALID_BOOK_STATUSES: BookStatus[] = ['pending', 'reading', 'paused', 'finished'];

function mapBookSummary(raw: unknown): BookProgressSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const status = VALID_BOOK_STATUSES.includes(obj.status as BookStatus)
    ? (obj.status as BookStatus)
    : 'pending';
  const totalPages = Math.max(0, Math.floor(Number(obj.totalPages) || 0));
  const currentPage = Math.max(0, Math.floor(Number(obj.currentPage) || 0));
  const rawPct = Number(obj.percent);
  const percent = Number.isFinite(rawPct)
    ? Math.min(100, Math.max(0, Math.round(rawPct)))
    : totalPages > 0
      ? Math.min(100, Math.round((currentPage / totalPages) * 100))
      : status === 'finished'
        ? 100
        : 0;
  return {
    id: String(obj.id || ''),
    title: String(obj.title || 'Sin título'),
    author: String(obj.author || ''),
    status,
    percent,
    currentPage,
    totalPages,
  };
}

export async function fetchAdminUserDirectory(): Promise<UserDirectoryEntry[]> {
  const user = auth.currentUser;
  if (!isFeedbackAdmin(user)) {
    throw new Error('Acceso restringido al administrador de Librarium.');
  }
  try {
    const snap = await getDocs(collection(db, 'users'));
    return snap.docs
      .map((d) => {
        const data = d.data() as Record<string, unknown>;
        const rawSummaries = Array.isArray(data.bookSummaries) ? data.bookSummaries : [];
        const bookSummaries = rawSummaries
          .map(mapBookSummary)
          .filter((item): item is BookProgressSummary => item !== null);
        const updatedAt = toIso(data.updatedAt);
        const lastActiveAt = data.lastActiveAt ? toIso(data.lastActiveAt) : updatedAt;
        return {
          uid: d.id,
          displayName: String(data.displayName || 'Usuario'),
          email: String(data.email || ''),
          photoURL: typeof data.photoURL === 'string' && data.photoURL ? data.photoURL : null,
          createdAt: toIso(data.createdAt),
          updatedAt,
          lastActiveAt,
          visitCount:
            typeof data.visitCount === 'number' && data.visitCount >= 1
              ? Math.floor(data.visitCount)
              : 0,
          visitDays: Array.isArray(data.visitDays)
            ? data.visitDays
                .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
                .slice(-30)
            : [],
          booksCount:
            typeof data.booksCount === 'number' && data.booksCount >= 0
              ? Math.floor(data.booksCount)
              : bookSummaries.length,
          bookSummaries,
        };
      })
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'users');
  }
}

export async function fetchAdminSiteVisits(): Promise<SiteVisitStats | null> {
  const user = auth.currentUser;
  if (!isFeedbackAdmin(user) || !user) return null;
  try {
    const idToken = await user.getIdToken();
    const resp = await fetch('/api/visits', {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as SiteVisitStats;
  } catch {
    return null;
  }
}

export async function syncAndFetchPersistentSiteStats(
  serverStats: SiteVisitStats | null,
): Promise<PersistentSiteStatsSummary> {
  const user = auth.currentUser;
  if (!isFeedbackAdmin(user)) {
    return { totalAnonAllTime: 0, byDate: {} };
  }

  const cloudByDate = new Map<string, { anonBoots: Record<string, number>; anonTotal: number }>();
  try {
    const snap = await getDocs(collection(db, 'site_stats'));
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const rawBoots = data.anonBoots && typeof data.anonBoots === 'object' ? (data.anonBoots as Record<string, unknown>) : {};
      const anonBoots: Record<string, number> = {};
      for (const [k, v] of Object.entries(rawBoots)) {
        const n = Math.floor(Number(v) || 0);
        if (n > 0) anonBoots[k] = n;
      }
      const anonTotal = Math.max(
        0,
        Math.floor(Number(data.anonTotal) || Object.values(anonBoots).reduce((a, b) => a + b, 0)),
      );
      cloudByDate.set(d.id, { anonBoots, anonTotal });
    }
  } catch (err) {
    console.warn('No se pudo leer site_stats:', err);
    return { totalAnonAllTime: 0, byDate: {} };
  }

  if (serverStats && /^[a-zA-Z0-9_-]{3,40}$/.test(serverStats.bootId)) {
    for (const day of serverStats.recentDays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || day.anon <= 0) continue;
      const existing = cloudByDate.get(day.date);
      const currentBootCount = existing?.anonBoots[serverStats.bootId] || 0;
      const nextBootCount = Math.max(0, Math.floor(day.anon));
      if (nextBootCount <= currentBootCount) continue;

      const nextBoots: Record<string, number> = {
        ...(existing?.anonBoots || {}),
        [serverStats.bootId]: nextBootCount,
      };
      const bootKeys = Object.keys(nextBoots);
      if (bootKeys.length > 95) {
        const sorted = bootKeys.sort();
        for (const dropKey of sorted.slice(0, sorted.length - 95)) {
          delete nextBoots[dropKey];
        }
      }
      const nextTotal = Object.values(nextBoots).reduce((a, b) => a + b, 0);
      try {
        if (!existing) {
          await setDoc(doc(db, 'site_stats', day.date), {
            date: day.date,
            anonBoots: nextBoots,
            anonTotal: nextTotal,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(doc(db, 'site_stats', day.date), {
            anonBoots: nextBoots,
            anonTotal: nextTotal,
            updatedAt: serverTimestamp(),
          });
        }
        cloudByDate.set(day.date, { anonBoots: nextBoots, anonTotal: nextTotal });
      } catch (err) {
        console.warn('No se pudo archivar site_stats para', day.date, err);
      }
    }
  }

  const byDate: Record<string, number> = {};
  let totalAnonAllTime = 0;
  for (const [date, entry] of cloudByDate.entries()) {
    byDate[date] = entry.anonTotal;
    totalAnonAllTime += entry.anonTotal;
  }
  return { totalAnonAllTime, byDate };
}

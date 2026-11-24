import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  increment,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
  testConnection,
} from './firebase';
import { all, clearAllStores, del, get, put, type StoreName } from './db';
import type {
  Book,
  BookAnalysis,
  BookProgressSummary,
  Conversation,
  Entry,
  MediaItem,
  Note,
  Quote,
  SyncStatus,
} from './types';

const LAST_UID_KEY = 'librarium-last-uid';

const cloudIds: Record<StoreName, Set<string>> = {
  books: new Set(),
  notes: new Set(),
  entries: new Set(),
  quotes: new Set(),
  analyses: new Set(),
  conversations: new Set(),
  media: new Set(),
};

let unsubscribers: Unsubscribe[] = [];
let currentUser: User | null = null;
let syncStatus: SyncStatus = 'local';
let syncMessage = 'Guardado localmente en este dispositivo.';
let onDataChangedCb: (() => void) | null = null;
let onSyncStateCb: ((status: SyncStatus, message: string, user: User | null) => void) | null = null;

function setSyncState(status: SyncStatus, message: string) {
  syncStatus = status;
  syncMessage = message;
  onSyncStateCb?.(status, message, currentUser);
}

export function getSyncState() {
  return { status: syncStatus, message: syncMessage, user: currentUser };
}

export function sanitizeId(raw: string): string {
  const cleaned = String(raw || '')
    .replace(/:/g, '__')
    .replace(/[^a-zA-Z0-9_\-]/g, '_');
  return cleaned.slice(0, 128) || `id_${Date.now().toString(36)}`;
}

function toIso(value: unknown, fallback?: string): string {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value && typeof (value as any).toDate === 'function') {
    return (value as any).toDate().toISOString();
  }
  if (typeof value === 'string' && value) return value;
  return fallback || new Date().toISOString();
}

export async function compressDataUrlForCloud(dataUrl: string): Promise<string> {
  if (!dataUrl.startsWith('data:image/')) return dataUrl;
  if (dataUrl.length <= 650000) return dataUrl;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let maxDim = 1280;
      let quality = 0.78;
      let result = dataUrl;
      for (let attempt = 0; attempt < 5; attempt++) {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          result = canvas.toDataURL('image/jpeg', quality);
        }
        if (result.length <= 680000) break;
        maxDim = Math.round(maxDim * 0.78);
        quality = Math.max(0.48, quality - 0.1);
      }
      resolve(result);
    };
    img.onerror = () => resolve(dataUrl.slice(0, 680000));
    img.src = dataUrl;
  });
}

async function ensureMediaUploaded(uid: string, dataUrl: string, existingMediaId?: string | null): Promise<string> {
  const mediaId = sanitizeId(existingMediaId || `media_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const compressed = await compressDataUrlForCloud(dataUrl);
  const mimeMatch = compressed.match(/^data:(.*?);base64,/);
  const mimeType = mimeMatch?.[1] || 'image/jpeg';

  const mediaItem: MediaItem = {
    id: mediaId,
    userId: uid,
    mimeType,
    dataUrl: compressed,
    createdAt: new Date().toISOString(),
  };
  await put('media', mediaItem);

  if (!cloudIds.media.has(mediaId)) {
    const path = `users/${uid}/media/${mediaId}`;
    try {
      await setDoc(doc(db, 'users', uid, 'media', mediaId), {
        id: mediaId,
        userId: uid,
        mimeType: mimeType.slice(0, 64),
        dataUrl: compressed.slice(0, 740000),
        createdAt: serverTimestamp(),
      });
      cloudIds.media.add(mediaId);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  return mediaId;
}

async function hydrateBookFromLocalMedia(book: Book): Promise<Book> {
  if (!book.cover && book.coverMediaId) {
    const media = await get<MediaItem>('media', book.coverMediaId);
    if (media?.dataUrl) return { ...book, cover: media.dataUrl };
  }
  if (!book.cover && book.coverUrl) {
    return { ...book, cover: book.coverUrl };
  }
  return book;
}

async function hydrateEntryFromLocalMedia(entry: Entry): Promise<Entry> {
  if (!entry.photo && entry.photoMediaId) {
    const media = await get<MediaItem>('media', entry.photoMediaId);
    if (media?.dataUrl) return { ...entry, photo: media.dataUrl };
  }
  return entry;
}

async function hydrateQuoteFromLocalMedia(quote: Quote): Promise<Quote> {
  if ((!quote.photos || !quote.photos.length) && Array.isArray(quote.photoMediaIds) && quote.photoMediaIds.length) {
    const photos: string[] = [];
    for (const mid of quote.photoMediaIds) {
      const media = await get<MediaItem>('media', mid);
      if (media?.dataUrl) photos.push(media.dataUrl);
    }
    return { ...quote, photos };
  }
  return quote;
}

let summarySyncTimer: ReturnType<typeof setTimeout> | null = null;
let presenceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPresenceTouchAt = 0;
let lastHiddenAt = 0;
let fallbackSiteSessionId = '';

const VISIT_COOLDOWN_MS = 15 * 60 * 1000;
const PWA_RESUME_VISIT_MS = 30 * 60 * 1000;

function getSiteVisitSessionId(): string {
  const key = 'librarium-site-visit-sid';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) return existing;
    const created = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    if (!fallbackSiteSessionId) {
      fallbackSiteSessionId = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
    return fallbackSiteSessionId;
  }
}

export async function reportSiteVisit(authenticated: boolean): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await fetch('/api/visits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: getSiteVisitSessionId(),
        authenticated,
      }),
      keepalive: true,
    });
  } catch {
    // Ignore offline/network errors
  }
}

function shouldCountUserVisit(uid: string): boolean {
  try {
    if (sessionStorage.getItem(`librarium-visited-${uid}`) === '1') return false;
    const lastMs = Number(localStorage.getItem(`librarium-last-visit-${uid}`) || 0);
    if (Number.isFinite(lastMs) && Date.now() - lastMs < VISIT_COOLDOWN_MS) {
      sessionStorage.setItem(`librarium-visited-${uid}`, '1');
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function markUserVisitCounted(uid: string) {
  try {
    sessionStorage.setItem(`librarium-visited-${uid}`, '1');
    localStorage.setItem(`librarium-last-visit-${uid}`, String(Date.now()));
  } catch {
    // Ignore storage errors
  }
}

function stopListeners() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  (Object.keys(cloudIds) as StoreName[]).forEach((k) => cloudIds[k].clear());
}

function stopPresenceTracking() {
  if (summarySyncTimer) {
    clearTimeout(summarySyncTimer);
    summarySyncTimer = null;
  }
  if (presenceHeartbeatTimer) {
    clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = null;
  }
}

async function buildBookSummariesPayload(): Promise<{
  booksCount: number;
  bookSummaries: BookProgressSummary[];
}> {
  const localBooks = await all<Book>('books');
  const statusWeight: Record<Book['status'], number> = {
    reading: 0,
    paused: 1,
    pending: 2,
    finished: 3,
  };
  const ordered = [...localBooks].sort((a, b) => {
    const sw = (statusWeight[a.status] ?? 9) - (statusWeight[b.status] ?? 9);
    if (sw !== 0) return sw;
    return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
  });
  const bookSummaries: BookProgressSummary[] = ordered.slice(0, 100).map((b) => {
    const totalPages = Math.max(0, Math.floor(Number(b.totalPages) || 0));
    const currentPage = Math.max(0, Math.floor(Number(b.currentPage) || 0));
    const percent =
      b.status === 'finished' && totalPages === 0
        ? 100
        : totalPages > 0
          ? Math.min(100, Math.round((currentPage / totalPages) * 100))
          : 0;
    return {
      id: sanitizeId(b.id),
      title: String(b.title || 'Sin título').slice(0, 140),
      author: String(b.author || '').slice(0, 100),
      status: b.status || 'pending',
      percent,
      currentPage,
      totalPages,
    };
  });
  return { booksCount: localBooks.length, bookSummaries };
}

export async function syncUserReadingSummary(): Promise<void> {
  if (!currentUser || !currentUser.emailVerified) return;
  try {
    const { booksCount, bookSummaries } = await buildBookSummariesPayload();
    lastPresenceTouchAt = Date.now();
    await updateDoc(doc(db, 'users', currentUser.uid), {
      booksCount,
      bookSummaries,
      lastActiveAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Non-critical summary refresh; primary library sync stays independent
  }
}

function scheduleBookSummarySync() {
  if (!currentUser) return;
  if (summarySyncTimer) clearTimeout(summarySyncTimer);
  summarySyncTimer = setTimeout(() => {
    summarySyncTimer = null;
    void syncUserReadingSummary();
  }, 1200);
}

async function touchPresenceHeartbeat(force = false, countVisit = false) {
  if (!currentUser || !currentUser.emailVerified || document.visibilityState !== 'visible') return;
  if (!force && !countVisit && Date.now() - lastPresenceTouchAt < 60000) return;
  lastPresenceTouchAt = Date.now();
  try {
    const patch: Record<string, unknown> = {
      lastActiveAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (countVisit) {
      patch.visitCount = increment(1);
      markUserVisitCounted(currentUser.uid);
    }
    await updateDoc(doc(db, 'users', currentUser.uid), patch);
  } catch {
    // Ignore transient network errors during background heartbeat
  }
}

function startPresenceHeartbeat() {
  stopPresenceTracking();
  presenceHeartbeatTimer = setInterval(() => {
    void touchPresenceHeartbeat(false, false);
  }, 3 * 60 * 1000);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      lastHiddenAt = Date.now();
    } else if (document.visibilityState === 'visible') {
      const resumedAfterBreak = lastHiddenAt > 0 && Date.now() - lastHiddenAt >= PWA_RESUME_VISIT_MS;
      lastHiddenAt = 0;
      void touchPresenceHeartbeat(resumedAfterBreak, resumedAfterBreak);
    }
  });
}

async function upsertUserProfile(user: User) {
  const path = `users/${user.uid}`;
  const docRef = doc(db, 'users', user.uid);
  const { booksCount, bookSummaries } = await buildBookSummariesPayload();
  const payload = {
    uid: user.uid,
    displayName: (user.displayName || 'Lector').slice(0, 120),
    email: (user.email || '').slice(0, 254),
    photoURL: (user.photoURL || '').slice(0, 1000) || null,
    booksCount,
    bookSummaries,
  };
  try {
    lastPresenceTouchAt = Date.now();
    const snap = await getDoc(docRef);
    const countThisVisit = shouldCountUserVisit(user.uid);
    if (snap.exists()) {
      const existingData = snap.data() as Record<string, unknown>;
      const rawVisits = Number(existingData.visitCount);
      const hasVisitCount = Number.isFinite(rawVisits) && rawVisits >= 1;
      const baseVisits = hasVisitCount ? Math.floor(rawVisits) : 0;
      const nextVisitCount = hasVisitCount
        ? Math.min(1000000, countThisVisit ? baseVisits + 1 : baseVisits)
        : 1;
      await updateDoc(docRef, {
        displayName: payload.displayName,
        email: payload.email,
        photoURL: payload.photoURL,
        visitCount: nextVisitCount,
        booksCount: payload.booksCount,
        bookSummaries: payload.bookSummaries,
        lastActiveAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(docRef, {
        ...payload,
        visitCount: 1,
        lastActiveAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    markUserVisitCounted(user.uid);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

async function cloudDocExists(storeName: StoreName, uid: string, id: string): Promise<boolean> {
  if (cloudIds[storeName].has(id)) return true;
  try {
    const snap = await getDoc(doc(db, 'users', uid, storeName, id));
    if (snap.exists()) {
      cloudIds[storeName].add(id);
      return true;
    }
  } catch {
    // Ignore probe error and let write attempt proceed
  }
  return false;
}

async function ensureParentBookInCloud(bookId: string, rawBookId?: string): Promise<void> {
  if (!currentUser || cloudIds.books.has(bookId)) return;
  const localBook =
    (await get<Book>('books', bookId)) ||
    (rawBookId && rawBookId !== bookId ? await get<Book>('books', rawBookId) : undefined);
  if (localBook) {
    await pushBookToCloud(localBook);
  }
}

export async function pushBookToCloud(book: Book): Promise<Book> {
  const id = sanitizeId(book.id);
  const normalized: Book = {
    ...book,
    id,
    tags: Array.isArray(book.tags)
      ? book.tags.map((t) => String(t).trim().slice(0, 32)).filter(Boolean).slice(0, 10)
      : [],
    rating: typeof book.rating === 'number' && book.rating >= 1 && book.rating <= 5 ? Math.round(book.rating) : null,
    review: String(book.review || '').slice(0, 10000),
    totalPages: Math.max(0, Math.floor(Number(book.totalPages) || 0)),
    currentPage: Math.max(0, Math.floor(Number(book.currentPage) || 0)),
    updatedAt: book.updatedAt || new Date().toISOString(),
    createdAt: book.createdAt || new Date().toISOString(),
  };

  await put('books', normalized);
  if (book.id !== id) await del('books', book.id);

  if (currentUser) {
    setSyncState('syncing', 'Sincronizando con la nube…');
    const uid = currentUser.uid;
    if (normalized.cover && normalized.cover.startsWith('data:image/')) {
      try {
        normalized.coverMediaId = await ensureMediaUploaded(uid, normalized.cover, normalized.coverMediaId);
        normalized.coverUrl = null;
        await put('books', normalized);
      } catch (err) {
        console.error('Cover media sync error:', err);
      }
    } else if (normalized.cover && /^https?:\/\//i.test(normalized.cover)) {
      normalized.coverUrl = normalized.cover.slice(0, 2000);
      normalized.coverMediaId = null;
    } else {
      normalized.coverUrl = null;
      normalized.coverMediaId = null;
    }

    const path = `users/${uid}/books/${id}`;
    const docRef = doc(db, 'users', uid, 'books', id);
    const mutableFields = {
      title: String(normalized.title || 'Sin título').slice(0, 300),
      author: String(normalized.author || '').slice(0, 300),
      publisher: String(normalized.publisher || '').slice(0, 200),
      year: String(normalized.year || '').slice(0, 20),
      edition: String(normalized.edition || '').slice(0, 120),
      isbn: String(normalized.isbn || '').slice(0, 32),
      totalPages: Math.min(100000, normalized.totalPages),
      currentPage: Math.min(100000, normalized.currentPage),
      status: normalized.status,
      coverUrl: normalized.coverUrl || null,
      coverMediaId: normalized.coverMediaId || null,
      tags: normalized.tags,
      rating: normalized.rating,
      review: normalized.review,
      readingLog: normalized.readingLog || {},
      updatedAt: serverTimestamp(),
    };

    try {
      const exists = await cloudDocExists('books', uid, id);
      if (exists) {
        await updateDoc(docRef, mutableFields);
      } else {
        await setDoc(docRef, {
          id,
          userId: uid,
          ...mutableFields,
          createdAt: serverTimestamp(),
        });
        cloudIds.books.add(id);
      }
      setSyncState('synced', `Sincronizado (${currentUser.email || 'cuenta Google'})`);
      scheduleBookSummarySync();
    } catch (error) {
      setSyncState('error', 'No se pudo sincronizar el libro.');
      console.error('Firestore book sync error:', path, error);
    }
  }

  return normalized;
}

export async function pushNoteToCloud(note: Note): Promise<Note> {
  const id = sanitizeId(note.id);
  const bookId = sanitizeId(note.bookId);
  const refNum = note.referencePage != null && note.referencePage !== ('' as any) ? Number(note.referencePage) : NaN;
  const endNum = note.endPage != null && note.endPage !== ('' as any) ? Number(note.endPage) : NaN;
  const normalized: Note = {
    ...note,
    id,
    bookId,
    number: Math.min(100000, Math.max(1, Math.floor(Number(note.number) || 1))),
    section: Math.min(1000, Math.max(1, Math.floor(Number(note.section) || 1))),
    referencePage: Number.isFinite(refNum) ? Math.max(0, Math.floor(refNum)) : null,
    endPage: Number.isFinite(endNum) ? Math.max(0, Math.floor(endNum)) : null,
    text: String(note.text || '').slice(0, 20000) || '(Sin texto)',
    comment: String(note.comment || '').slice(0, 10000),
    read: Boolean(note.read),
    createdAt: note.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await put('notes', normalized);
  if (note.id !== id) await del('notes', note.id);

  if (currentUser) {
    setSyncState('syncing', 'Sincronizando notas…');
    const uid = currentUser.uid;
    const path = `users/${uid}/notes/${id}`;
    const docRef = doc(db, 'users', uid, 'notes', id);
    const mutableFields = {
      number: normalized.number,
      section: normalized.section,
      referencePage: normalized.referencePage,
      endPage: normalized.endPage,
      text: normalized.text,
      comment: normalized.comment || '',
      read: normalized.read,
      updatedAt: serverTimestamp(),
    };
    try {
      const exists = await cloudDocExists('notes', uid, id);
      if (exists) {
        await updateDoc(docRef, mutableFields);
      } else {
        await ensureParentBookInCloud(bookId, note.bookId);
        await setDoc(docRef, {
          id,
          userId: uid,
          bookId,
          ...mutableFields,
          createdAt: serverTimestamp(),
        });
        cloudIds.notes.add(id);
      }
      setSyncState('synced', `Sincronizado (${currentUser.email || 'cuenta Google'})`);
    } catch (error) {
      setSyncState('error', 'No se pudo sincronizar la nota.');
      console.error('Firestore note sync error:', path, error);
    }
  }

  return normalized;
}

export async function pushEntryToCloud(entry: Entry): Promise<Entry> {
  const id = sanitizeId(entry.id);
  const bookId = sanitizeId(entry.bookId);
  const normalized: Entry = {
    ...entry,
    id,
    bookId,
    page: Math.min(100000, Math.max(0, Math.floor(Number(entry.page) || 0))),
    title: String(entry.title || '').slice(0, 300),
    text: String(entry.text || '').slice(0, 20000),
    comment: String(entry.comment || '').slice(0, 10000),
    createdAt: entry.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await put('entries', normalized);
  if (entry.id !== id) await del('entries', entry.id);

  if (currentUser) {
    setSyncState('syncing', 'Sincronizando anotación…');
    const uid = currentUser.uid;
    if (normalized.photo && normalized.photo.startsWith('data:image/')) {
      try {
        normalized.photoMediaId = await ensureMediaUploaded(uid, normalized.photo, normalized.photoMediaId);
        await put('entries', normalized);
      } catch (err) {
        console.error('Entry media sync error:', err);
      }
    } else if (!normalized.photo) {
      normalized.photoMediaId = null;
    }

    const path = `users/${uid}/entries/${id}`;
    const docRef = doc(db, 'users', uid, 'entries', id);
    const mutableFields = {
      page: normalized.page,
      title: normalized.title || '',
      text: normalized.text || '',
      comment: normalized.comment || '',
      photoMediaId: normalized.photoMediaId || null,
      updatedAt: serverTimestamp(),
    };
    try {
      const exists = await cloudDocExists('entries', uid, id);
      if (exists) {
        await updateDoc(docRef, mutableFields);
      } else {
        await ensureParentBookInCloud(bookId, entry.bookId);
        await setDoc(docRef, {
          id,
          userId: uid,
          bookId,
          ...mutableFields,
          createdAt: serverTimestamp(),
        });
        cloudIds.entries.add(id);
      }
      setSyncState('synced', `Sincronizado (${currentUser.email || 'cuenta Google'})`);
    } catch (error) {
      setSyncState('error', 'No se pudo sincronizar la anotación.');
      console.error('Firestore entry sync error:', path, error);
    }
  }

  return normalized;
}

export async function pushQuoteToCloud(quote: Quote): Promise<Quote> {
  const id = sanitizeId(quote.id);
  const bookId = sanitizeId(quote.bookId);
  const photos = Array.isArray(quote.photos) ? quote.photos.slice(0, 5) : [];
  const pageNum = quote.page != null && quote.page !== ('' as any) ? Number(quote.page) : NaN;
  const normalized: Quote = {
    ...quote,
    id,
    bookId,
    text: String(quote.text || '').slice(0, 20000) || '(Sin texto)',
    chapter: String(quote.chapter || '').slice(0, 200),
    page: Number.isFinite(pageNum) ? Math.max(0, Math.floor(pageNum)) : null,
    analysis: String(quote.analysis || '').slice(0, 10000),
    photos,
    photoMediaIds: Array.isArray(quote.photoMediaIds) ? quote.photoMediaIds.slice(0, 5) : [],
    createdAt: quote.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await put('quotes', normalized);
  if (quote.id !== id) await del('quotes', quote.id);

  if (currentUser) {
    setSyncState('syncing', 'Sincronizando cita…');
    const uid = currentUser.uid;
    const mediaIds: string[] = [];
    try {
      for (let i = 0; i < photos.length; i++) {
        const existingMid = normalized.photoMediaIds?.[i] || null;
        const mid = await ensureMediaUploaded(uid, photos[i], existingMid);
        mediaIds.push(mid);
      }
      normalized.photoMediaIds = mediaIds;
      await put('quotes', normalized);
    } catch (err) {
      console.error('Quote media sync error:', err);
    }

    const path = `users/${uid}/quotes/${id}`;
    const docRef = doc(db, 'users', uid, 'quotes', id);
    const mutableFields = {
      text: normalized.text,
      chapter: normalized.chapter || '',
      page: normalized.page,
      analysis: normalized.analysis || '',
      photoMediaIds: normalized.photoMediaIds,
      updatedAt: serverTimestamp(),
    };
    try {
      const exists = await cloudDocExists('quotes', uid, id);
      if (exists) {
        await updateDoc(docRef, mutableFields);
      } else {
        await ensureParentBookInCloud(bookId, quote.bookId);
        await setDoc(docRef, {
          id,
          userId: uid,
          bookId,
          ...mutableFields,
          createdAt: serverTimestamp(),
        });
        cloudIds.quotes.add(id);
      }
      setSyncState('synced', `Sincronizado (${currentUser.email || 'cuenta Google'})`);
    } catch (error) {
      setSyncState('error', 'No se pudo sincronizar la cita.');
      console.error('Firestore quote sync error:', path, error);
    }
  }

  return normalized;
}

export async function pushAnalysisToCloud(analysis: BookAnalysis): Promise<BookAnalysis> {
  const id = sanitizeId(analysis.id);
  const bookId = sanitizeId(analysis.bookId);
  const normalized: BookAnalysis = {
    ...analysis,
    id,
    bookId,
    summary: String(analysis.summary || '').slice(0, 15000) || '(Sin resumen)',
    themes: (analysis.themes || []).map(String).slice(0, 12),
    connections: (analysis.connections || []).slice(0, 20),
    questions: (analysis.questions || []).map(String).slice(0, 10),
    sourceCount: Math.min(10000, Math.max(0, Math.floor(Number(analysis.sourceCount) || 0))),
    model: String(analysis.model || 'gemini-4-hydrogen').slice(0, 80),
    createdAt: analysis.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await put('analyses', normalized);
  if (analysis.id !== id) await del('analyses', analysis.id);

  if (currentUser) {
    setSyncState('syncing', 'Guardando análisis del libro…');
    const uid = currentUser.uid;
    const path = `users/${uid}/analyses/${id}`;
    const docRef = doc(db, 'users', uid, 'analyses', id);
    const mutableFields = {
      summary: normalized.summary,
      themes: normalized.themes,
      connections: normalized.connections,
      questions: normalized.questions,
      sourceCount: normalized.sourceCount,
      model: normalized.model,
      updatedAt: serverTimestamp(),
    };
    try {
      const exists = await cloudDocExists('analyses', uid, id);
      if (exists) {
        await updateDoc(docRef, mutableFields);
      } else {
        await ensureParentBookInCloud(bookId, analysis.bookId);
        await setDoc(docRef, {
          id,
          userId: uid,
          bookId,
          ...mutableFields,
          createdAt: serverTimestamp(),
        });
        cloudIds.analyses.add(id);
      }
      setSyncState('synced', `Sincronizado (${currentUser.email || 'cuenta Google'})`);
    } catch (error) {
      setSyncState('error', 'No se pudo guardar el análisis en la nube.');
      console.error('Firestore analysis sync error:', path, error);
    }
  }

  return normalized;
}

export async function pushConversationToCloud(conv: Conversation): Promise<Conversation> {
  const id = sanitizeId(conv.id);
  const bookId = sanitizeId(conv.bookId || 'unknown');
  const inferredType =
    conv.targetType ||
    (id.startsWith('note')
      ? 'note'
      : id.startsWith('entry')
        ? 'entry'
        : id.startsWith('quote')
          ? 'quote'
          : 'book');

  const normalized: Conversation = {
    ...conv,
    id,
    bookId,
    targetType: inferredType,
    history: (conv.history || []).slice(0, 40),
    hadImages: Boolean(conv.hadImages),
    createdAt: conv.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await put('conversations', normalized);
  if (conv.id !== id) await del('conversations', conv.id);

  if (currentUser && bookId !== 'unknown') {
    const uid = currentUser.uid;
    const path = `users/${uid}/conversations/${id}`;
    const docRef = doc(db, 'users', uid, 'conversations', id);
    const mutableFields = {
      history: normalized.history,
      hadImages: normalized.hadImages,
      updatedAt: serverTimestamp(),
    };
    try {
      const exists = await cloudDocExists('conversations', uid, id);
      if (exists) {
        await updateDoc(docRef, mutableFields);
      } else {
        await ensureParentBookInCloud(bookId, conv.bookId);
        await setDoc(docRef, {
          id,
          userId: uid,
          bookId,
          targetType: inferredType,
          ...mutableFields,
          createdAt: serverTimestamp(),
        });
        cloudIds.conversations.add(id);
      }
    } catch (error) {
      console.error('Firestore conversation sync error:', path, error);
    }
  }

  return normalized;
}

export async function deleteFromCloud(storeName: StoreName, rawId: string): Promise<void> {
  const id = sanitizeId(rawId);
  await del(storeName, id);
  if (rawId !== id) await del(storeName, rawId);

  if (currentUser) {
    const uid = currentUser.uid;
    const path = `users/${uid}/${storeName}/${id}`;
    try {
      await deleteDoc(doc(db, 'users', uid, storeName, id));
      cloudIds[storeName].delete(id);
      if (storeName === 'books') scheduleBookSummarySync();
    } catch (error) {
      setSyncState('error', 'Error al eliminar en la nube.');
      console.error('Firestore delete error:', path, error);
    }
  }
}

export async function migrateLocalDataToCloud(): Promise<number> {
  if (!currentUser) return 0;
  setSyncState('syncing', 'Subiendo biblioteca local a la nube…');
  let migratedCount = 0;

  const localBooks = await all<Book>('books');
  for (const book of localBooks) {
    const bid = sanitizeId(book.id);
    if (!cloudIds.books.has(bid)) {
      await pushBookToCloud(book);
      migratedCount++;
    }
  }

  const localNotes = await all<Note>('notes');
  for (const note of localNotes) {
    const nid = sanitizeId(note.id);
    if (!cloudIds.notes.has(nid)) {
      await pushNoteToCloud(note);
      migratedCount++;
    }
  }

  const localEntries = await all<Entry>('entries');
  for (const entry of localEntries) {
    const eid = sanitizeId(entry.id);
    if (!cloudIds.entries.has(eid)) {
      await pushEntryToCloud(entry);
      migratedCount++;
    }
  }

  const localQuotes = await all<Quote>('quotes');
  for (const quote of localQuotes) {
    const qid = sanitizeId(quote.id);
    if (!cloudIds.quotes.has(qid)) {
      await pushQuoteToCloud(quote);
      migratedCount++;
    }
  }

  const localAnalyses = await all<BookAnalysis>('analyses');
  for (const analysis of localAnalyses) {
    const aid = sanitizeId(analysis.id);
    if (!cloudIds.analyses.has(aid)) {
      await pushAnalysisToCloud(analysis);
      migratedCount++;
    }
  }

  const localConvs = await all<Conversation>('conversations');
  for (const conv of localConvs) {
    const cid = sanitizeId(conv.id);
    if (!cloudIds.conversations.has(cid) && conv.bookId) {
      await pushConversationToCloud(conv);
      migratedCount++;
    }
  }

  void syncUserReadingSummary();
  setSyncState('synced', `Sincronizado (${currentUser.email || 'cuenta Google'})`);
  return migratedCount;
}

function subscribeUserCollections(uid: string) {
  stopListeners();
  const initialLoaded = new Set<string>();
  let migrationTriggered = false;

  const maybeMigrateAndNotify = async (colKey: string) => {
    initialLoaded.add(colKey);
    onDataChangedCb?.();
    if (!migrationTriggered && initialLoaded.size >= 7) {
      migrationTriggered = true;
      await migrateLocalDataToCloud();
      onDataChangedCb?.();
    }
  };

  // Media listener first so images hydrate cleanly
  unsubscribers.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'media'), where('userId', '==', uid)),
      async (snapshot) => {
        cloudIds.media.clear();
        for (const d of snapshot.docs) {
          cloudIds.media.add(d.id);
          const data = d.data() as any;
          await put('media', {
            id: d.id,
            userId: uid,
            mimeType: data.mimeType || 'image/jpeg',
            dataUrl: data.dataUrl || '',
            createdAt: toIso(data.createdAt),
          });
        }
        // Re-hydrate local books/entries/quotes with newly arrived media
        const books = await all<Book>('books');
        for (const b of books) {
          const hydrated = await hydrateBookFromLocalMedia(b);
          if (hydrated.cover !== b.cover) await put('books', hydrated);
        }
        const entries = await all<Entry>('entries');
        for (const e of entries) {
          const hydrated = await hydrateEntryFromLocalMedia(e);
          if (hydrated.photo !== e.photo) await put('entries', hydrated);
        }
        const quotes = await all<Quote>('quotes');
        for (const q of quotes) {
          const hydrated = await hydrateQuoteFromLocalMedia(q);
          if (hydrated.photos.length !== (q.photos || []).length) await put('quotes', hydrated);
        }
        await maybeMigrateAndNotify('media');
      },
      (error) => {
        setSyncState('error', 'Error de permisos en medios.');
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/media`);
      },
    ),
  );

  // Books listener
  unsubscribers.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'books'), where('userId', '==', uid)),
      async (snapshot) => {
        const nextIds = new Set<string>();
        for (const d of snapshot.docs) {
          nextIds.add(d.id);
          const data = d.data() as any;
          const hydrated = await hydrateBookFromLocalMedia({
            id: d.id,
            userId: uid,
            title: data.title || 'Sin título',
            author: data.author || '',
            publisher: data.publisher || '',
            year: data.year || '',
            edition: data.edition || '',
            isbn: data.isbn || '',
            totalPages: Number(data.totalPages) || 0,
            currentPage: Number(data.currentPage) || 0,
            status: data.status || 'pending',
            coverUrl: data.coverUrl || null,
            coverMediaId: data.coverMediaId || null,
            cover: data.coverUrl || null,
            tags: Array.isArray(data.tags) ? data.tags : [],
            rating: data.rating ?? null,
            review: data.review || '',
            readingLog: data.readingLog || {},
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          });
          await put('books', hydrated);
        }
        // Remove docs deleted on other devices (if already known in cloud)
        for (const oldId of cloudIds.books) {
          if (!nextIds.has(oldId)) await del('books', oldId);
        }
        cloudIds.books = nextIds;
        scheduleBookSummarySync();
        await maybeMigrateAndNotify('books');
      },
      (error) => {
        setSyncState('error', 'Error al sincronizar libros.');
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/books`);
      },
    ),
  );

  // Notes listener
  unsubscribers.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'notes'), where('userId', '==', uid)),
      async (snapshot) => {
        const nextIds = new Set<string>();
        for (const d of snapshot.docs) {
          nextIds.add(d.id);
          const data = d.data() as any;
          await put('notes', {
            id: d.id,
            userId: uid,
            bookId: data.bookId,
            number: Number(data.number) || 1,
            section: Number(data.section) || 1,
            referencePage: data.referencePage ?? null,
            endPage: data.endPage ?? null,
            text: data.text || '',
            comment: data.comment || '',
            read: Boolean(data.read),
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          });
        }
        for (const oldId of cloudIds.notes) {
          if (!nextIds.has(oldId)) await del('notes', oldId);
        }
        cloudIds.notes = nextIds;
        await maybeMigrateAndNotify('notes');
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/notes`);
      },
    ),
  );

  // Entries listener
  unsubscribers.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'entries'), where('userId', '==', uid)),
      async (snapshot) => {
        const nextIds = new Set<string>();
        for (const d of snapshot.docs) {
          nextIds.add(d.id);
          const data = d.data() as any;
          const hydrated = await hydrateEntryFromLocalMedia({
            id: d.id,
            userId: uid,
            bookId: data.bookId,
            page: Number(data.page) || 0,
            title: data.title || '',
            text: data.text || '',
            comment: data.comment || '',
            photoMediaId: data.photoMediaId || null,
            photo: null,
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          });
          await put('entries', hydrated);
        }
        for (const oldId of cloudIds.entries) {
          if (!nextIds.has(oldId)) await del('entries', oldId);
        }
        cloudIds.entries = nextIds;
        await maybeMigrateAndNotify('entries');
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/entries`);
      },
    ),
  );

  // Quotes listener
  unsubscribers.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'quotes'), where('userId', '==', uid)),
      async (snapshot) => {
        const nextIds = new Set<string>();
        for (const d of snapshot.docs) {
          nextIds.add(d.id);
          const data = d.data() as any;
          const hydrated = await hydrateQuoteFromLocalMedia({
            id: d.id,
            userId: uid,
            bookId: data.bookId,
            text: data.text || '',
            chapter: data.chapter || '',
            page: data.page ?? null,
            analysis: data.analysis || '',
            photoMediaIds: Array.isArray(data.photoMediaIds) ? data.photoMediaIds : [],
            photos: [],
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          });
          await put('quotes', hydrated);
        }
        for (const oldId of cloudIds.quotes) {
          if (!nextIds.has(oldId)) await del('quotes', oldId);
        }
        cloudIds.quotes = nextIds;
        await maybeMigrateAndNotify('quotes');
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/quotes`);
      },
    ),
  );

  // Analyses listener
  unsubscribers.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'analyses'), where('userId', '==', uid)),
      async (snapshot) => {
        const nextIds = new Set<string>();
        for (const d of snapshot.docs) {
          nextIds.add(d.id);
          const data = d.data() as any;
          await put('analyses', {
            id: d.id,
            userId: uid,
            bookId: data.bookId,
            summary: data.summary || '',
            themes: Array.isArray(data.themes) ? data.themes : [],
            connections: Array.isArray(data.connections) ? data.connections : [],
            questions: Array.isArray(data.questions) ? data.questions : [],
            sourceCount: Number(data.sourceCount) || 0,
            model: data.model || 'gemini-4-hydrogen',
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          });
        }
        for (const oldId of cloudIds.analyses) {
          if (!nextIds.has(oldId)) await del('analyses', oldId);
        }
        cloudIds.analyses = nextIds;
        await maybeMigrateAndNotify('analyses');
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/analyses`);
      },
    ),
  );

  // Conversations listener
  unsubscribers.push(
    onSnapshot(
      query(collection(db, 'users', uid, 'conversations'), where('userId', '==', uid)),
      async (snapshot) => {
        const nextIds = new Set<string>();
        for (const d of snapshot.docs) {
          nextIds.add(d.id);
          const data = d.data() as any;
          await put('conversations', {
            id: d.id,
            userId: uid,
            bookId: data.bookId,
            targetType: data.targetType || 'note',
            history: Array.isArray(data.history) ? data.history : [],
            hadImages: Boolean(data.hadImages),
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          });
        }
        for (const oldId of cloudIds.conversations) {
          if (!nextIds.has(oldId)) await del('conversations', oldId);
        }
        cloudIds.conversations = nextIds;
        await maybeMigrateAndNotify('conversations');
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${uid}/conversations`);
      },
    ),
  );
}

export function initSync(
  onDataChanged: () => void,
  onSyncState: (status: SyncStatus, message: string, user: User | null) => void,
) {
  onDataChangedCb = onDataChanged;
  onSyncStateCb = onSyncState;

  testConnection();

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (!user) {
      stopListeners();
      stopPresenceTracking();
      void reportSiteVisit(false);
      setSyncState('local', 'Modo local. Iniciá sesión para sincronizar en la nube.');
      onDataChangedCb?.();
      return;
    }

    void reportSiteVisit(true);

    try {
      const prevUid = localStorage.getItem(LAST_UID_KEY);
      if (prevUid && prevUid !== user.uid) {
        await clearAllStores();
      }
      localStorage.setItem(LAST_UID_KEY, user.uid);
    } catch {
      // Ignore storage errors
    }

    setSyncState('syncing', `Conectando cuenta (${user.email || user.displayName || 'Google'})…`);
    try {
      await upsertUserProfile(user);
      subscribeUserCollections(user.uid);
      startPresenceHeartbeat();
    } catch {
      setSyncState('error', 'No se pudo inicializar la sincronización en la nube.');
    }
  });
}

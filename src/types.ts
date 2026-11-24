export type BookStatus = 'pending' | 'reading' | 'paused' | 'finished';

export type SortOption =
  | 'recent'
  | 'title'
  | 'author'
  | 'rating'
  | 'progress'
  | 'year';

export interface Book {
  id: string;
  userId?: string;
  title: string;
  author?: string;
  publisher?: string;
  year?: string;
  edition?: string;
  isbn?: string;
  totalPages: number;
  currentPage: number;
  status: BookStatus;
  cover?: string | null;
  coverUrl?: string | null;
  coverMediaId?: string | null;
  tags: string[];
  rating: number | null;
  review: string;
  readingLog?: Record<string, number>;
  createdAt?: string;
  updatedAt?: string;
}

export interface Note {
  id: string;
  userId?: string;
  bookId: string;
  number: number;
  section: number;
  referencePage: number | null;
  endPage: number | null;
  text: string;
  comment?: string;
  read: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Entry {
  id: string;
  userId?: string;
  bookId: string;
  page: number;
  title?: string;
  text?: string;
  comment?: string;
  photo?: string | null;
  photoMediaId?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface Quote {
  id: string;
  userId?: string;
  bookId: string;
  text: string;
  chapter?: string;
  page: number | null;
  analysis?: string;
  photos: string[];
  photoMediaIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BookConnection {
  title: string;
  explanation: string;
  refs: string[];
}

export interface BookAnalysis {
  id: string;
  userId?: string;
  bookId: string;
  summary: string;
  themes: string[];
  connections: BookConnection[];
  questions: string[];
  sourceCount: number;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTurn {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export interface Conversation {
  id: string;
  userId?: string;
  bookId?: string;
  targetType?: 'note' | 'entry' | 'quote' | 'book';
  history: ConversationTurn[];
  hadImages: boolean;
  createdAt?: string;
  updatedAt: string;
}

export interface MediaItem {
  id: string;
  userId?: string;
  mimeType: string;
  dataUrl: string;
  createdAt?: string;
}

export type AIThinking = 'auto' | 'minimal' | 'low' | 'medium' | 'high';

export interface AISettings {
  model: string;
  thinking: AIThinking;
  chatModel: string;
  chatThinking: 'inherit' | AIThinking;
  analysisModel: string;
  analysisThinking: 'inherit' | AIThinking;
  imageModel: string;
  imageThinking: 'inherit' | AIThinking;
  style: 'natural' | 'concise' | 'detailed' | 'socratic' | 'custom';
  customStyle: string;
}

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error';

export type FeedbackKind = 'bug' | 'idea' | 'other';
export type FeedbackStatus = 'open' | 'reviewed' | 'resolved' | 'dismissed';

export interface FeedbackItem {
  id: string;
  userId: string;
  authorName: string;
  authorEmail: string;
  kind: FeedbackKind;
  message: string;
  appContext: string;
  status: FeedbackStatus;
  adminNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookProgressSummary {
  id: string;
  title: string;
  author: string;
  status: BookStatus;
  percent: number;
  currentPage: number;
  totalPages: number;
}

export interface UserDirectoryEntry {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  visitCount: number;
  booksCount: number;
  bookSummaries: BookProgressSummary[];
}

export interface SiteVisitStats {
  startedAt: string;
  totalVisits: number;
  anonVisits: number;
  authVisits: number;
  todayDate: string;
  todayVisits: number;
  todayAnonVisits: number;
  todayAuthVisits: number;
  recentDays: Array<{
    date: string;
    total: number;
    anon: number;
    auth: number;
  }>;
}



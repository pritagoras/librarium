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

export interface AISettings {
  model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  thinking: 'auto' | 'low' | 'medium' | 'high';
  style: 'natural' | 'concise' | 'detailed' | 'socratic' | 'custom';
  customStyle: string;
  ttsVoice: 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';
}

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error';

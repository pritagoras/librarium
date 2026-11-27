import type { SyncedStoreName } from './types';
import { mergeSubannotations } from './app/gemini-key-phrase';

export type MergeDecision<T extends object> =
  | { kind: 'accept-remote'; record: T }
  | { kind: 'conflict'; winner: 'local' | 'remote'; local: T; remote: T };

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !['createdAt', 'updatedAt', 'userId', 'cover', 'photo', 'photos'].includes(key))
      .filter((key) => value[key] !== undefined && value[key] !== null && value[key] !== '')
      .filter((key) => !(value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]) && Object.keys(value[key]).length === 0))
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

export function recordsHaveSameContent(a: Record<string, any>, b: Record<string, any>): boolean {
  if (JSON.stringify(canonical(a)) !== JSON.stringify(canonical(b))) return false;
  for (const field of ['cover', 'photo']) {
    if ((a[field] || null) !== (b[field] || null)) return false;
  }
  const photosA = Array.isArray(a.photos) ? a.photos : [];
  const photosB = Array.isArray(b.photos) ? b.photos : [];
  return photosA.length === photosB.length && photosA.every((photo, index) => photo === photosB[index]);
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Prefer the latest edit, but report divergent versions so callers can retain
 * both copies and let the reader choose instead of silently discarding one.
 */
export function reconcileRecords<T extends object>(
  local: T | undefined,
  remote: T,
): MergeDecision<T> {
  if (local && (['subannotations', 'aiSubcomments'].some((field) => field in (local as any) || field in (remote as any)))) {
    const merged = mergeSubannotations((local as any).subannotations, (remote as any).subannotations);
    const replies = mergeSubannotations((local as any).aiSubcomments, (remote as any).aiSubcomments);
    local = { ...local, subannotations: merged, aiSubcomments: replies } as T;
    remote = { ...remote, subannotations: merged, aiSubcomments: replies } as T;
  }
  if (!local || recordsHaveSameContent(local as Record<string, any>, remote as Record<string, any>)) {
    return { kind: 'accept-remote', record: remote };
  }
  const winner = timestamp((local as any).updatedAt) > timestamp((remote as any).updatedAt) ? 'local' : 'remote';
  return { kind: 'conflict', winner, local, remote };
}

export function makeConflictId(
  storeName: SyncedStoreName,
  recordId: string,
  localUpdatedAt: string,
  remoteUpdatedAt: string,
  localRecord?: Record<string, any>,
  remoteRecord?: Record<string, any>,
): string {
  const base = [storeName, recordId, localUpdatedAt, remoteUpdatedAt].join(':');
  if (!localRecord || !remoteRecord) return base;
  const imageFingerprint = (record: Record<string, any>) =>
    [record.cover, record.photo, ...(Array.isArray(record.photos) ? record.photos : [])]
      .map((image) => image == null ? '' : `${String(image).length}:${hash(String(image))}`)
      .join('|');
  const content = JSON.stringify([
    canonical(localRecord), canonical(remoteRecord),
    imageFingerprint(localRecord), imageFingerprint(remoteRecord),
  ]);
  return `${base}:${hash(content)}`;
}

function hash(content: string): string {
  let digest = 2166136261;
  for (let index = 0; index < content.length; index++) {
    digest = Math.imul(digest ^ content.charCodeAt(index), 16777619);
  }
  return (digest >>> 0).toString(36);
}

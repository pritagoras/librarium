export const KEY_PHRASE_MARKER = '[[FRASE_CLAVE]]';

export function extractKeyPhrase(answer: string): { answer: string; phrase: string | null } {
  const markerAt = answer.lastIndexOf(KEY_PHRASE_MARKER);
  if (markerAt < 0) return { answer: answer.trim(), phrase: null };
  const body = answer.slice(0, markerAt).trim();
  const phrase = answer.slice(markerAt + KEY_PHRASE_MARKER.length).trim().replace(/^\*\*|\*\*$/g, '').trim();
  const words = phrase.match(/\S+/g) || [];
  if (!body || !phrase || words.length > 25 || /[\r\n]/.test(phrase)) return { answer: body || answer.slice(0, markerAt).trim(), phrase: null };
  return { answer: body, phrase };
}

/** Keep the private protocol marker and its unfinished suffix out of the live stream. */
export function visibleStreamingAnswer(answer: string): string {
  const markerAt = answer.lastIndexOf(KEY_PHRASE_MARKER);
  if (markerAt >= 0) return answer.slice(0, markerAt).trimEnd();
  const max = Math.min(answer.length, KEY_PHRASE_MARKER.length - 1);
  for (let size = max; size > 0; size--) {
    if (KEY_PHRASE_MARKER.startsWith(answer.slice(-size))) return answer.slice(0, -size).trimEnd();
  }
  return answer.trimEnd();
}

export function mergeSubannotations<T extends { id: string }>(...groups: Array<T[] | undefined>): T[] {
  const byId = new Map<string, T>();
  for (const item of groups.flatMap((group) => group || [])) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

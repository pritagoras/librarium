/** Codificador GIF89a animado mínimo (sin dependencias): paleta global y píxeles sin cambios transparentes. */

const TRANSPARENT = 255;

/** Paleta de hasta 255 colores por corte de mediana sobre muestras RGBA. */
export function buildPalette(samples: Uint8ClampedArray[]): number[][] {
  const counts = new Map<number, number>();
  for (const rgba of samples) for (let i = 0; i < rgba.length; i += 4) {
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  type Color = [number, number, number, number];
  const expand = (v: number) => (v << 3) | (v >> 2);
  const boxes: Color[][] = [[...counts].map(([key, n]): Color => [expand(key >> 10), expand((key >> 5) & 31), expand(key & 31), n])];
  while (boxes.length < TRANSPARENT) {
    let best = -1, bestScore = 0, channel = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const weight = box.reduce((sum, c) => sum + c[3], 0);
      for (let ch = 0; ch < 3; ch++) {
        let min = 255, max = 0;
        for (const c of box) { min = Math.min(min, c[ch]); max = Math.max(max, c[ch]); }
        const score = (max - min) * Math.sqrt(weight);
        if (score > bestScore) { bestScore = score; best = i; channel = ch; }
      }
    });
    if (best < 0) break;
    const box = boxes[best].sort((a, b) => a[channel] - b[channel]);
    const half = box.reduce((sum, c) => sum + c[3], 0) / 2;
    let acc = 0, cut = 0;
    while (cut < box.length - 1 && acc < half) acc += box[cut++][3];
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    const total = box.reduce((sum, c) => sum + c[3], 0) || 1;
    return [0, 1, 2].map((ch) => Math.round(box.reduce((sum, c) => sum + c[ch] * c[3], 0) / total));
  });
}

function lzw(pixels: Uint8Array, out: number[]) {
  const CLEAR = 256, END = 257;
  const block: number[] = [];
  let buffer = 0, bits = 0, size = 9, next = 258;
  let table = new Map<number, number>();
  const flush = () => { if (block.length) { out.push(block.length, ...block); block.length = 0; } };
  const emit = (code: number) => {
    buffer |= code << bits;
    bits += size;
    while (bits >= 8) { block.push(buffer & 255); buffer >>= 8; bits -= 8; if (block.length === 255) flush(); }
  };
  out.push(8);
  emit(CLEAR);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const key = (prefix << 8) | pixels[i];
    const found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next === 4096) { emit(CLEAR); table = new Map(); next = 258; size = 9; }
    else {
      if (next === 1 << size) size++;
      table.set(key, next++);
    }
    prefix = pixels[i];
  }
  emit(prefix);
  emit(END);
  if (bits > 0) block.push(buffer & 255);
  flush();
  out.push(0);
}

export class GifEncoder {
  private chunks: Uint8Array[] = [];
  private previous: Uint8Array | null = null;
  private cache = new Map<number, number>();

  constructor(private width: number, private height: number, private palette: number[][]) {
    const head = [...'GIF89a'].map((c) => c.charCodeAt(0));
    head.push(width & 255, width >> 8, height & 255, height >> 8, 0xf7, 0, 0);
    for (let i = 0; i < 256; i++) head.push(...(palette[i] || [0, 0, 0]));
    // Repetición infinita.
    head.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
    this.chunks.push(Uint8Array.from(head));
  }

  private nearest(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    let index = this.cache.get(key);
    if (index !== undefined) return index;
    let best = Infinity;
    index = 0;
    for (let i = 0; i < this.palette.length; i++) {
      const [pr, pg, pb] = this.palette[i];
      const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < best) { best = d; index = i; }
    }
    this.cache.set(key, index);
    return index;
  }

  addFrame(rgba: Uint8ClampedArray, delayMs: number) {
    const current = new Uint8Array(this.width * this.height);
    for (let i = 0; i < current.length; i++) current[i] = this.nearest(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    const pixels = this.previous ? current.map((v, i) => (v === this.previous![i] ? TRANSPARENT : v)) : current;
    this.previous = current;
    const delay = Math.max(2, Math.round(delayMs / 10));
    const out: number[] = [0x21, 0xf9, 4, 0x05, delay & 255, delay >> 8, TRANSPARENT, 0];
    out.push(0x2c, 0, 0, 0, 0, this.width & 255, this.width >> 8, this.height & 255, this.height >> 8, 0);
    lzw(pixels, out);
    this.chunks.push(Uint8Array.from(out));
  }

  finish(): Uint8Array<ArrayBuffer> {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 1);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    bytes[offset] = 0x3b;
    return bytes;
  }
}

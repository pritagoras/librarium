/**
 * Pantalla "Optimizar y animar": la red de personajes se forma en vivo sobre un canvas y se
 * puede exportar como video o GIF para compartir. Solo dibuja nombres y tipos de vínculo.
 */
import { isDirectedType } from './characters-model';
import { computeLayout, growthOrder, type Point } from './network-layout';
import { GifEncoder, buildPalette } from './gif-encoder';

export interface ShareNetwork {
  bookTitle: string;
  characters: Array<{ id: string; name: string }>;
  relations: Array<{ fromId: string; toId: string; type: string; certainty: string }>;
}

const SIZE = 1080;
const MAX_NODES = 30;
const GIF_SIZE = 480;
const GIF_FPS = 12;
const BACKGROUND = '#1b211d';
const APP_URL = 'pritagoras.github.io/librarium';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

export function relationColor(type: string): string {
  const key = type.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
  if (/famili|madre|padre|hijo|herman|abuelo|nieto|tio|sobrino|primo/.test(key)) return '#e0ac69';
  if (/amistad/.test(key)) return '#9cc788';
  if (/alianza/.test(key)) return '#7fc0bb';
  if (/rival|enemi/.test(key)) return '#e0786b';
  if (/romant|amor|espos|pareja/.test(key)) return '#e093b8';
  if (/mentor/.test(key)) return '#c9b765';
  if (/labor/.test(key)) return '#86aed0';
  const palette = ['#b5a1e0', '#d9c08c', '#86aed0', '#e093b8', '#9cc788', '#e0786b'];
  let hash = 0;
  for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (v: number) => 1 - (1 - clamp01(v)) ** 3;
const pop = (v: number) => { const t = clamp01(v) - 1; return 1 + 2.7 * t ** 3 + 1.7 * t ** 2; };

/** Construye la escena una vez; `draw(t)` pinta el cuadro del milisegundo `t`. */
export function createScene(network: ShareNetwork) {
  const degree = new Map(network.characters.map((c) => [c.id, 0]));
  for (const r of network.relations) for (const id of [r.fromId, r.toId]) if (degree.has(id)) degree.set(id, degree.get(id)! + 1);
  const characters = [...network.characters].sort((a, b) => degree.get(b.id)! - degree.get(a.id)!).slice(0, MAX_NODES);
  const ids = characters.map((c) => c.id);
  const relations = network.relations.filter((r) => ids.includes(r.fromId) && ids.includes(r.toId) && r.fromId !== r.toId);
  const n = characters.length;
  const radius = n <= 8 ? 64 : n <= 14 ? 50 : n <= 20 ? 42 : 32;
  const top = 185, areaHeight = 695;
  const layout = computeLayout(ids, relations, { width: SIZE, height: areaHeight, padding: radius + 55, minDistance: radius * 3.4 });
  const position = new Map<string, Point>(ids.map((id) => [id, { x: layout.get(id)!.x, y: layout.get(id)!.y + top }]));

  const order = growthOrder(ids, relations);
  const START = 700, TRAVEL = 800;
  const step = Math.max(180, Math.min(650, 6500 / Math.max(1, n)));
  const born = new Map(order.map((s, i) => [s.id, START + i * step]));
  const parent = new Map(order.map((s) => [s.id, s.parentId]));
  const built = START + (n - 1) * step + TRAVEL + 500;
  const duration = built + 2800;

  // Vínculos repetidos entre las mismas dos personas: una sola línea con los tipos unidos.
  const pairs = new Map<string, { a: string; b: string; types: string[]; color: string; dashed: boolean; arrowTo: string | null }>();
  for (const r of relations) {
    const [a, b] = [r.fromId, r.toId].sort();
    const found = pairs.get(`${a}|${b}`);
    if (found) { found.types.push(r.type); found.dashed &&= r.certainty !== 'explicit'; }
    else pairs.set(`${a}|${b}`, { a, b, types: [r.type], color: relationColor(r.type), dashed: r.certainty !== 'explicit', arrowTo: isDirectedType(r.type) ? r.toId : null });
  }
  const edges = [...pairs.values()].map((e) => {
    // La línea sale de quien ya estaba y llega al que aparece.
    const [from, to] = born.get(e.a)! <= born.get(e.b)! ? [e.a, e.b] : [e.b, e.a];
    const tree = parent.get(to) === from;
    return { ...e, from, to, tree, start: tree ? born.get(to)! : born.get(to)! + TRAVEL };
  });
  const showEdgeLabels = edges.length <= 18;
  const names = new Map(characters.map((c) => [c.id, c.name]));

  // Lugar de cada etiqueta a lo largo de su línea, sin pisar personajes ni otras etiquetas.
  const taken = ids.flatMap((id) => {
    const p = position.get(id)!;
    return [{ x: p.x, y: p.y, w: radius * 2, h: radius * 2 }, { x: p.x, y: p.y + radius + 28, w: radius * 2.3, h: 44 }];
  });
  const labelSpot = new Map<(typeof edges)[number], number>();
  for (const edge of edges) {
    const a = position.get(edge.from)!, b = position.get(edge.to)!;
    const w = Math.min(220, edge.types.join(' · ').length * 11 + 22);
    for (const at of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75]) {
      const box = { x: a.x + (b.x - a.x) * at, y: a.y + (b.y - a.y) * at, w, h: 34 };
      if (taken.some((o) => Math.abs(o.x - box.x) * 2 < o.w + box.w && Math.abs(o.y - box.y) * 2 < o.h + box.h)) continue;
      taken.push(box);
      labelSpot.set(edge, at);
      break;
    }
  }

  // Leyenda por color: explica las líneas que no tienen lugar para su etiqueta.
  const legend = new Map<string, string>();
  for (const edge of edges) for (const type of edge.types) {
    const color = relationColor(type);
    if (!legend.has(color)) legend.set(color, color === relationColor('Familiar') ? 'Familia' : type);
  }

  function nodeAt(id: string, t: number): Point & { progress: number } {
    const target = position.get(id)!;
    const progress = clamp01((t - born.get(id)!) / TRAVEL);
    const from = parent.get(id) ? position.get(parent.get(id)!)! : { x: SIZE / 2, y: top + areaHeight / 2 };
    const move = easeOut(progress);
    const i = ids.indexOf(id);
    const float = clamp01((t - born.get(id)! - TRAVEL) / 600) * 4;
    return {
      x: from.x + (target.x - from.x) * move + Math.sin(t / 900 + i * 1.7) * float,
      y: from.y + (target.y - from.y) * move + Math.cos(t / 1100 + i * 2.3) * float,
      progress,
    };
  }

  function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
    return `${cut.trimEnd()}…`;
  }

  /** Nombres largos en hasta dos renglones. */
  function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    if (ctx.measureText(text).width <= maxWidth) return [text];
    const words = text.split(/\s+/);
    let first = words.shift()!;
    while (words.length > 1 && ctx.measureText(`${first} ${words[0]}`).width <= maxWidth) first += ` ${words.shift()}`;
    return [fit(ctx, first, maxWidth), ...(words.length ? [fit(ctx, words.join(' '), maxWidth)] : [])];
  }

  function draw(ctx: CanvasRenderingContext2D, t: number) {
    const scale = ctx.canvas.width / SIZE;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#cdb783';
    ctx.font = `600 28px ${FONT}`;
    ctx.fillText('LA RED DE PERSONAJES DE', SIZE / 2, 70);
    ctx.fillStyle = '#f4f0e7';
    ctx.font = `700 58px ${SERIF}`;
    ctx.fillText(fit(ctx, network.bookTitle, SIZE - 100), SIZE / 2, 132);

    const drawn = edges.map((e) => {
      const p = clamp01((t - e.start) / (e.tree ? TRAVEL : 500));
      if (!p) return null;
      const a = nodeAt(e.from, t), b = nodeAt(e.to, t);
      const end = e.tree ? b : { x: a.x + (b.x - a.x) * easeOut(p), y: a.y + (b.y - a.y) * easeOut(p) };
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 5;
      ctx.setLineDash(e.dashed ? [14, 11] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      // Destello que viaja por la línea mientras se dibuja.
      if (p < 1) {
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff7de';
        ctx.beginPath();
        ctx.arc(end.x, end.y, 8, 0, Math.PI * 2);
        ctx.fill();
      }
      if (e.arrowTo && p === 1) {
        const [tail, head] = e.arrowTo === e.to ? [a, b] : [b, a];
        const angle = Math.atan2(head.y - tail.y, head.x - tail.x);
        ctx.save();
        ctx.translate(head.x - Math.cos(angle) * (radius + 6), head.y - Math.sin(angle) * (radius + 6));
        ctx.rotate(angle);
        ctx.globalAlpha = 1;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-22, -12);
        ctx.lineTo(-22, 12);
        ctx.fill();
        ctx.restore();
      }
      const at = labelSpot.get(e);
      return { e, p, at, x: a.x + (b.x - a.x) * (at ?? 0.5), y: a.y + (b.y - a.y) * (at ?? 0.5) };
    });
    ctx.setLineDash([]);

    if (showEdgeLabels) for (const item of drawn) {
      if (!item || item.p < 1 || item.at === undefined) continue;
      ctx.globalAlpha = clamp01((t - item.e.start - TRAVEL) / 350);
      ctx.font = `600 21px ${FONT}`;
      const label = fit(ctx, item.e.types.join(' · '), 220);
      const w = ctx.measureText(label).width + 22;
      ctx.fillStyle = BACKGROUND;
      ctx.beginPath();
      ctx.roundRect(item.x - w / 2, item.y - 17, w, 34, 17);
      ctx.fill();
      ctx.fillStyle = item.e.color;
      ctx.fillText(label, item.x, item.y + 1);
    }

    for (const { id } of order) {
      if (t < born.get(id)!) continue;
      const p = nodeAt(id, t);
      const size = radius * pop((t - born.get(id)!) / 450);
      const hue = (ids.indexOf(id) * 47 + 35) % 360;
      ctx.globalAlpha = 1;
      // Onda al aparecer.
      if (p.progress < 1) {
        ctx.strokeStyle = `hsl(${hue} 70% 75%)`;
        ctx.globalAlpha = 1 - p.progress;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + p.progress * 50, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = `hsl(${hue} 32% 36%)`;
      ctx.strokeStyle = `hsl(${hue} 60% 74%)`;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, size), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      const name = names.get(id)!.trim();
      const initials = name.split(/\s+/).slice(0, 2).map((w) => [...w][0]).join('').toLocaleUpperCase();
      ctx.fillStyle = '#fffaf0';
      ctx.font = `700 ${Math.round(size * 0.72)}px ${SERIF}`;
      ctx.fillText(initials, p.x, p.y + 2);
      const fontSize = n <= 14 ? 26 : 21;
      ctx.font = `700 ${fontSize}px ${FONT}`;
      ctx.globalAlpha = clamp01((t - born.get(id)! - 250) / 300);
      ctx.lineWidth = 7;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = BACKGROUND;
      wrap(ctx, name, radius * 3.1).forEach((line, row) => {
        const y = p.y + radius + fontSize * (0.8 + row * 1.05);
        ctx.strokeText(line, p.x, y);
        ctx.fillText(line, p.x, y);
      });
    }

    ctx.globalAlpha = 1;
    const shownNodes = order.filter((s) => t >= born.get(s.id)!).length;
    const shownLinks = edges.filter((e) => t >= e.start).reduce((sum, e) => sum + e.types.length, 0);
    ctx.fillStyle = '#c4c9bd';
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText(`${shownNodes} personaje${shownNodes === 1 ? '' : 's'}  ·  ${shownLinks} vínculo${shownLinks === 1 ? '' : 's'}`, SIZE / 2, 947);

    ctx.font = `600 24px ${FONT}`;
    const items = [...legend].slice(0, 6).map(([color, text]) => {
      const label = fit(ctx, text, 150);
      return { color, label, width: ctx.measureText(label).width + 28 };
    });
    const total = items.reduce((sum, item) => sum + item.width + 26, -26);
    const shrink = Math.min(1, (SIZE - 60) / Math.max(1, total));
    ctx.save();
    ctx.translate(SIZE / 2 - (total * shrink) / 2, 903);
    ctx.scale(shrink, shrink);
    ctx.textAlign = 'left';
    let x = 0;
    for (const item of items) {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(x + 9, 0, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(item.label, x + 28, 1);
      x += item.width + 26;
    }
    ctx.restore();

    const cta = easeOut((t - built) / 600);
    if (cta > 0) {
      ctx.globalAlpha = cta;
      ctx.fillStyle = '#cdb783';
      ctx.beginPath();
      ctx.roundRect(60, 978 + (1 - cta) * 30, SIZE - 120, 70, 35);
      ctx.fill();
      ctx.fillStyle = '#1c211f';
      ctx.font = `700 30px ${FONT}`;
      ctx.fillText(`Armá la tuya en Librarium · ${APP_URL}`, SIZE / 2, 1014 + (1 - cta) * 30);
      ctx.globalAlpha = 1;
    }
  }

  return { draw, duration, hidden: network.characters.length - n };
}

type Scene = ReturnType<typeof createScene>;

export async function renderGif(scene: Scene, onProgress: (ratio: number) => void, cancelled: () => boolean): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = GIF_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const grab = (t: number) => { scene.draw(ctx, t); return ctx.getImageData(0, 0, GIF_SIZE, GIF_SIZE).data; };
  const palette = buildPalette([0.25, 0.5, 0.7, 1].map((f) => grab(scene.duration * f)));
  const gif = new GifEncoder(GIF_SIZE, GIF_SIZE, palette);
  const delay = 1000 / GIF_FPS;
  // El primer cuadro es la red completa: es la miniatura que se ve antes de reproducir.
  gif.addFrame(grab(scene.duration), 600);
  const frames = Math.ceil((scene.duration - 1800) / delay);
  for (let i = 0; i < frames; i++) {
    if (cancelled()) return null;
    gif.addFrame(grab(i * delay), delay);
    if (i % 4 === 0) { onProgress(i / frames); await new Promise((resolve) => setTimeout(resolve)); }
  }
  gif.addFrame(grab(scene.duration), 2500);
  return new Blob([gif.finish()], { type: 'image/gif' });
}

function videoType(): string {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return '';
  return ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

export function openNetworkShare(network: ShareNetwork) {
  const scene = createScene(network);
  const mime = videoType();
  const dialog = document.createElement('dialog');
  dialog.className = 'chrx';
  dialog.setAttribute('aria-label', 'Animación de la red de personajes');
  dialog.innerHTML = `<div class="chrx-body">
    <canvas width="${SIZE}" height="${SIZE}" role="img" aria-label="La red de personajes formándose"></canvas>
    <div class="chrx-actions">
      <button type="button" data-x="replay">↻ Repetir</button>
      ${mime ? '<button type="button" data-x="video" class="chrx-main">🎬 Crear video</button>' : ''}
      <button type="button" data-x="gif">Crear GIF</button>
      <button type="button" data-x="close">Cerrar</button>
    </div>
    <p class="chrx-status" role="status"></p>
    <div class="chrx-result" hidden><button type="button" data-x="share" class="chrx-main">Compartir</button><a download>Descargar</a></div>
    <p class="chrx-note">Antes de compartir: los nombres y vínculos pueden contener spoilers.${scene.hidden > 0 ? ` Se muestran los ${MAX_NODES} personajes más conectados.` : ''}</p>
  </div>`;
  document.body.append(dialog);

  const canvas = dialog.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  const status = dialog.querySelector<HTMLElement>('.chrx-status')!;
  const result = dialog.querySelector<HTMLElement>('.chrx-result')!;
  const link = result.querySelector('a')!;
  const shareButton = result.querySelector<HTMLButtonElement>('button')!;
  let frame = 0, closed = false, busy = false, url = '', file: File | null = null;
  let recorder: MediaRecorder | null = null;

  const play = (onEnd?: () => void) => {
    cancelAnimationFrame(frame);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.max(0, now - start);
      scene.draw(ctx, Math.min(t, scene.duration));
      if (t < scene.duration) frame = requestAnimationFrame(tick);
      else onEnd?.();
    };
    frame = requestAnimationFrame(tick);
  };

  const setBusy = (value: boolean) => {
    busy = value;
    dialog.querySelectorAll<HTMLButtonElement>('[data-x=replay],[data-x=video],[data-x=gif]').forEach((b) => { b.disabled = value; });
  };

  const deliver = (blob: Blob, extension: string) => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    const slug = network.bookTitle.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'libro';
    file = new File([blob], `red-${slug}.${extension}`, { type: blob.type });
    link.href = url;
    link.download = file.name;
    shareButton.hidden = !navigator.canShare?.({ files: [file] });
    result.hidden = false;
    const warning = extension === 'webm' ? ' Este navegador graba en WebM y WhatsApp puede no aceptarlo: probá con el GIF o con otro navegador.' : '';
    status.textContent = `Listo: ${file.name} (${(blob.size / 1048576).toFixed(1)} MB).${warning}`;
  };

  const recordVideo = () => {
    setBusy(true);
    result.hidden = true;
    status.textContent = 'Grabando… dejá esta pantalla abierta.';
    scene.draw(ctx, 0);
    const chunks: Blob[] = [];
    try {
      const stream = canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (closed) return;
        setBusy(false);
        if (!chunks.length) { status.textContent = 'No se pudo grabar el video. Probá con el GIF.'; return; }
        const type = mime.split(';')[0];
        deliver(new Blob(chunks, { type }), type === 'video/mp4' ? 'mp4' : 'webm');
      };
      recorder.start();
      play(() => setTimeout(() => recorder?.state === 'recording' && recorder.stop(), 200));
    } catch {
      setBusy(false);
      status.textContent = 'No se pudo grabar el video en este navegador. Probá con el GIF.';
    }
  };

  const makeGif = async () => {
    setBusy(true);
    result.hidden = true;
    cancelAnimationFrame(frame);
    try {
      const blob = await renderGif(scene, (ratio) => { status.textContent = `Armando el GIF… ${Math.round(ratio * 100)}%`; }, () => closed);
      if (blob) deliver(blob, 'gif');
    } catch {
      status.textContent = 'No se pudo crear el GIF en este dispositivo.';
    }
    setBusy(false);
    scene.draw(ctx, scene.duration);
  };

  dialog.addEventListener('click', async (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-x]')?.dataset.x;
    if (action === 'close') dialog.close();
    else if (action === 'share' && file) {
      try { await navigator.share({ files: [file], text: `La red de personajes de «${network.bookTitle}», hecha con Librarium: https://${APP_URL}/` }); }
      catch (err: any) { if (err?.name !== 'AbortError') status.textContent = 'No se pudo compartir. Usá «Descargar» y adjuntá el archivo en WhatsApp.'; }
    } else if (!busy && action === 'replay') play();
    else if (!busy && action === 'video') recordVideo();
    else if (!busy && action === 'gif') void makeGif();
  });
  dialog.addEventListener('close', () => {
    closed = true;
    cancelAnimationFrame(frame);
    if (recorder?.state === 'recording') recorder.stop();
    if (url) URL.revokeObjectURL(url);
    dialog.remove();
  });

  dialog.showModal();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) scene.draw(ctx, scene.duration);
  else play();
}

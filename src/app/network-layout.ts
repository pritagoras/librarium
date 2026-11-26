/**
 * Lógica pura de la red de personajes: distribución de nodos y orden en que se "forma"
 * la red en la animación. Sin DOM, para poder probarla.
 */
export interface LayoutEdge { fromId: string; toId: string }
export interface Point { x: number; y: number }
export interface LayoutBox { width: number; height: number; padding: number; minDistance: number }

function adjacency(ids: string[], edges: LayoutEdge[]): Map<string, Set<string>> {
  const map = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const { fromId, toId } of edges) {
    if (fromId === toId || !map.has(fromId) || !map.has(toId)) continue;
    map.get(fromId)!.add(toId);
    map.get(toId)!.add(fromId);
  }
  return map;
}

export interface GrowthStep { id: string; parentId: string | null }

/** Orden de aparición: arranca en el más conectado de cada grupo y avanza por sus vínculos. */
export function growthOrder(ids: string[], edges: LayoutEdge[]): GrowthStep[] {
  const links = adjacency(ids, edges);
  const byDegree = [...ids].sort((a, b) => links.get(b)!.size - links.get(a)!.size);
  const seen = new Set<string>();
  const order: GrowthStep[] = [];
  for (const root of byDegree) {
    if (seen.has(root)) continue;
    seen.add(root);
    const queue: GrowthStep[] = [{ id: root, parentId: null }];
    for (let i = 0; i < queue.length; i++) {
      const { id } = queue[i];
      for (const next of byDegree) {
        if (seen.has(next) || !links.get(id)!.has(next)) continue;
        seen.add(next);
        queue.push({ id: next, parentId: id });
      }
    }
    order.push(...queue);
  }
  return order;
}

/** Distribución por fuerzas (determinista), ajustada a la caja y sin nodos superpuestos. */
export function computeLayout(ids: string[], edges: LayoutEdge[], box: LayoutBox): Map<string, Point> {
  const { width, height, padding, minDistance } = box;
  const n = ids.length;
  if (!n) return new Map();
  if (n === 1) return new Map([[ids[0], { x: width / 2, y: height / 2 }]]);
  const links = adjacency(ids, edges);
  const order = growthOrder(ids, edges);
  // Posición inicial en espiral siguiendo los vínculos: los vecinos empiezan cerca.
  const points = new Map<string, Point>(order.map(({ id }, i) => {
    const angle = i * 2.399963;
    const radius = Math.sqrt((i + 0.5) / n);
    return [id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }];
  }));
  const list = ids.map((id) => points.get(id)!);
  const pairs: Array<[Point, Point]> = [];
  for (const [id, others] of links) for (const other of others) if (id < other) pairs.push([points.get(id)!, points.get(other)!]);

  const k = Math.sqrt(3 / n);
  const iterations = Math.max(60, Math.min(400, Math.floor(600000 / (n * n))));
  for (let step = 0; step < iterations; step++) {
    const shift = list.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = list[i].x - list[j].x, dy = list[i].y - list[j].y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (k * k) / (d * d);
      shift[i].x += dx * f; shift[i].y += dy * f;
      shift[j].x -= dx * f; shift[j].y -= dy * f;
    }
    const index = new Map(list.map((p, i) => [p, i]));
    for (const [a, b] of pairs) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const f = Math.hypot(dx, dy) / k;
      const i = index.get(a)!, j = index.get(b)!;
      shift[i].x += dx * f; shift[i].y += dy * f;
      shift[j].x -= dx * f; shift[j].y -= dy * f;
    }
    const temperature = 0.12 * (1 - step / iterations) + 0.002;
    list.forEach((p, i) => {
      // Gravedad suave: evita que los grupos sueltos y aislados se vayan lejos.
      const sx = shift[i].x - p.x * 0.9, sy = shift[i].y - p.y * 0.9;
      const d = Math.max(0.000001, Math.hypot(sx, sy));
      p.x += (sx / d) * Math.min(d, temperature);
      p.y += (sy / d) * Math.min(d, temperature);
    });
  }

  // Escalar a la caja.
  const xs = list.map((p) => p.x), ys = list.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX, spanY = maxY - minY;
  for (const p of list) {
    p.x = spanX > 1e-6 ? padding + ((p.x - minX) / spanX) * (width - padding * 2) : width / 2;
    p.y = spanY > 1e-6 ? padding + ((p.y - minY) / spanY) * (height - padding * 2) : height / 2;
  }
  // Separar los que quedaron encimados.
  const clamp = (v: number, max: number) => Math.max(padding, Math.min(max - padding, v));
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = list[i], b = list[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d >= minDistance) continue;
      if (d < 0.01) { dx = Math.cos(i + j); dy = Math.sin(i + j); d = 1; }
      const push = (minDistance - d) / 2 + 0.5;
      a.x = clamp(a.x - (dx / d) * push, width); a.y = clamp(a.y - (dy / d) * push, height);
      b.x = clamp(b.x + (dx / d) * push, width); b.y = clamp(b.y + (dy / d) * push, height);
      moved = true;
    }
    // Apartar los nodos que quedaron sobre una línea ajena.
    const clearance = minDistance * 0.55;
    for (const [id, p] of points) for (const [fromId, others] of links) for (const toId of others) {
      if (fromId >= toId || id === fromId || id === toId) continue;
      const a = points.get(fromId)!, b = points.get(toId)!;
      const lx = b.x - a.x, ly = b.y - a.y;
      const along = ((p.x - a.x) * lx + (p.y - a.y) * ly) / Math.max(1, lx * lx + ly * ly);
      if (along <= 0.05 || along >= 0.95) continue;
      let dx = p.x - (a.x + lx * along), dy = p.y - (a.y + ly * along);
      let d = Math.hypot(dx, dy);
      if (d >= clearance) continue;
      if (d < 0.5) { dx = -ly; dy = lx; d = Math.hypot(dx, dy) || 1; }
      const push = Math.min(10, clearance - Math.hypot(p.x - (a.x + lx * along), p.y - (a.y + ly * along)));
      const x = clamp(p.x + (dx / d) * push, width), y = clamp(p.y + (dy / d) * push, height);
      if (Math.hypot(x - p.x, y - p.y) > 0.5) { p.x = x; p.y = y; moved = true; }
    }
    if (!moved) break;
  }
  for (let pass = 0; pass < 40; pass++) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = list[i], b = list[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d >= minDistance || d < 0.01) continue;
      const push = (minDistance - d) / 2 + 0.5;
      a.x = clamp(a.x - (dx / d) * push, width); a.y = clamp(a.y - (dy / d) * push, height);
      b.x = clamp(b.x + (dx / d) * push, width); b.y = clamp(b.y + (dy / d) * push, height);
    }
  }
  return points;
}

/** Personajes · Dibujo de la red de relaciones. */
import type { Character, CharacterRelation } from '../../types';
import { CERTAINTY_LABELS, isDirectedType, neighborsOf } from '../characters-model';
import { computeLayout } from '../network-layout';
import { relationColor } from '../network-share';
import { characterById, data, esc, state } from './context';
import { groundingToggleHTML } from './gemini';
import { growthHTML } from './growth';
import { networkReviewHTML } from './network-review';
import { relationCount } from './views';

// ---------------------------------------------------------------------------
// Red de relaciones
// ---------------------------------------------------------------------------

function mostConnected(): string | null {
  let best: { id: string; n: number } | null = null;
  for (const c of data.characters) {
    const n = relationCount(c.id);
    if (!best || n > best.n) best = { id: c.id, n };
  }
  return best?.id ?? null;
}

function layoutGlobalGraph() {
  const ids = data.characters.map((c) => c.id);
  const size = Math.max(760, Math.ceil(210 * Math.sqrt(ids.length)));
  // En pantallas angostas la red se reparte en vertical, para que entre entera y se lea.
  const narrow = window.matchMedia('(max-width: 620px)').matches;
  const width = narrow ? Math.round(size * 0.74) : size;
  const height = narrow ? Math.round(size * 1.15) : size;
  const positions = computeLayout(ids, data.relations, { width, height, padding: 60, minDistance: narrow ? 125 : 150 });
  return { positions };
}

/** Al 100 % encuadra todos los personajes; con zoom recorta alrededor del enfocado. */
function networkViewBox(positions: Map<string, { x: number; y: number }>, focusId: string, zoom: number): string {
  const points = [...positions.values()];
  const margin = 80;
  const left = Math.min(...points.map((p) => p.x)) - margin;
  const top = Math.min(...points.map((p) => p.y)) - margin;
  const width = Math.max(360, Math.max(...points.map((p) => p.x)) + margin - left);
  const height = Math.max(360, Math.max(...points.map((p) => p.y)) + margin - top);
  const scale = Math.max(1, Math.min(3, zoom));
  const w = width / scale, h = height / scale;
  const centerX = (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2;
  const centerY = (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2;
  const focus = scale > 1 ? positions.get(focusId) : undefined;
  const x = focus ? Math.max(left, Math.min(left + width - w, focus.x - w / 2)) : centerX - w / 2;
  const y = focus ? Math.max(top, Math.min(top + height - h, focus.y - h / 2)) : centerY - h / 2;
  return `${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
}

/** Líneas con flecha (vínculos con dirección) y su tipo escrito, evitando pisar personajes u otras etiquetas. */
function globalEdgesSVG(positions: Map<string, { x: number; y: number }>): string {
  const pairs = new Map<string, CharacterRelation[]>();
  for (const r of data.relations) {
    const key = [r.fromId, r.toId].sort().join('|');
    pairs.set(key, [...(pairs.get(key) || []), r]);
  }
  const taken = [...positions.values()].map((p) => ({ x: p.x, y: p.y, w: 72, h: 72 }));
  let lines = '', labels = '';
  for (const group of pairs.values()) {
    const main = group.find((r) => isDirectedType(r.type)) ?? group[0];
    const a = positions.get(main.fromId), b = positions.get(main.toId);
    if (!a || !b) continue;
    const filtered = state.netIsolatedOnly ? ' chr-edge--filtered' : '';
    const color = relationColor(main.type);
    const dashed = group.some((r) => r.certainty === 'explicit') ? '' : ' stroke-dasharray="7 6"';
    const title = group.map((r) => `${characterById(r.fromId)?.name} ${isDirectedType(r.type) ? '→' : '↔'} ${characterById(r.toId)?.name} · ${r.type} · ${CERTAINTY_LABELS[r.certainty]}`).join(' / ');
    lines += `<path class="chr-edge chr-edge--color${filtered}" d="M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${b.x.toFixed(1)} ${b.y.toFixed(1)}" style="stroke:${color}"${dashed}><title>${esc(title)}</title></path>`;
    if (state.netIsolatedOnly) continue;
    if (isDirectedType(main.type)) {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      lines += `<path class="chr-edge-arrow" d="M 0 0 L -12 -7 L -12 7 Z" fill="${color}" transform="translate(${(b.x - Math.cos(angle) * 38).toFixed(1)} ${(b.y - Math.sin(angle) * 38).toFixed(1)}) rotate(${((angle * 180) / Math.PI).toFixed(1)})"></path>`;
    }
    const text = [...new Set(group.map((r) => r.type))].join(' · ');
    const label = text.length > 28 ? `${text.slice(0, 27)}…` : text;
    const width = label.length * 6.4 + 10;
    const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: width, h: 18 });
    const box = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74].map(at).find((c) => !taken.some((o) => Math.abs(o.x - c.x) * 2 < o.w + c.w && Math.abs(o.y - c.y) * 2 < o.h + c.h)) ?? at(0.5);
    taken.push(box);
    labels += `<text class="chr-edge-type" x="${box.x.toFixed(1)}" y="${(box.y + 4).toFixed(1)}" text-anchor="middle" fill="${color}">${esc(label)}</text>`;
  }
  return lines + labels;
}

export function networkHTML(): string {
  if (!data.characters.length) return '<p class="empty-inline">Cargá personajes y vínculos para ver la red de relaciones.</p>';
  if (!characterById(state.netFocus)) state.netFocus = characterById(state.selectedId)?.id ?? mostConnected();
  const focusId = state.netFocus!;
  const { positions } = layoutGlobalGraph();
  const viewBox = networkViewBox(positions, focusId, state.netZoom);
  const selected = characterById(state.netSelected);
  const isolated = data.characters.filter((c) => relationCount(c.id) === 0).length;
  const connected = data.characters.length - isolated;
  const edgeSvg = globalEdgesSVG(positions);
  const nodesSvg = data.characters.map((c, i) => {
    const p = positions.get(c.id)!;
    const focus = c.id === focusId;
    const isolatedClass = relationCount(c.id) === 0 ? ' chr-node--isolated' : '';
    const label = c.name.length > 18 ? `${c.name.slice(0, 17)}…` : c.name;
    return `<g class="chr-node chr-node--global${focus ? ' chr-node--focus' : ''}${c.id === state.netSelected ? ' chr-node--selected' : ''}${isolatedClass}${state.netIsolatedOnly && relationCount(c.id) ? ' chr-node--filtered' : ''}" data-chr="net-select" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.name)}, ${relationCount(c.id)} vínculos" style="--node-delay:${Math.min(i * 55, 900)}ms"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${focus ? 36 : 29}"></circle><text x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle">${esc(label)}</text></g>`;
  }).join('');
  const types = [...new Set(data.relations.map((r) => r.type))];
  const allGroups = buildConnectedGroups(data.characters, data.relations);
  const detail = selected ? `<aside class="chr-net-details" role="region" aria-label="Detalles de ${esc(selected.name)}" tabindex="-1"><strong>${esc(selected.name)}</strong><span>${relationCount(selected.id)} vínculos · ${isolated && relationCount(selected.id) === 0 ? 'personaje aislado' : `grupo ${allGroups.findIndex((g) => g.includes(selected.id)) + 1}`}</span><div class="chr-row-actions"><button type="button" class="secondary" data-chr="open" data-id="${esc(selected.id)}">Abrir ficha</button><button type="button" class="secondary" data-chr="add-relation">＋ Agregar vínculo</button></div>${data.relations.filter((r) => r.fromId === selected.id || r.toId === selected.id).map((r) => `<div class="chr-net-rel"><span class="chr-net-dot" style="--edge-color:${relationColor(r.type)}"></span>${esc(characterById(r.fromId)?.name)} ${isDirectedType(r.type) ? '→' : '↔'} ${esc(characterById(r.toId)?.name)} · ${esc(r.type)} <button type="button" class="secondary" data-chr="edit-relation" data-rel="${esc(r.id)}">Editar</button></div>`).join('')}</aside>` : '<p class="muted">Seleccioná cualquier personaje para abrir su ficha o administrar vínculos.</p>';
  const mobilePeople = `<div class="chr-net-mobile-people"><h4>Personajes</h4><div>${data.characters.map((c) => `<button type="button" data-chr="net-select" data-id="${esc(c.id)}" class="${c.id === state.netSelected ? 'active' : ''}"><strong>${esc(c.name)}</strong><span>${relationCount(c.id)} vínculos</span></button>`).join('')}</div></div>`;
  return `<div class="chr-network chr-network--global"><div class="chr-network-header"><div><h3>Red de personajes</h3><p>${data.characters.length} personajes · ${data.relations.length} vínculos</p></div><label for="chrNetFocus">Enfocar personaje<select id="chrNetFocus">${data.characters.map((c) => `<option value="${esc(c.id)}" ${c.id === focusId ? 'selected' : ''}>${esc(c.name)} (${relationCount(c.id)})</option>`).join('')}</select></label><button type="button" class="primary" data-chr="analyze-network">✦ Analizar red con IA</button><details class="chr-net-more"><summary>Más acciones ▾</summary><div><button type="button" class="secondary" data-chr="fullscreen-network" aria-pressed="false">⛶ Pantalla completa</button><button type="button" class="secondary" data-chr="grow-network">＋ Sumar personajes y vínculos</button><button type="button" class="secondary" data-chr="animate-network">Animar y compartir la red</button>${groundingToggleHTML()}</div></details></div>${growthHTML()}<div class="chr-net-stats">${isolated ? `<button type="button" data-chr="filter-isolated" aria-label="Mostrar solo personajes aislados" aria-pressed="${state.netIsolatedOnly}">${isolated} aislados</button>` : `<span>0 aislados</span>`}<span>${connected} conectados</span><span>${allGroups.length} grupos independientes</span></div><p class="chr-net-hint">Seleccioná un personaje para ver su ficha y sus vínculos.</p><div class="chr-net-canvas"><div class="chr-net-zoom" role="group" aria-label="Zoom del mapa"><button type="button" class="secondary" data-chr="net-zoom-out" aria-label="Alejar" ${state.netZoom <= 1 ? 'disabled' : ''}>−</button><output aria-live="polite">${Math.round(state.netZoom * 100)}%</output><button type="button" class="secondary" data-chr="net-zoom-in" aria-label="Acercar" ${state.netZoom >= 3 ? 'disabled' : ''}>+</button><button type="button" class="secondary" data-chr="net-zoom-reset" aria-label="Ajustar mapa">Ajustar</button></div><svg class="chr-svg chr-svg--global" viewBox="${viewBox}" role="group" aria-label="Mapa global con todos los personajes y vínculos">${edgeSvg}${nodesSvg}</svg></div>${mobilePeople}<div class="chr-net-legend">${types.map((type) => `<span><i style="--edge-color:${relationColor(type)}"></i>${esc(type)}</span>`).join('')}<span><i class="chr-net-certainty"></i>Continua: explícita · discontinua: inferida o desconocida</span></div>${detail}${networkReviewHTML()}</div>`;
}

function buildConnectedGroups(characters: Character[], relations: CharacterRelation[]): string[][] {
  const remaining = new Set(characters.map((c) => c.id));
  const groups: string[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value as string;
    const group: string[] = [], queue = [first]; remaining.delete(first);
    while (queue.length) {
      const id = queue.shift()!; group.push(id);
      for (const neighbor of neighborsOf(relations, id)) if (remaining.delete(neighbor.other)) queue.push(neighbor.other);
    }
    groups.push(group);
  }
  return groups;
}

/** Personajes · Índice (lista, tabla), ficha y sus partes. */
import type { Certainty, Character, CharacterFieldKey, CharacterRelation, EvidenceRef } from '../../types';
import { CERTAINTY_LABELS, EVIDENCE_LABELS, FIELD_KEYS, FIELD_LABELS, neighborsOf, searchCharacters } from '../characters-model';
import { AI_SPARK, characterById, data, esc, state, type IndexView } from './context';
import { familyReviewHTML } from './family';
import { networkHTML } from './network-view';

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

function certaintyBadge(certainty: Certainty | undefined): string {
  const value = certainty ?? 'unknown';
  return `<span class="chr-badge chr-badge--${value}">${esc(CERTAINTY_LABELS[value])}</span>`;
}

export function relationCount(id: string): number {
  return neighborsOf(data.relations, id).length;
}

export function indexHTML(): string {
  const views: Array<[IndexView, string]> = [['list', 'Lista'], ['table', 'Tabla'], ['network', 'Red']];
  return `<div class="content-heading">
      <div>
        <h2 id="chrHeading" tabindex="-1">Personajes</h2>
        <p class="muted">Fichas y vínculos entre los personajes de este libro.</p>
      </div>
      <div class="content-heading-actions">
        <button type="button" class="primary" data-chr="new">＋ Nuevo personaje</button>
      </div>
    </div>
    ${state.notice ? `<p class="chr-notice" role="status">${esc(state.notice)}</p>` : ''}
    <div class="chr-toolbar">
      ${state.view === 'network' ? '' : `<label class="chr-search">
        <span class="chr-sr-only">Buscar personajes</span>
        <input type="search" id="chrSearch" placeholder="Buscar por nombre, alias, rasgo u ocupación" value="${esc(state.query)}" autocomplete="off" />
      </label>`}
      <div class="chr-view-toggle" role="group" aria-label="Vista de personajes">
        ${views.map(([key, label]) => `<button type="button" data-chr="view" data-view="${key}" aria-pressed="${state.view === key}" class="${state.view === key ? 'active' : ''}">${label}</button>`).join('')}
      </div>
    </div>
    <div id="chrResults">${resultsHTML()}</div>`;
}

export function resultsHTML(): string {
  if (state.view === 'network') return networkHTML();
  if (!data.characters.length) {
    return '<p class="empty-inline">Todavía no cargaste personajes de este libro. Creá la primera ficha con «＋ Nuevo personaje».</p>';
  }
  const found = searchCharacters(data.characters, state.query);
  if (!found.length) return '<p class="empty-inline" role="status">Ningún personaje coincide con la búsqueda.</p>';
  const count = `<p class="muted chr-count" role="status">${found.length} de ${data.characters.length} personaje${data.characters.length === 1 ? '' : 's'}</p>`;
  if (state.view === 'table') {
    return `${count}<div class="chr-table-wrap"><table class="chr-table">
      <caption class="chr-sr-only">Personajes del libro</caption>
      <thead><tr><th scope="col">Nombre</th><th scope="col">Edad</th><th scope="col">Ocupación</th><th scope="col">Pertenencia</th><th scope="col">Vínculos</th></tr></thead>
      <tbody>${found
        .map(
          (c) => `<tr>
        <th scope="row"><button type="button" class="chr-link" data-chr="open" data-id="${esc(c.id)}">${esc(c.name)}</button></th>
        <td>${esc(c.age) || '<span class="chr-unknown">—</span>'}</td>
        <td>${esc(c.occupation) || '<span class="chr-unknown">—</span>'}</td>
        <td>${esc(c.affiliation) || '<span class="chr-unknown">—</span>'}</td>
        <td>${relationCount(c.id)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  }
  return `${count}<ul class="chr-list">${found
    .map((c) => {
      const meta = [c.occupation, c.affiliation].filter(Boolean).join(' · ');
      const links = relationCount(c.id);
      return `<li><button type="button" class="chr-card" data-chr="open" data-id="${esc(c.id)}">
        <strong>${esc(c.name)}</strong>
        ${c.aliases.length ? `<span class="muted">También: ${esc(c.aliases.join(', '))}</span>` : ''}
        ${meta ? `<span class="muted">${esc(meta)}</span>` : ''}
        <span class="chr-card-links">${links} vínculo${links === 1 ? '' : 's'}</span>
      </button></li>`;
    })
    .join('')}</ul>`;
}

function fieldRow(character: Character, key: CharacterFieldKey): string {
  const value = character[key];
  return `<div class="chr-field">
    <dt>${FIELD_LABELS[key]}</dt>
    <dd>${
      value
        ? `<span class="chr-value">${esc(value)}</span> ${certaintyBadge(character.certainty[key])}`
        : '<span class="chr-unknown">Sin dato (desconocido)</span>'
    }</dd>
  </div>`;
}

function fieldAIOptionsHTML(): string {
  const options: Array<{ field: CharacterFieldKey | 'name'; label: string }> = [
    { field: 'name', label: 'Nombre y alias' },
    ...FIELD_KEYS.map((field) => ({ field, label: FIELD_LABELS[field] })),
  ];
  return `<details class="chr-field-ai-menu"><summary>${AI_SPARK} Consultar un dato con IA</summary><div>${options.map(({ field, label }) => `<button type="button" class="secondary" data-chr="ask" data-scope="field" data-field="${field}">${esc(label)}</button>`).join('')}</div></details>`;
}

function evidenceListHTML(items: EvidenceRef[]): string {
  if (!items.length) return '';
  return `<ul class="chr-evidence">${items
    .map(
      (ev) => `<li><strong>${esc(EVIDENCE_LABELS[ev.kind])}</strong>${ev.ref ? ` · ${/^https?:\/\//i.test(ev.ref) ? `<a href="${esc(ev.ref)}" target="_blank" rel="noopener noreferrer">${esc(ev.ref)}</a>` : esc(ev.ref)}` : ''}${ev.text ? `<br><span class="chr-quote">${/^https?:\/\//i.test(ev.text) ? `<a href="${esc(ev.text)}" target="_blank" rel="noopener noreferrer">${esc(ev.text)}</a>` : esc(ev.text)}</span>` : ''}</li>`,
    )
    .join('')}</ul>`;
}

function relationRowHTML(character: Character, relation: CharacterRelation): string {
  const otherId = relation.fromId === character.id ? relation.toId : relation.fromId;
  const other = characterById(otherId);
  if (!other) return '';
  const outgoing = relation.fromId === character.id;
  return `<li class="chr-relation">
    <div class="chr-relation-head">
      <span class="chr-type">${esc(relation.type)}</span>
      <button type="button" class="chr-link" data-chr="open" data-id="${esc(other.id)}" aria-label="Abrir la ficha de ${esc(other.name)}">${esc(outgoing ? `${character.name} → ${other.name}` : `${other.name} → ${character.name}`)}</button>
      ${certaintyBadge(relation.certainty)}
    </div>
    ${relation.description ? `<p class="chr-relation-text">${esc(relation.description)}</p>` : ''}
    ${evidenceListHTML(relation.evidence)}
    <div class="chr-row-actions">
      <button type="button" class="secondary" data-chr="ask" data-scope="relation" data-other="${esc(other.id)}" data-rel="${esc(relation.id)}" aria-label="Preguntar a la IA por el vínculo con ${esc(other.name)}">${AI_SPARK} IA</button>
      <button type="button" class="secondary" data-chr="edit-relation" data-rel="${esc(relation.id)}">Editar</button>
      <button type="button" class="secondary" data-chr="remove-relation" data-rel="${esc(relation.id)}" aria-label="Quitar el vínculo con ${esc(other.name)}">Quitar</button>
    </div>
  </li>`;
}

export function sheetHTML(character: Character): string {
  const links = neighborsOf(data.relations, character.id);
  const others = data.characters.filter((c) => c.id !== character.id);
  return `<p><button type="button" class="chr-back" data-chr="back">← Volver a personajes</button></p>
    <div class="content-heading">
      <div>
        <p class="eyebrow">FICHA DE PERSONAJE</p>
        <h2 id="chrHeading" tabindex="-1">${esc(character.name)}</h2>
        ${character.aliases.length ? `<p class="muted">También llamado: ${esc(character.aliases.join(', '))}</p>` : ''}
      </div>
      <div class="content-heading-actions">
        <button type="button" class="secondary" data-chr="ask" data-scope="character" aria-label="Preguntar a la IA sobre la ficha completa de ${esc(character.name)}">${AI_SPARK} Ficha completa con IA</button>
        <button type="button" class="secondary" data-chr="edit">Editar</button>
        <button type="button" class="danger-btn" data-chr="delete">Eliminar</button>
      </div>
    </div>
    ${state.notice ? `<p class="chr-notice" role="status">${esc(state.notice)}</p>` : ''}
    <div id="chrAiHost"></div>
    <section class="chr-section" aria-labelledby="chrFields">
      <div class="chr-section-head"><h3 id="chrFields">Datos</h3>${fieldAIOptionsHTML()}</div>
      <dl class="chr-fields">
        <div class="chr-field">
          <dt>Nombre</dt>
          <dd><span class="chr-value">${esc(character.name)}</span></dd>
        </div>
        ${FIELD_KEYS.map((key) => fieldRow(character, key)).join('')}
      </dl>
      ${character.traits.length ? `<p class="chr-traits"><span class="field-label">Rasgos</span> ${character.traits.map((t) => `<span class="chr-chip">${esc(t)}</span>`).join(' ')}</p>` : ''}
      ${character.comments ? `<div class="chr-comments"><span class="field-label">Comentarios y observaciones</span><p>${esc(character.comments)}</p></div>` : ''}
      ${character.evidence.length ? `<div><span class="field-label">Fuentes y evidencia</span>${evidenceListHTML(character.evidence)}</div>` : ''}
    </section>
    <section class="chr-section" aria-labelledby="chrRelations">
      <div class="chr-section-head">
        <h3 id="chrRelations">Vínculos (${links.length})</h3>
        <div class="chr-row-actions">
          <button type="button" class="secondary" data-chr="add-relation">＋ Añadir vínculo</button>
          <button type="button" class="secondary" data-chr="find-family">✦ Buscar familiares con IA</button>
          <button type="button" class="secondary" data-chr="show-network" ${links.length ? '' : 'disabled'}>Ver en la red</button>
        </div>
      </div>
      <div id="chrFamilyHost">${familyReviewHTML()}</div>
      ${others.length ? '' : '<p class="muted">Podés crear familiares y vínculos desde «Añadir vínculo» o buscarlos con IA.</p>'}
      ${links.length ? `<ul class="chr-relations">${links.map((n) => relationRowHTML(character, n.relation)).join('')}</ul>` : others.length ? '<p class="empty-inline">Todavía no registraste vínculos de este personaje.</p>' : ''}
      ${
        others.length
          ? `<div class="chr-pair">
        <label for="chrPairSelect">Consultar a la IA por el vínculo con otro personaje</label>
        <div class="chr-pair-row">
          <select id="chrPairSelect">${others.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
          <button type="button" class="secondary" data-chr="ask-pair">${AI_SPARK} Consultar vínculo</button>
        </div>
      </div>`
          : ''
      }
    </section>`;
}

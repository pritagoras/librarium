/** Personajes · Formularios de personaje y de vínculo. */
import type { Certainty, Character, CharacterFieldKey, EvidenceRef } from '../../types';
import { CERTAINTY_LABELS, EVIDENCE_KINDS, EVIDENCE_LABELS, FIELD_KEYS, FIELD_LABELS, LIMITS, RELATION_TYPES, type CharacterInput, validateCharacter, validateRelation } from '../characters-model';
import { characterSearchHTML } from './character-search';
import { AI_SPARK, api, book, characterById, data, esc, host, state } from './context';
import { groundingToggleHTML } from './gemini';
import { go, reload } from './render';
import { indexHTML } from './views';

// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------

function certaintySelectHTML(name: string, value: Certainty | undefined, options: { allowUnknown?: boolean; required?: boolean } = {}): string {
  const list: Certainty[] = options.allowUnknown ? ['unknown', 'explicit', 'inferred'] : ['explicit', 'inferred'];
  return `<select name="${name}" aria-label="Certeza del dato"${options.required ? ' required' : ''}>
    ${options.allowUnknown ? '' : `<option value="">Elegí si es explícito o inferido…</option>`}
    ${list.map((c) => `<option value="${c}" ${(value ?? (options.allowUnknown ? 'unknown' : undefined)) === c ? 'selected' : ''}>${CERTAINTY_LABELS[c]}</option>`).join('')}
  </select>`;
}

export function evidenceRowHTML(ev: EvidenceRef = { kind: 'page', ref: '', text: '' }): string {
  return `<div class="chr-evidence-row">
    <select data-f="kind" aria-label="Tipo de fuente">${EVIDENCE_KINDS.map((k) => `<option value="${k}" ${ev.kind === k ? 'selected' : ''}>${EVIDENCE_LABELS[k]}</option>`).join('')}</select>
    <input data-f="ref" type="text" maxlength="${LIMITS.evidenceRef}" placeholder="Página, capítulo o número" aria-label="Referencia de la fuente" value="${esc(ev.ref)}" />
    <input data-f="text" type="text" maxlength="${LIMITS.evidenceText}" placeholder="Cita o nota (opcional)" aria-label="Texto de la fuente" value="${esc(ev.text)}" />
    <button type="button" class="secondary" data-chr="remove-evidence" aria-label="Quitar esta fuente">✕</button>
  </div>`;
}

function evidenceEditorHTML(items: EvidenceRef[]): string {
  return `<fieldset class="chr-fieldset"><legend>Fuentes o evidencia</legend>
    <div id="chrEvidenceRows">${items.map((ev) => evidenceRowHTML(ev)).join('')}</div>
    <button type="button" class="secondary" data-chr="add-evidence">＋ Agregar fuente</button>
  </fieldset>`;
}

export function characterFormHTML(): string {
  const editing = characterById(state.editingCharacterId);
  const c: Character | undefined = editing;
  const suggestedName = state.characterSearch.suggestion?.name || state.characterSearch.name;
  const fieldBlock = (key: CharacterFieldKey, multiline: boolean) => `<div class="chr-form-field">
      <label for="chr_${key}">${FIELD_LABELS[key]}</label>
      ${
        multiline
          ? `<textarea id="chr_${key}" name="${key}" maxlength="${LIMITS[key]}">${esc(c?.[key] ?? '')}</textarea>`
          : `<input id="chr_${key}" name="${key}" type="text" maxlength="${LIMITS[key]}" value="${esc(c?.[key] ?? '')}" />`
      }
      ${certaintySelectHTML(`cert_${key}`, c?.certainty[key], { allowUnknown: true })}
    </div>`;
  return `<p><button type="button" class="chr-back" data-chr="cancel">← Cancelar</button></p>
    <h2 id="chrHeading" tabindex="-1">${editing ? `Editar a ${esc(editing.name)}` : 'Nuevo personaje'}</h2>
    <p class="muted">Dejá en blanco lo que no sepas. La certeza y las referencias son opcionales: podés guardar un dato sin clasificarlo como explícito o inferido.</p>
    <form id="chrCharacterForm" class="chr-form" novalidate>
      <div class="chr-errors" id="chrFormErrors" role="alert" aria-live="assertive"></div>
      <div class="chr-form-field">
        <label for="chr_name">Nombre</label>
        <input id="chr_name" name="name" type="text" maxlength="${LIMITS.name}" required value="${esc(c?.name ?? suggestedName)}" />
        <div class="chr-research-actions"><button type="button" class="secondary" data-chr="search-character">${AI_SPARK} ${api().ai.hasKey() ? 'Completar con IA' : 'Preparar búsqueda en Gemini'}</button><span class="muted">${api().ai.hasKey() ? 'Gemini' : 'Prompt manual'} · hasta p. ${Math.max(0, Number(book?.currentPage) || 0)}</span>${groundingToggleHTML()}</div>
      </div>
      ${characterSearchHTML()}
      <div id="chrAiHost"></div>
      <div class="chr-form-field">
        <label for="chr_aliases">Otros nombres o alias (uno por línea)</label>
        <textarea id="chr_aliases" name="aliases">${esc((c?.aliases ?? []).join('\n'))}</textarea>
      </div>
      ${fieldBlock('age', false)}
      ${fieldBlock('description', true)}
      <div class="chr-form-field">
        <label for="chr_traits">Rasgos (separados por coma)</label>
        <input id="chr_traits" name="traits" type="text" value="${esc((c?.traits ?? []).join(', '))}" />
      </div>
      ${fieldBlock('occupation', false)}
      ${fieldBlock('affiliation', false)}
      <div class="chr-form-field">
        <label for="chr_comments">Comentarios y observaciones personales</label>
        <textarea id="chr_comments" name="comments" maxlength="${LIMITS.comments}">${esc(c?.comments ?? '')}</textarea>
      </div>
      ${evidenceEditorHTML(c?.evidence ?? [])}
      <div class="chr-form-actions">
        <button type="submit" class="primary">${editing ? 'Guardar cambios' : 'Crear ficha'}</button>
        <button type="button" class="secondary" data-chr="cancel">Cancelar</button>
      </div>
    </form>`;
}

export function relationFormHTML(): string {
  const draft = state.relationDraft;
  const from = characterById(draft?.fromId);
  if (!draft || !from) return indexHTML();
  const editing = draft.editingId ? data.relations.find((r) => r.id === draft.editingId) : undefined;
  const otherId = editing ? (editing.fromId === from.id ? editing.toId : editing.fromId) : '';
  const others = data.characters.filter((c) => c.id !== from.id);
  const usedTypes = [...new Set(data.relations.map((r) => r.type))].filter((t) => !(RELATION_TYPES as readonly string[]).includes(t));
  return `<p><button type="button" class="chr-back" data-chr="cancel">← Cancelar</button></p>
    <h2 id="chrHeading" tabindex="-1">${editing ? 'Editar vínculo' : 'Nuevo vínculo'} de ${esc(from.name)}</h2>
    <form id="chrRelationForm" class="chr-form" novalidate>
      <div class="chr-errors" id="chrFormErrors" role="alert" aria-live="assertive"></div>
      <nav class="chr-form-steps" aria-label="Secciones del vínculo">
        <a href="#chrRelationPerson">1. Personaje</a><a href="#chrRelationKind">2. Tipo</a><a href="#chrRelationDetails">3. Detalles</a><a href="#chrRelationEvidence">4. Respaldo</a>
      </nav>
      <section class="chr-relation-step" id="chrRelationPerson" aria-labelledby="chrRelationPersonTitle">
      <h3 id="chrRelationPersonTitle">1. ¿Con quién se relaciona?</h3>
      <div class="chr-form-field">
        <label for="chr_other_search">Buscar personaje por nombre</label>
        <input id="chr_other_search" type="search" placeholder="Escribí para filtrar la lista…" autocomplete="off" ${editing ? 'disabled' : ''} />
        <label for="chr_other">Seleccionar personaje</label>
        <select id="chr_other" name="other" ${editing ? 'disabled' : ''}>
          <option value="" ${!otherId ? 'selected' : ''}>Elegir personaje…</option>
          ${others.map((c) => `<option value="${esc(c.id)}" ${c.id === otherId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          ${editing ? '' : '<option value="__new__">＋ Crear personaje nuevo…</option>'}
        </select>
        <small class="muted">Si no aparece, podés crear su ficha aquí mismo. También podés registrar amistad, rivalidad, familia, alianza u otro vínculo.</small>
      </div>
      ${editing ? '' : `<div class="chr-form-field"><label><input type="checkbox" id="chrMultiRelation" /> Crear este vínculo con varios personajes</label><fieldset id="chrMultiTargets" class="chr-fieldset hidden"><legend>Seleccioná los personajes</legend>${others.map((c) => `<label><input type="checkbox" name="multiOther" value="${esc(c.id)}" /> ${esc(c.name)}</label>`).join('')}</fieldset></div>`}
      ${!editing ? `<div class="chr-form-field hidden" id="chrNewRelativeWrap"><label for="chr_new_relative">Nombre del nuevo personaje</label><input id="chr_new_relative" name="newRelative" type="text" maxlength="${LIMITS.name}" placeholder="Nombre tal como aparece en el libro" /></div>` : ''}
      </section>
      <section class="chr-relation-step" id="chrRelationKind"><h3>2. ¿Qué vínculo tienen?</h3>
      <div class="chr-form-field">
        <label for="chr_direction">Sentido del vínculo</label>
        <select id="chr_direction" name="direction">
          <option value="out" ${!editing || editing.fromId === from.id ? 'selected' : ''}>${esc(from.name)} → otro personaje</option>
          <option value="in" ${editing && editing.fromId !== from.id ? 'selected' : ''}>otro personaje → ${esc(from.name)}</option>
        </select>
        <small class="muted">Solo importa en vínculos con sentido, como Mentoría (quien enseña → quien aprende).</small>
      </div>
      <div class="chr-form-field">
        <label for="chr_type">Tipo de vínculo</label>
        <input id="chr_type" name="type" type="text" list="chrTypes" maxlength="${LIMITS.relationType}" required value="${esc(editing?.type ?? '')}" placeholder="Familiar, amistad, rivalidad, alianza, mentoría u otro" />
        <datalist id="chrTypes">${[...RELATION_TYPES, ...usedTypes].map((t) => `<option value="${esc(t)}"></option>`).join('')}</datalist>
      </div>
      </section>
      <section class="chr-relation-step" id="chrRelationDetails"><h3>3. Detalles</h3>
      <div class="chr-form-field">
        <label for="chr_rel_description">Descripción o comentario del vínculo</label>
        <textarea id="chr_rel_description" name="description" maxlength="${LIMITS.relationDescription}">${esc(editing?.description ?? '')}</textarea>
      </div>
      </section>
      <section class="chr-relation-step" id="chrRelationEvidence"><h3>4. Respaldo</h3>
      <div class="chr-form-field">
        <label for="chr_rel_certainty">Certeza del vínculo</label>
        ${certaintySelectHTML('certainty', editing?.certainty ?? 'unknown', { allowUnknown: true })}
      </div>
      ${evidenceEditorHTML(editing?.evidence ?? [])}
      </section>
      <div class="chr-form-actions">
        <button type="submit" class="primary">${editing ? 'Guardar cambios' : 'Crear vínculo'}</button>
        <button type="button" class="secondary" data-chr="cancel">Cancelar</button>
      </div>
    </form>`;
}

function readEvidence(form: HTMLElement): EvidenceRef[] {
  return [...form.querySelectorAll<HTMLElement>('.chr-evidence-row')].map((row) => ({
    kind: (row.querySelector<HTMLSelectElement>('[data-f=kind]')!.value || 'other') as EvidenceRef['kind'],
    ref: row.querySelector<HTMLInputElement>('[data-f=ref]')!.value,
    text: row.querySelector<HTMLInputElement>('[data-f=text]')!.value,
  }));
}

export function formValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return el ? el.value : '';
}

export function showFormErrors(errors: string[], warnings: string[] = []) {
  const box = host?.querySelector<HTMLElement>('#chrFormErrors');
  if (!box) return;
  box.innerHTML = errors.length
    ? `<ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
    : warnings.length
      ? `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
      : '';
  if (errors.length) box.scrollIntoView({ block: 'nearest' });
}

export async function submitCharacterForm(form: HTMLFormElement) {
  const editing = characterById(state.editingCharacterId);
  const certainty: CharacterInput['certainty'] = {};
  for (const key of FIELD_KEYS) {
    const value = formValue(form, `cert_${key}`);
    if (value === 'explicit' || value === 'inferred') certainty[key] = value;
  }
  const input: CharacterInput = {
    id: editing?.id,
    name: formValue(form, 'name'),
    aliases: formValue(form, 'aliases').split(/\n|;/),
    age: formValue(form, 'age'),
    description: formValue(form, 'description'),
    traits: formValue(form, 'traits').split(/[,;\n]/),
    occupation: formValue(form, 'occupation'),
    affiliation: formValue(form, 'affiliation'),
    comments: formValue(form, 'comments'),
    evidence: readEvidence(form),
    certainty,
  };
  const result = validateCharacter(input, { bookId: state.bookId, existing: data.characters, editingId: editing?.id });
  if (!result.ok || !result.value) {
    showFormErrors(result.errors);
    return;
  }
  try {
    const saved = await api().saveCharacter({ ...result.value, userId: editing?.userId, createdAt: editing?.createdAt });
    await reload();
    let relativeCount = 0;
    for (const suggestion of state.pendingRelatives) {
      let relative = data.characters.find((c) => c.name.trim().toLowerCase() === suggestion.name.trim().toLowerCase());
      if (!relative) {
        const created = validateCharacter({ name: suggestion.name }, { bookId: state.bookId, existing: data.characters });
        if (!created.ok || !created.value) continue;
        relative = await api().saveCharacter(created.value);
        data.characters.push(relative);
      }
      const relation = validateRelation({
        fromId: suggestion.direction === 'out' ? saved.id : relative.id,
        toId: suggestion.direction === 'out' ? relative.id : saved.id,
        type: suggestion.type,
        description: '', evidence: suggestion.evidence ? [{ kind: 'other', ref: 'Fuente sugerida por IA', text: suggestion.evidence.slice(0, LIMITS.evidenceText) }] : [], certainty: suggestion.certainty,
      }, { bookId: state.bookId, characters: data.characters, relations: data.relations });
      if (relation.ok && relation.value) {
        await api().saveRelation(relation.value.record);
        relativeCount++;
      }
    }
    state.pendingRelatives = [];
    await reload();
    go('sheet', {
      selectedId: saved.id,
      editingCharacterId: null,
      notice: [editing ? 'Ficha actualizada.' : 'Ficha creada.', relativeCount ? `Se guardaron ${relativeCount} vínculo(s) familiar(es) seleccionados.` : '', ...result.warnings].filter(Boolean).join(' '),
    });
  } catch (err: any) {
    showFormErrors([`No se pudo guardar: ${err?.message || err}`]);
  }
}

export async function submitRelationForm(form: HTMLFormElement) {
  const draft = state.relationDraft;
  if (!draft) return;
  const editing = draft.editingId ? data.relations.find((r) => r.id === draft.editingId) : undefined;
  if (!editing && form.querySelector<HTMLInputElement>('#chrMultiRelation')?.checked) {
    const targets = [...form.querySelectorAll<HTMLInputElement>('input[name="multiOther"]:checked')].map((input) => input.value);
    if (!targets.length) return showFormErrors(['Seleccioná al menos un personaje para crear los vínculos.']);
    const outgoing = formValue(form, 'direction') !== 'in';
    const proposed = targets.map((otherId) => validateRelation({
      fromId: outgoing ? draft.fromId : otherId, toId: outgoing ? otherId : draft.fromId,
      type: formValue(form, 'type'), description: formValue(form, 'description'), evidence: readEvidence(form),
      certainty: (formValue(form, 'certainty') || 'unknown') as Certainty,
    }, { bookId: state.bookId, characters: data.characters, relations: data.relations }));
    const errors = proposed.flatMap((r, i) => r.ok ? [] : [`${characterById(targets[i])?.name || 'Personaje'}: ${r.errors.join(' ')}`]);
    if (errors.length) return showFormErrors(errors);
    const records = proposed.flatMap((r) => r.value ? [r.value.record] : []);
    const approved = await api().confirm({ eyebrow: 'VÍNCULOS MÚLTIPLES', title: `Crear ${records.length} vínculos`, message: records.map((r) => `${characterById(r.fromId)?.name} → ${r.type} → ${characterById(r.toId)?.name}`).join('\n'), confirmLabel: 'Crear vínculos' });
    if (!approved) return;
    let saved = 0;
    const failures: string[] = [];
    for (const record of records) {
      try {
        const fresh = await api().loadBookData(state.bookId);
        const validAgain = validateRelation(record, { bookId: state.bookId, characters: fresh.characters, relations: fresh.relations });
        if (!validAgain.ok || !validAgain.value) throw Error(validAgain.errors.join(' '));
        await api().saveRelation(validAgain.value.record);
        saved++;
      } catch (err: any) { failures.push(`${characterById(record.toId)?.name || record.toId}: ${String(err?.message || err)}`); }
    }
    await reload();
    go('sheet', { selectedId: draft.fromId, relationDraft: null, notice: `Se guardaron ${saved} de ${records.length} vínculos.${failures.length ? ` No se guardaron: ${failures.join('; ')}` : ''}` });
    return;
  }
  let otherId = editing ? (editing.fromId === draft.fromId ? editing.toId : editing.fromId) : formValue(form, 'other');
  let createdRelative: Character | null = null;
  if (otherId === '__new__') {
    const name = formValue(form, 'newRelative').trim();
    if (!name) return showFormErrors(['Escribí el nombre del nuevo personaje.']);
    const normalizedName = name.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLocaleLowerCase();
    const existingCharacter = data.characters.find((character) =>
      [character.name, ...character.aliases].some((candidate) =>
        candidate.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLocaleLowerCase() === normalizedName,
      ),
    );
    if (existingCharacter) {
      otherId = existingCharacter.id;
    } else {
      const characterResult = validateCharacter({ name }, { bookId: state.bookId, existing: data.characters });
      if (!characterResult.ok || !characterResult.value) return showFormErrors(characterResult.errors);
      try {
        createdRelative = await api().saveCharacter(characterResult.value);
        otherId = createdRelative.id;
      } catch (err: any) {
        return showFormErrors([`No se pudo crear el personaje: ${err?.message || err}`]);
      }
    }
  }
  const outgoing = formValue(form, 'direction') !== 'in';
  const result = validateRelation(
    {
      fromId: outgoing ? draft.fromId : otherId,
      toId: outgoing ? otherId : draft.fromId,
      type: formValue(form, 'type'),
      description: formValue(form, 'description'),
      evidence: readEvidence(form),
      certainty: (formValue(form, 'certainty') || 'unknown') as Certainty,
    },
    { bookId: state.bookId, characters: data.characters, relations: data.relations, editing },
  );
  if (!result.ok || !result.value) {
    showFormErrors(result.errors);
    return;
  }
  try {
    await api().saveRelation(result.value.record);
    if (result.value.replacesId) await api().deleteRelation(result.value.replacesId);
    await reload();
    go('sheet', { selectedId: draft.fromId, relationDraft: null, notice: editing ? 'Vínculo actualizado.' : 'Vínculo creado.' });
  } catch (err: any) {
    showFormErrors([`${createdRelative ? `Se creó «${createdRelative.name}», pero ` : ''}no se pudo guardar el vínculo: ${err?.message || err}`]);
  }
}

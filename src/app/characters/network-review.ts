/** Personajes · «Analizar mi red»: propuestas de la IA y su revisión. */
import type { Certainty, CharacterRelation, EvidenceRef } from '../../types';
import { CERTAINTIES, CERTAINTY_LABELS, LIMITS, normalizeText, validateRelation } from '../characters-model';
import { parsePastedJSON } from './character-search';
import { api, book, characterById, data, esc, host, state, type NetworkProposal, type State } from './context';
import { autoAbort, autoNote, autoRunningHTML, beginAuto, groundingNoteFor, networkAnalysisPrompt, runJSONTask, setAutoAbort, setAutoNote } from './gemini';
import { go, paint, reload } from './render';

export function networkReviewHTML(): string {
  const review = state.networkReview;
  if (review.status === 'running') return autoRunningHTML('Analizando tu red con IA…');
  if (review.status === 'idle') return '';
  if (review.status === 'prompt') return `<section class="chr-research chr-network-review"><h3>Analizar y mejorar mi red</h3><p>El prompt incluye nombres, vínculos y hasta 40 notas, anotaciones y citas paginadas por tipo, solo hasta la página ${Math.max(0, Number(book?.currentPage) || 0)}. Las fichas, descripciones y fuentes sin página se omiten. Se lo enviarás manualmente a Gemini; Librarium no consulta la API ni guarda cambios durante el análisis.</p><label for="chrNetworkPrompt">Prompt para Gemini</label><textarea id="chrNetworkPrompt" readonly rows="16">${esc(review.prompt)}</textarea><div class="chr-row-actions"><button type="button" class="secondary" data-chr="copy-network-prompt">Copiar prompt</button><a class="secondary" href="https://gemini.google.com/app" target="_blank" rel="noopener noreferrer">Abrir Gemini</a><button type="button" class="secondary" data-chr="cancel-network-review">Cancelar</button></div><p class="muted chr-review-copy-status" role="status"></p><label for="chrNetworkResponse">Pegá la respuesta JSON de Gemini</label><textarea id="chrNetworkResponse" rows="10" placeholder="Pegá aquí el análisis completo…">${esc(review.responseText)}</textarea>${review.error ? `<p class="chr-ai-error" role="alert">${esc(review.error)}</p>` : ''}<button type="button" class="primary" data-chr="parse-network-review">Revisar propuestas</button><p class="muted">La IA puede sugerir desde el conocimiento general aunque no haya citas; esas propuestas se marcan como inferencias. Las que se basan en tu cuaderno deben citar una referencia válida. Ningún cambio se guarda automáticamente.</p></section>`;
  const cards = review.proposals.map((proposal, index) => networkProposalHTML(proposal, index)).join('');
  const acceptedCount = review.proposals.filter((proposal) => proposal.decision === 'accepted' && !proposal.validationError).length;
  const findings = review.manualFindings.map((finding, index) => `<article class="chr-review-finding"><strong>${esc(finding.category)}</strong>${finding.name ? `<h4>${esc(finding.name)}</h4>` : ''}<span>${finding.characterIds.map((id) => characterById(id)?.name || `ID no encontrado: ${id}`).map(esc).join(', ')}</span><p>${esc(finding.reason)}</p>${finding.evidence ? `<blockquote>${esc(finding.evidence)}</blockquote>` : ''}${/^https?:\/\//i.test(finding.sourceUrl) ? `<a href="${esc(finding.sourceUrl)}" target="_blank" rel="noopener noreferrer">Abrir fuente citada</a>` : ''}${finding.category === 'missing_character' && finding.name ? canCreateMissingCharacter(finding) ? `<div class="chr-row-actions"><button type="button" class="primary" data-chr="create-missing-character" data-index="${index}">＋ Crear ficha y ubicar en la red</button></div>` : '<p class="muted">No se puede crear automáticamente: la propuesta dice basarse en tu cuaderno, pero no cita una referencia paginada válida.</p>' : ''}</article>`).join('');
  return `<section class="chr-research chr-network-review"><div class="chr-review-heading"><div><h3>Revisión de propuestas</h3><p>${review.proposals.length} cambios propuestos · ${review.manualFindings.length} casos para revisar manualmente</p>${autoNote ? `<p class="muted">${esc(autoNote)}</p>` : ''}</div><button type="button" class="secondary" data-chr="new-network-analysis">Nuevo análisis</button></div>${review.error ? `<p class="chr-ai-error" role="alert">${esc(review.error)}</p>` : ''}${review.proposals.length ? `<h4>Relaciones nuevas y correcciones</h4><div class="chr-review-cards">${cards}</div><div class="chr-form-actions"><button type="button" class="primary" data-chr="apply-network-accepted" ${acceptedCount ? '' : 'disabled'}>Aplicar propuestas aceptadas (${acceptedCount})</button></div>` : '<p class="muted">No hay cambios de relación propuestos.</p>'}${findings ? `<h4>Casos para revisión manual</h4><div class="chr-review-cards">${findings}</div>` : ''}<p class="muted">Las propuestas aceptadas se revisan y confirman antes de guardarse.</p></section>`;
}

function networkProposalHTML(proposal: NetworkProposal, index: number): string {
  const chars = data.characters.map((c) => `<option value="${esc(c.id)}" ${c.id === proposal.fromId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const charsTo = data.characters.map((c) => `<option value="${esc(c.id)}" ${c.id === proposal.toId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const current = proposal.targetRelationId ? data.relations.find((r) => r.id === proposal.targetRelationId) : undefined;
  const existing = `${proposal.basisType === 'reader_material' ? 'Basada en tu cuaderno' : 'Inferencia del conocimiento general de la IA'} · ${current ? `Actual: ${characterById(current.fromId)?.name} → ${current.type} → ${characterById(current.toId)?.name} · ${CERTAINTY_LABELS[current.certainty]}` : 'Nueva relación'}`;
  const relationChoices = data.relations.map((r) => `<option value="${esc(r.id)}" ${r.id === proposal.targetRelationId ? 'selected' : ''}>${esc(characterById(r.fromId)?.name)} · ${esc(r.type)} · ${esc(characterById(r.toId)?.name)}</option>`).join('');
  return `<article class="chr-review-proposal" data-review-card="${index}"><div class="chr-review-proposal-head"><span class="chr-review-state">${proposal.decision === 'accepted' ? 'Aceptada' : proposal.decision === 'rejected' ? 'Descartada' : 'Pendiente'}</span><span class="chr-confidence chr-confidence--${proposal.confidence}">Confianza ${esc(proposal.confidence)}</span></div><p class="muted">${esc(existing)}${proposal.action === 'correct' ? ' · corrección sugerida' : ''}</p><div class="chr-review-fields">${proposal.action === 'correct' ? `<label class="chr-review-wide">Vínculo a corregir<select data-review-field="targetRelationId">${relationChoices}</select></label>` : ''}<label>Desde<select data-review-field="fromId">${chars}</select></label><label>Hacia<select data-review-field="toId">${charsTo}</select></label><label>Tipo<input data-review-field="type" maxlength="${LIMITS.relationType}" value="${esc(proposal.type)}" /></label><label>Certeza<select data-review-field="certainty">${(['explicit','inferred','unknown'] as Certainty[]).map((v) => `<option value="${v}" ${proposal.certainty === v ? 'selected' : ''}>${CERTAINTY_LABELS[v]}</option>`).join('')}</select></label><label class="chr-review-wide">Descripción<textarea data-review-field="description" maxlength="${LIMITS.relationDescription}" rows="2">${esc(proposal.description)}</textarea></label><label class="chr-review-wide">Evidencia propuesta<textarea data-review-field="evidence" maxlength="${LIMITS.evidenceText}" rows="2">${esc(proposal.evidence)}</textarea></label><label class="chr-review-wide">URL citada<input data-review-field="sourceUrl" type="url" value="${esc(proposal.sourceUrl)}" placeholder="https://…" /></label></div><p><strong>Justificación:</strong> ${esc(proposal.reason)}</p>${proposal.validationError ? `<p class="chr-ai-error" role="alert">${esc(proposal.validationError)}</p>` : ''}<div class="chr-row-actions"><button type="button" class="secondary" data-chr="accept-network-proposal" data-index="${index}" ${proposal.decision === 'accepted' ? 'disabled' : ''}>${proposal.decision === 'rejected' ? 'Reactivar' : 'Aceptar'}</button><button type="button" class="secondary" data-chr="reject-network-proposal" data-index="${index}" ${proposal.decision === 'rejected' ? 'disabled' : ''}>${proposal.decision === 'accepted' ? 'Deshacer aceptación' : 'Descartar'}</button>${current ? `<button type="button" class="secondary" data-chr="edit-relation" data-rel="${esc(current.id)}">Abrir vínculo actual</button>` : ''}</div></article>`;
}

async function runAutoNetworkAnalysis() {
  const controller = beginAuto();
  setAutoNote('Leyendo tus personajes, vínculos y notas…');
  state.networkReview = { status: 'running', prompt: '', responseText: '', error: '', proposals: [], manualFindings: [] };
  paint();
  try {
    const result = await runJSONTask(networkAnalysisPrompt(), controller.signal);
    if (controller.signal.aborted) return;
    const { proposals, manualFindings } = buildNetworkReview(result.text);
    // La confianza es una estimación del modelo, no aprobación de la persona.
    for (const proposal of proposals) proposal.decision = 'pending';
    setAutoNote(groundingNoteFor(result));
    state.networkReview = { status: 'review', prompt: '', responseText: '', error: '', proposals, manualFindings };
  } catch (err: any) {
    if (controller.signal.aborted) return;
    setAutoNote('');
    state.networkReview = { status: 'prompt', prompt: networkAnalysisPrompt(), responseText: '', error: `${String(err?.message || err)} Mientras tanto podés usar el método manual de abajo.`, proposals: [], manualFindings: [] };
  } finally {
    if (autoAbort === controller) setAutoAbort(null);
  }
  paint();
}

export function startNetworkAnalysis() {
  if (api().ai.hasKey()) return void runAutoNetworkAnalysis();
  state.networkReview = { status: 'prompt', prompt: networkAnalysisPrompt(), responseText: '', error: '', proposals: [], manualFindings: [] };
  paint();
  host?.querySelector<HTMLElement>('.chr-network-review')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export async function createMissingNetworkCharacter(index: number) {
  const finding = state.networkReview.manualFindings[index];
  const name = finding?.name?.trim();
  if (!finding || finding.category !== 'missing_character' || !name || !canCreateMissingCharacter(finding)) return;
  const nameKey = normalizeText(name);
  const existing = data.characters.find((c) => c.bookId === state.bookId && [c.name, ...c.aliases].some((value) => normalizeText(value) === nameKey));
  if (existing) {
    state.netSelected = existing.id; state.netFocus = existing.id;
    return go('index', { view: 'network', selectedId: existing.id, notice: '«' + existing.name + '» ya tenía ficha; la seleccioné en la red para que puedas conectarlo.' });
  }
  const now = new Date().toISOString();
  const evidence: EvidenceRef[] = finding.evidence ? [{ kind: 'other', ref: 'Análisis de red · revisar', text: finding.evidence.slice(0, LIMITS.evidenceText) }] : [];
  const provenance = finding.basisType === 'general_knowledge' ? 'Sugerido por conocimiento general de la IA; revisar identidad y posibles spoilers. ' : 'Sugerido a partir del cuaderno; revisar. ';
  const character = await api().saveCharacter({ id: crypto.randomUUID(), bookId: state.bookId, name, aliases: [], age: '', description: '', traits: [], occupation: '', affiliation: '', comments: `${provenance}${finding.reason}`.slice(0, LIMITS.comments), evidence, certainty: {}, createdAt: now, updatedAt: now });
  await reload();
  state.netSelected = character.id; state.netFocus = character.id;
  go('index', { view: 'network', selectedId: character.id, notice: 'Se creó la ficha de «' + character.name + '» y quedó seleccionada en la red. Desde su panel podés agregar el vínculo y ubicarlo con los demás.' });
}
export async function copyNetworkPrompt() {
  const prompt = state.networkReview.prompt;
  const textarea = host?.querySelector<HTMLTextAreaElement>('#chrNetworkPrompt');
  try {
    await navigator.clipboard.writeText(prompt);
    state.notice = 'Prompt copiado. Pegalo en Gemini Plus y luego traé el JSON a Librarium.';
  } catch {
    textarea?.focus(); textarea?.select();
    state.notice = 'Seleccioné el prompt para copiarlo manualmente con Ctrl+C.';
  }
  const notice = host?.querySelector<HTMLElement>('.chr-network-review .chr-review-copy-status');
  if (notice) notice.textContent = state.notice;
}

function validateNetworkProposal(proposal: NetworkProposal, relations = data.relations, characters = data.characters): string[] {
  const errors: string[] = [];
  if (proposal.basisType === 'reader_material' && !hasNetworkEvidence(proposal.evidence)) errors.push('La propuesta dice basarse en tu cuaderno, pero no cita una nota, anotación o cita incluida en el análisis.');
  const editing = proposal.action === 'correct' ? relations.find((r) => r.id === proposal.targetRelationId && r.bookId === state.bookId) : undefined;
  if (proposal.action === 'correct' && !editing) errors.push('La relación que se quería corregir ya no existe en este libro.');
  if (proposal.sourceUrl && !/^https?:\/\//i.test(proposal.sourceUrl)) errors.push('La URL citada debe comenzar con http:// o https://.');
  const result = validateRelation({
    fromId: proposal.fromId, toId: proposal.toId, type: proposal.type,
    description: proposal.description, certainty: proposal.certainty,
  }, { bookId: state.bookId, characters, relations, editing });
  errors.push(...result.errors);
  if (!CERTAINTIES.includes(proposal.certainty)) errors.push('La certeza propuesta no es válida.');
  return [...new Set(errors)];
}

function networkEvidenceCodes(): Set<string> {
  const page = Math.max(0, Number(book?.currentPage) || 0);
  const codes = new Set(data.notes.filter((n) => n.endPage != null && n.endPage <= page).slice(0, 40).map((n) => `N${n.number}`));
  data.entries.filter((e) => e.page != null && e.page <= page).slice(0, 40).forEach((_e, i) => codes.add(`E${i + 1}`));
  data.quotes.filter((q) => q.page != null && q.page <= page).slice(0, 40).forEach((_q, i) => codes.add(`Q${i + 1}`));
  return codes;
}

function hasNetworkEvidence(evidence: string): boolean {
  const validCodes = networkEvidenceCodes();
  return [...evidence.matchAll(/\[(N|E|Q)\s*(\d+)\]/gi)].some((match) => validCodes.has(`${match[1].toUpperCase()}${match[2]}`));
}

function canCreateMissingCharacter(finding: State['networkReview']['manualFindings'][number]): boolean {
  return finding.basisType === 'general_knowledge' || hasNetworkEvidence(finding.evidence);
}

function buildNetworkReview(responseText: string): { proposals: NetworkProposal[]; manualFindings: State['networkReview']['manualFindings'] } {
  const parsed = parsePastedJSON(responseText);
  const proposals: NetworkProposal[] = [];
  const manualFindings: State['networkReview']['manualFindings'] = [];
  const proposedKeys = new Set<string>();
  for (const raw of (Array.isArray(parsed.proposals) ? parsed.proposals : []).slice(0, 40)) {
    const action = raw?.action === 'correct_relation' ? 'correct' : raw?.action === 'add_relation' ? 'add' : null;
    if (!action) continue;
    const current = action === 'correct' ? data.relations.find((r) => r.id === raw.relationId && r.bookId === state.bookId) : undefined;
    if (action === 'correct' && !current) {
      const evidence = String(raw.evidence || '').slice(0, LIMITS.evidenceText);
      manualFindings.push({ category: 'ID de relación no reconocido', characterIds: [], reason: `Gemini propuso corregir una relación inexistente (${String(raw.relationId || 'sin ID')}). No se puede aplicar automáticamente.`, evidence, sourceUrl: /^https?:\/\//i.test(String(raw.sourceUrl || '')) ? String(raw.sourceUrl).slice(0, LIMITS.evidenceText) : '', basisType: raw.basisType === 'reader_material' || hasNetworkEvidence(evidence) ? 'reader_material' : 'general_knowledge' });
      continue;
    }
    const evidence = String(raw.evidence || '').trim().slice(0, LIMITS.evidenceText);
    const basisType: NetworkProposal['basisType'] = raw.basisType === 'reader_material'
      ? 'reader_material'
      : raw.basisType === 'general_knowledge'
        ? 'general_knowledge'
        : hasNetworkEvidence(evidence) ? 'reader_material' : 'general_knowledge';
    const proposal: NetworkProposal = {
      action,
      ...(action === 'correct' ? { targetRelationId: current?.id || String(raw.relationId || '') } : {}),
      fromId: String(raw.fromId || (action === 'correct' ? current?.fromId : '') || ''),
      toId: String(raw.toId || (action === 'correct' ? current?.toId : '') || ''),
      type: String(raw.type || (action === 'correct' ? current?.type : '') || '').trim().slice(0, LIMITS.relationType),
      description: String(raw.description ?? (action === 'correct' ? current?.description : '') ?? '').trim().slice(0, LIMITS.relationDescription),
      // No sugieras degradar un vínculo explícito en silencio; la persona puede cambiarlo en la revisión.
      certainty: basisType === 'general_knowledge'
        ? 'inferred'
        : current?.certainty === 'explicit' && raw.certainty !== 'explicit'
          ? 'explicit'
          : CERTAINTIES.includes(raw.certainty) ? raw.certainty : current?.certainty || 'unknown',
      confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
      reason: String(raw.reason || '').trim().slice(0, 1200),
      evidence,
      sourceUrl: /^https?:\/\//i.test(String(raw.sourceUrl || '')) ? String(raw.sourceUrl).slice(0, LIMITS.evidenceText) : '',
      basisType,
      decision: 'pending',
    };
    const errors = validateNetworkProposal(proposal);
    const checked = validateRelation({ fromId: proposal.fromId, toId: proposal.toId, type: proposal.type, description: proposal.description, certainty: proposal.certainty }, {
      bookId: state.bookId, characters: data.characters, relations: data.relations,
      editing: action === 'correct' ? data.relations.find((r) => r.id === proposal.targetRelationId) : undefined,
    });
    if (checked.value) {
      if (proposedKeys.has(checked.value.record.id)) errors.push('Esta operación duplica otra propuesta de la misma respuesta.');
      proposedKeys.add(checked.value.record.id);
    }
    proposal.validationError = errors.length ? [...new Set(errors)].join(' ') : '';
    proposals.push(proposal);
  }
  const knownIds = new Set(data.characters.filter((c) => c.bookId === state.bookId).map((c) => c.id));
  for (const raw of (Array.isArray(parsed.manualFindings) ? parsed.manualFindings : []).slice(0, 40)) {
    const ids = Array.isArray(raw.characterIds) ? raw.characterIds.map(String).filter((id: string) => knownIds.has(id)) : [];
    const evidence = String(raw.evidence || '').slice(0, LIMITS.evidenceText);
    const basisType = raw.basisType === 'reader_material' ? 'reader_material' : raw.basisType === 'general_knowledge' ? 'general_knowledge' : hasNetworkEvidence(evidence) ? 'reader_material' : 'general_knowledge';
    manualFindings.push({ category: String(raw.category || 'Revisión manual').slice(0, 80), characterIds: ids, ...(typeof raw.name === 'string' && raw.name.trim() ? { name: raw.name.trim().slice(0, LIMITS.name) } : {}), reason: String(raw.reason || '').slice(0, 1200), evidence, sourceUrl: /^https?:\/\//i.test(String(raw.sourceUrl || '')) ? String(raw.sourceUrl).slice(0, LIMITS.evidenceText) : '', basisType });
  }
  return { proposals, manualFindings };
}

export function parseNetworkReview() {
  const review = state.networkReview;
  const responseText = host?.querySelector<HTMLTextAreaElement>('#chrNetworkResponse')?.value || '';
  try {
    const { proposals, manualFindings } = buildNetworkReview(responseText);
    setAutoNote('');
    state.networkReview = { ...review, status: 'review', responseText: '', error: '', proposals, manualFindings };
  } catch (err: any) {
    state.networkReview = { ...review, responseText, error: String(err?.message || err) };
  }
  paint();
}

function proposalFromCard(index: number): NetworkProposal | null {
  const current = state.networkReview.proposals[index];
  const card = host?.querySelector<HTMLElement>(`[data-review-card="${index}"]`);
  if (!current || !card) return current || null;
  const read = (key: string) => card.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-review-field="${key}"]`)?.value;
  const proposal: NetworkProposal = {
    ...current,
    fromId: read('fromId') || current.fromId,
    toId: read('toId') || current.toId,
    type: read('type') || '',
    description: read('description') || '',
    certainty: (read('certainty') || 'unknown') as Certainty,
    evidence: read('evidence') || '',
    sourceUrl: read('sourceUrl') || '',
    targetRelationId: read('targetRelationId') || current.targetRelationId,
  };
  proposal.validationError = validateNetworkProposal(proposal).join(' ');
  return proposal;
}

export function decideNetworkProposal(index: number, decision: 'accepted' | 'rejected') {
  const proposal = proposalFromCard(index);
  if (!proposal) return;
  if (decision === 'accepted' && proposal.validationError) {
    state.networkReview.proposals[index] = proposal;
    paint();
    return;
  }
  proposal.decision = decision;
  state.networkReview.proposals[index] = proposal;
  paint();
}

export async function applyNetworkProposals() {
  const proposals = state.networkReview.proposals.map((proposal, index) => proposalFromCard(index) || proposal);
  const selected = proposals.filter((proposal) => proposal.decision === 'accepted' && !proposal.validationError);
  if (!selected.length) {
    state.networkReview.error = 'Aceptá y seleccioná al menos una propuesta válida antes de aplicar.';
    return paint();
  }
  const preview = selected.map((p) => `${p.action === 'correct' ? 'Corregir' : 'Agregar'}: ${characterById(p.fromId)?.name || p.fromId} → ${p.type} → ${characterById(p.toId)?.name || p.toId}${p.sourceUrl ? `\nFuente: ${p.sourceUrl}` : ''}${p.evidence ? `\nEvidencia: ${p.evidence}` : ''}`).join('\n\n');
  const approved = await api().confirm({ eyebrow: 'CAMBIOS PROPUESTOS POR GEMINI', title: `¿Aplicar ${selected.length} cambio${selected.length === 1 ? '' : 's'} a la red?`, message: preview, confirmLabel: 'Aplicar cambios' });
  if (!approved) return;
  let saved = 0;
  const failures: string[] = [];
  const proposalKey = (p: NetworkProposal) => `${p.action}|${p.targetRelationId || ''}|${p.fromId}|${p.toId}|${p.type}`;
  const applied = new Set<string>();
  try {
    const fresh = await api().loadBookData(state.bookId);
    const freshCharacters = fresh.characters.filter((c) => c.bookId === state.bookId);
    let freshRelations = fresh.relations.filter((r) => r.bookId === state.bookId);
    for (const proposal of selected) {
      try {
        const editing = proposal.action === 'correct' ? freshRelations.find((r) => r.id === proposal.targetRelationId) : undefined;
        const errors = validateNetworkProposal(proposal, freshRelations, freshCharacters);
        if (errors.length) throw Error(errors.join(' '));
        const checked = validateRelation({ fromId: proposal.fromId, toId: proposal.toId, type: proposal.type, description: proposal.description, certainty: proposal.certainty }, { bookId: state.bookId, characters: freshCharacters, relations: freshRelations, editing });
        if (!checked.ok || !checked.value) throw Error(checked.errors.join(' '));
        const sourceEvidence: EvidenceRef[] = [];
        if (proposal.evidence || proposal.sourceUrl) {
          const longUrl = proposal.sourceUrl.length > LIMITS.evidenceRef;
          sourceEvidence.push({ kind: 'other', ref: proposal.sourceUrl && !longUrl ? proposal.sourceUrl : `Gemini Plus${proposal.sourceUrl ? ' · fuente citada' : ''}`, text: `${proposal.evidence}${longUrl ? ` ${proposal.sourceUrl}` : ''}`.trim().slice(0, LIMITS.evidenceText) || (proposal.sourceUrl ? 'Fuente citada por Gemini Plus; verificar manualmente.' : '') });
        }
        const mergedEvidence = [...(editing?.evidence || []), ...sourceEvidence].slice(0, LIMITS.evidence);
        const certainty = proposal.certainty;
        const record: CharacterRelation = { ...checked.value.record, ...(editing ? { userId: editing.userId, createdAt: editing.createdAt } : {}), description: proposal.description, evidence: mergedEvidence, certainty };
        await api().saveRelation(record);
        saved++;
        applied.add(proposalKey(proposal));
        if (checked.value.replacesId && checked.value.replacesId !== record.id) {
          try {
            await api().deleteRelation(checked.value.replacesId);
            freshRelations = freshRelations.filter((r) => r.id !== checked.value!.replacesId);
          } catch (err: any) {
            failures.push(`${proposal.type} con ${characterById(proposal.toId)?.name || proposal.toId}: se guardó la nueva relación, pero no se pudo borrar la anterior (${checked.value.replacesId}): ${String(err?.message || err)}`);
          }
        }
        freshRelations = [...freshRelations.filter((r) => r.id !== record.id), record];
      } catch (err: any) {
        failures.push(`${characterById(proposal.fromId)?.name || proposal.fromId} → ${proposal.type} → ${characterById(proposal.toId)?.name || proposal.toId}: ${String(err?.message || err)}`);
      }
    }
  } catch (err: any) {
    failures.push(`No se pudo volver a cargar el libro antes de guardar: ${String(err?.message || err)}`);
  }
  await reload();
  state.networkReview.proposals = proposals.filter((proposal) => !applied.has(proposalKey(proposal)));
  state.networkReview.error = failures.length ? `Se guardaron ${saved} de ${selected.length} cambios. Detalle: ${failures.join(' · ')}` : '';
  go('index', { view: 'network', notice: failures.length ? `Se guardaron ${saved} de ${selected.length} cambios. Revisá el detalle del panel.` : `Se aplicaron ${saved} cambios confirmados a la red.` });
}

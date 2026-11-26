/** Personajes · Eventos del panel. */
import type { Certainty, CharacterFieldKey } from '../../types';
import { FIELD_KEYS, FIELD_LABELS, LIMITS, removeCharacterCascade } from '../characters-model';
import { openNetworkShare } from '../network-share';
import { abortAI, addSheetLinkRow, paintAI, startAI, submitAISave, submitFullSheet, syncAISaveForm } from './ai-panel';
import { applyWebResearch, copyResearchPrompt, parseCandidateResponse, parseProfileResponse, prepareSelectedProfile, startCharacterSearch } from './character-search';
import { api, book, characterById, data, host, state, type IndexView } from './context';
import { applyFamilySuggestions, copyFamilyPrompt, parseFamilySuggestions, startFamilySearch } from './family';
import { evidenceRowHTML, showFormErrors, submitCharacterForm, submitRelationForm } from './forms';
import { autoAbort, autoNote, setAutoAbort, setAutoNote, setGrounding } from './gemini';
import { applyGrowth, startGrowth } from './growth';
import { applyNetworkProposals, copyNetworkPrompt, createMissingNetworkCharacter, decideNetworkProposal, parseNetworkReview, startNetworkAnalysis } from './network-review';
import { confirmDiscard, go, paint, reload } from './render';
import { relationCount, resultsHTML } from './views';

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export function bindEvents() {
  if (!host) return;
  host.onclick = (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-chr]');
    if (!el || !host!.contains(el)) return;
    void handleAction(el.dataset.chr!, el);
  };
  host.onkeydown = (event) => {
    if (event.key === 'Escape') {
      const network = host?.querySelector<HTMLElement>('.chr-network--fullscreen');
      if (network) {
        network.classList.remove('chr-network--fullscreen');
        const button = host?.querySelector<HTMLButtonElement>('[data-chr="fullscreen-network"]');
        button?.setAttribute('aria-pressed', 'false');
        if (button) button.textContent = '⛶ Pantalla completa';
        button?.focus();
      }
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = (event.target as HTMLElement).closest<SVGElement>('g[data-chr="net-select"]');
    if (!el) return;
    event.preventDefault();
    void handleAction('net-select', el as unknown as HTMLElement);
  };
  host.onsubmit = (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    if (form.id === 'chrCharacterForm') void submitCharacterForm(form);
    else if (form.id === 'chrRelationForm') void submitRelationForm(form);
    else if (form.id === 'chrAiSave') void submitAISave(form);
    else if (form.id === 'chrFullSheet') void submitFullSheet(form);
  };
  host.oninput = (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'chrSearch') {
      state.query = (target as HTMLInputElement).value;
      const results = host!.querySelector('#chrResults');
      if (results) results.innerHTML = resultsHTML();
    }
    if (target.id === 'chr_other_search') {
      const query = (target as HTMLInputElement).value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
      const select = host?.querySelector<HTMLSelectElement>('#chr_other');
      if (select) [...select.options].forEach((option) => {
        if (!option.value || option.value === '__new__') { option.hidden = false; return; }
        const name = option.textContent?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase() || '';
        option.hidden = !!query && !name.includes(query);
      });
    }
  };
  host.onchange = (event) => {
    const target = event.target as HTMLElement;
    if (target.hasAttribute('data-chr-grounding')) {
      setGrounding((target as HTMLInputElement).checked);
      host?.querySelectorAll<HTMLInputElement>('[data-chr-grounding]').forEach((box) => { box.checked = (target as HTMLInputElement).checked; });
    }
    if (target.id === 'chrAiTarget') syncAISaveForm();
    if (target.id === 'chrMultiRelation') host?.querySelector<HTMLElement>('#chrMultiTargets')?.classList.toggle('hidden', !(target as HTMLInputElement).checked);
    if ((target as HTMLInputElement).name === 'chrCandidate') host?.querySelector<HTMLButtonElement>('[data-chr="investigate-character"]')?.removeAttribute('disabled');
    if (target.id === 'chr_other') host!.querySelector<HTMLElement>('#chrNewRelativeWrap')?.classList.toggle('hidden', (target as HTMLSelectElement).value !== '__new__');
    if (target.id === 'chrNetFocus') {
      state.netFocus = (target as HTMLSelectElement).value;
      state.netSelected = null;
      repaintResults('#chrNetFocus');
    }
  };
}

function repaintResults(focusSelector?: string) {
  const results = host?.querySelector('#chrResults');
  const keepFullscreen = !!results?.querySelector('.chr-network--fullscreen');
  if (results) results.innerHTML = resultsHTML();
  if (keepFullscreen) {
    results?.querySelector('.chr-network--global')?.classList.add('chr-network--fullscreen');
    const button = results?.querySelector<HTMLButtonElement>('[data-chr="fullscreen-network"]');
    button?.setAttribute('aria-pressed', 'true');
    if (button) button.textContent = '× Cerrar pantalla completa';
  }
  if (focusSelector) host?.querySelector<HTMLElement>(focusSelector)?.focus();
}

async function handleAction(action: string, el: HTMLElement) {
  const id = el.dataset.id || '';
  const current = characterById(state.selectedId) ?? characterById(state.netSelected);
  switch (action) {
    case 'new':
      return go('character-form', {
        editingCharacterId: null,
        pendingRelatives: [],
        characterSearch: { status: 'idle', name: '', candidates: [], sources: [], error: '', suggestion: null, prompt: '', responseText: '' },
      });
    case 'open':
      return go('sheet', { selectedId: id });
    case 'back':
    case 'cancel':
      if (!(await confirmDiscard())) return;
      return go(state.mode === 'character-form' && state.editingCharacterId ? 'sheet' : state.mode === 'relation-form' ? 'sheet' : 'index', {
        relationDraft: null,
        editingCharacterId: null,
      });
    case 'view':
      state.view = el.dataset.view as IndexView;
      if (state.view === 'network') {
        state.netSelected = null;
        state.netReveal = true;
      }
      return paint();
    case 'edit':
      return current ? go('character-form', { editingCharacterId: current.id, pendingRelatives: [] }) : undefined;
    case 'delete': {
      if (!current) return;
      const links = relationCount(current.id);
      const ok = await api().confirm({
        eyebrow: 'ELIMINAR PERSONAJE',
        title: `¿Eliminar a «${current.name}»?`,
        message: links
          ? `Se borrará la ficha y también ${links} vínculo${links === 1 ? '' : 's'} con otros personajes.`
          : 'Se borrará la ficha.',
        confirmLabel: 'Sí, eliminar',
        danger: true,
      });
      if (!ok) return;
      const cascade = removeCharacterCascade(data.characters, data.relations, current.id);
      for (const relationId of cascade.removedRelationIds) await api().deleteRelation(relationId);
      await api().deleteCharacter(current.id);
      await reload();
      return go('index', { selectedId: null, notice: `Se eliminó a «${current.name}».` });
    }
    case 'add-relation':
      return current ? go('relation-form', { relationDraft: { fromId: current.id, editingId: null } }) : undefined;
    case 'find-family':
      return startFamilySearch();
    case 'copy-family-prompt':
      return copyFamilyPrompt();
    case 'parse-family': {
      const response = host?.querySelector<HTMLTextAreaElement>('#chrFamilyResponse')?.value || '';
      try {
        const character = characterById(state.selectedId);
        if (!character) throw Error('No se encontró la ficha del personaje.');
        state.familyReview = { ...state.familyReview, status: 'review', relatives: parseFamilySuggestions(response, character), responseText: '', error: '' };
      }
      catch (err: any) { state.familyReview = { ...state.familyReview, responseText: response, error: String(err?.message || err) }; }
      return paint();
    }
    case 'apply-family':
      return applyFamilySuggestions();
    case 'cancel-family':
      autoAbort?.abort();
      state.familyReview = { status: 'idle', prompt: '', responseText: '', error: '', relatives: [] };
      return paint();
    case 'edit-relation':
      return current ? go('relation-form', { relationDraft: { fromId: current.id, editingId: el.dataset.rel || null } }) : undefined;
    case 'remove-relation': {
      const relation = data.relations.find((r) => r.id === el.dataset.rel);
      if (!relation || !current) return;
      const other = characterById(relation.fromId === current.id ? relation.toId : relation.fromId);
      const ok = await api().confirm({
        eyebrow: 'QUITAR VÍNCULO',
        title: '¿Quitar este vínculo?',
        message: `Se quitará «${relation.type}» entre ${current.name} y ${other?.name ?? 'otro personaje'}. Las fichas no se modifican.`,
        confirmLabel: 'Quitar',
        danger: true,
      });
      if (!ok) return;
      await api().deleteRelation(relation.id);
      await reload();
      return go('sheet', { selectedId: current.id, notice: 'Vínculo quitado.' });
    }
    case 'show-network':
      return current ? (state.netFocus = current.id, state.netSelected = null, state.view = 'network', go('index', { selectedId: current.id })) : undefined;
    case 'add-evidence': {
      const rows = host?.querySelector('#chrEvidenceRows');
      if (!rows || rows.children.length >= LIMITS.evidence) return;
      rows.insertAdjacentHTML('beforeend', evidenceRowHTML());
      rows.lastElementChild?.querySelector<HTMLElement>('[data-f=ref]')?.focus();
      return;
    }
    case 'remove-evidence': {
      const row = el.closest('.chr-evidence-row');
      const next = (row?.nextElementSibling || row?.previousElementSibling) as HTMLElement | null;
      row?.remove();
      (next?.querySelector<HTMLElement>('[data-f=ref]') || host?.querySelector<HTMLElement>('[data-chr=add-evidence]'))?.focus();
      return;
    }
    case 'ask': {
      const scope = el.dataset.scope;
      el.closest('.chr-field-ai-menu')?.removeAttribute('open');
      if (scope === 'character') return startAI({ kind: 'character' });
      if (scope === 'field') return startAI({ kind: 'field', field: el.dataset.field as CharacterFieldKey | 'name' });
      if (scope === 'relation') return startAI({ kind: 'relation', otherId: el.dataset.other || '', relationId: el.dataset.rel });
      return;
    }
    case 'add-sheet-link':
      return addSheetLinkRow();
    case 'autofill':
      return startAI({ kind: 'character' }, true);
    case 'search-character':
      return startCharacterSearch();
    case 'parse-candidates':
      return parseCandidateResponse();
    case 'investigate-character':
      return prepareSelectedProfile();
    case 'parse-profile':
      return parseProfileResponse();
    case 'cancel-auto':
      autoAbort?.abort();
      setAutoAbort(null);
      setAutoNote('');
      state.growth = { status: 'idle', error: '', result: null };
      state.characterSearch = { status: 'idle', name: '', candidates: [], sources: [], error: '', suggestion: null, prompt: '', responseText: '' };
      state.networkReview = { status: 'idle', prompt: '', responseText: '', error: '', proposals: [], manualFindings: [] };
      return paint();
    case 'copy-research-prompt':
      return copyResearchPrompt();
    case 'apply-research':
      applyWebResearch();
      return;
    case 'apply-research-and-save': {
      applyWebResearch();
      const form = host?.querySelector<HTMLFormElement>('#chrCharacterForm');
      if (form) return submitCharacterForm(form);
      return;
    }
    case 'none-candidate':
      state.characterSearch = { status: 'idle', name: host?.querySelector<HTMLInputElement>('[name="name"]')?.value || state.characterSearch.name, candidates: [], sources: [], error: '', suggestion: null, prompt: '', responseText: '' };
      paint();
      showFormErrors([], ['No se modificó la ficha. Conservá el nombre y completala manualmente o iniciá otra búsqueda.']);
      return;
    case 'apply-autofill': {
      const ai = state.ai;
      if (!ai?.formTarget) return;
      try {
        const raw = ai.text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
        const suggestion = JSON.parse(raw);
        state.pendingRelatives = (Array.isArray(suggestion.relatives) ? suggestion.relatives : []).slice(0, 20).flatMap((r: any, index: number) => {
          const checked = host?.querySelector<HTMLInputElement>(`[data-relative-index="${index}"]`)?.checked;
          if (!checked || typeof r.name !== 'string' || !r.name.trim()) return [];
          return [{ name: r.name.trim(), type: typeof r.type === 'string' ? r.type : 'Familiar', direction: r.direction === 'in' ? 'in' as const : 'out' as const, certainty: r.certainty === 'explicit' || r.certainty === 'inferred' ? r.certainty : 'unknown' as Certainty, evidence: String(r.evidence ?? '') }];
        });
        const setValue = (name: string, value: unknown, transform = (x: any) => String(x ?? '')) => {
          const field = host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
          if (field && !field.value.trim()) field.value = transform(value);
        };
        setValue('aliases', suggestion.aliases, (x) => Array.isArray(x) ? x.join('\n') : '');
        setValue('age', suggestion.age);
        setValue('description', suggestion.description);
        setValue('traits', suggestion.traits, (x) => Array.isArray(x) ? x.join(', ') : '');
        setValue('occupation', suggestion.occupation);
        setValue('affiliation', suggestion.affiliation);
        for (const field of FIELD_KEYS) {
          const cert = host?.querySelector<HTMLSelectElement>(`[name="cert_${field}"]`);
          const value = suggestion.certainty?.[field];
          if (cert && !cert.value && ['explicit', 'inferred'].includes(value)) cert.value = value;
        }
        const evidenceRows = host?.querySelector<HTMLElement>('#chrEvidenceRows');
        const evidenceMap = suggestion.evidence && typeof suggestion.evidence === 'object' ? suggestion.evidence : {};
        for (const field of FIELD_KEYS) {
          const ref = String(evidenceMap[field] ?? '').trim();
          if (ref && evidenceRows && evidenceRows.children.length < LIMITS.evidence) {
            evidenceRows.insertAdjacentHTML('beforeend', evidenceRowHTML({ kind: 'other', ref: ref.slice(0, LIMITS.evidenceRef), text: `Respaldo sugerido para ${FIELD_LABELS[field]} (revisar)` }));
          }
        }
        showFormErrors([], ['Se aplicaron solo los campos vacíos. Revisá los datos y sus fuentes antes de guardar.']);
      } catch {
        showFormErrors(['La respuesta de la IA no tiene el formato esperado. Volvé a consultar o copiá los datos manualmente.']);
      }
      return;
    }
    case 'use-name-suggestion': {
      const nameInput = host?.querySelector<HTMLInputElement>('#chr_name');
      const suggestedName = el.dataset.suggestedName?.trim();
      if (nameInput && suggestedName) {
        nameInput.value = suggestedName;
        nameInput.focus();
      }
      return;
    }
    case 'ask-pair': {
      const otherId = host?.querySelector<HTMLSelectElement>('#chrPairSelect')?.value;
      return otherId ? startAI({ kind: 'relation', otherId }) : undefined;
    }
    case 'ai-stop':
      return abortAI();
    case 'ai-close':
      abortAI();
      state.ai = null;
      paintAI();
      return;
    case 'ai-key':
      return api().ai.openSettings();
    case 'grow-network':
      return state.growth.status === 'idle' ? startGrowth() : undefined;
    case 'apply-growth':
      return applyGrowth();
    case 'cancel-growth':
      state.growth = { status: 'idle', error: '', result: null };
      return paint();
    case 'animate-network':
      state.netReveal = true;
      repaintResults();
      return openNetworkShare({ bookTitle: book?.title || 'Mi libro', characters: data.characters, relations: data.relations });
    case 'analyze-network':
    case 'new-network-analysis':
      return startNetworkAnalysis();
    case 'copy-network-prompt':
      return copyNetworkPrompt();
    case 'create-missing-character':
      return createMissingNetworkCharacter(Number(el.dataset.index));
    case 'parse-network-review':
      return parseNetworkReview();
    case 'cancel-network-review':
      state.networkReview = { status: 'idle', prompt: '', responseText: '', error: '', proposals: [], manualFindings: [] };
      return paint();
    case 'accept-network-proposal':
      return decideNetworkProposal(Number(el.dataset.index), 'accepted');
    case 'reject-network-proposal':
      return decideNetworkProposal(Number(el.dataset.index), 'rejected');
    case 'apply-network-accepted':
      return applyNetworkProposals();
    case 'net-select':
      state.netSelected = id;
      state.netFocus = id;
      if (el.tagName === 'BUTTON') {
        repaintResults();
        const details = host?.querySelector<HTMLElement>('.chr-net-details');
        details?.focus({ preventScroll: true });
        details?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      return repaintResults(`[data-chr="net-select"][data-id="${CSS.escape(id)}"]`);
    case 'net-zoom-in':
      state.netZoom = Math.min(3, Math.round((state.netZoom + 0.25) * 100) / 100);
      return repaintResults('[data-chr="net-zoom-in"]');
    case 'net-zoom-out':
      state.netZoom = Math.max(1, Math.round((state.netZoom - 0.25) * 100) / 100);
      return repaintResults('[data-chr="net-zoom-out"]');
    case 'net-zoom-reset':
      state.netZoom = 1;
      return repaintResults('[data-chr="net-zoom-reset"]');
    case 'fullscreen-network': {
      const network = host?.querySelector<HTMLElement>('.chr-network--global');
      if (!network) return;
      const fullscreen = network.classList.toggle('chr-network--fullscreen');
      el.setAttribute('aria-pressed', String(fullscreen));
      el.textContent = fullscreen ? '× Cerrar pantalla completa' : '⛶ Pantalla completa';
      return;
    }
    case 'filter-isolated':
      state.netIsolatedOnly = !state.netIsolatedOnly;
      return repaintResults('[data-chr="filter-isolated"]');
  }
}

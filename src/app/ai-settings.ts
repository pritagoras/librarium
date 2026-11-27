import type { AISettings } from '../types';

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector(selector) as T | null;
const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char),
  );

const AI_SETTINGS_KEY = 'librarium-ai-settings';
const PRIVATE_GEMINI_KEY = 'librarium-private-gemini-key';
const AI_SETTINGS_DEFAULTS: AISettings = {
  model: 'gemini-3.8-flash',
  thinking: 'auto',
  chatModel: '',
  chatThinking: 'inherit',
  analysisModel: '',
  analysisThinking: 'inherit',
  imageModel: '',
  imageThinking: 'inherit',
  style: 'natural',
  customStyle: '',
};

export type AITaskProfile = 'chat' | 'analysis' | 'image';
type GeminiModelChoice = { id: string; name: string; thinking: boolean };
let availableGeminiModels: GeminiModelChoice[] = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', thinking: true },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', thinking: true },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', thinking: true },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', thinking: true },
];

export function getPrivateGeminiKey(): string {
  try {
    return localStorage.getItem(PRIVATE_GEMINI_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

export function isAIKeyError(err: any): boolean {
  if (!getPrivateGeminiKey()) return true;
  if ([401, 403].includes(Number(err?.status))) return true;
  const msg = String(err?.message || err || '');
  return /api key|api_key|clave personal|ajustes de ia|no es válida|permission/i.test(msg);
}

export function openAISettingsGuide() {
  const dlg = $<HTMLDialogElement>('#settingsDialog');
  if (!dlg) return;
  if (!dlg.open) dlg.showModal();
  const guide = $<HTMLDetailsElement>('#privateKeyGuide');
  if (guide) guide.open = true;
  const section = $('.private-key-settings');
  if (section) {
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    section.classList.add('private-key-highlight');
    setTimeout(() => section.classList.remove('private-key-highlight'), 2400);
  }
  setTimeout(() => $<HTMLInputElement>('#privateGeminiKeyInput')?.focus(), 120);
}

export function syncGeminiNoKeyBanner() {
  $('#geminiNoKeyBanner')?.classList.toggle('hidden', Boolean(getPrivateGeminiKey()));
}

export function renderInlineKeyCTA(statusEl: HTMLElement | null, message: string) {
  if (!statusEl) return;
  statusEl.replaceChildren();
  statusEl.append(document.createTextNode(message + ' '));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ai-key-cta';
  btn.textContent = 'Configurar mi API key';
  btn.onclick = () => openAISettingsGuide();
  statusEl.append(btn);
}

export function requestGeminiFeature(route: string, payload: Record<string, any>, signal?: AbortSignal): Promise<Response> {
  const apiKey = getPrivateGeminiKey();
  if (apiKey) return import('../gemini-direct').then(({ directGeminiRequest }) => directGeminiRequest(route, payload, apiKey, signal));
  return Promise.resolve(new Response(JSON.stringify({
    error: 'Para usar la IA, guardá tu API key personal de Gemini en Ajustes → Ajustes de IA.',
  }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
}

export function getAISettings(): AISettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}');
    const safeModel = (value: unknown, fallback: string) => {
      const candidate = String(value || '');
      if (candidate === 'gemini-4-hydrogen') return AI_SETTINGS_DEFAULTS.model;
      return /^gemini-[a-z0-9.-]{1,80}$/.test(candidate) ? candidate : fallback;
    };
    const thinking = ['auto', 'minimal', 'low', 'medium', 'high'].includes(parsed.thinking)
      ? parsed.thinking
      : AI_SETTINGS_DEFAULTS.thinking;
    const safeTaskThinking = (value: unknown): AISettings['chatThinking'] =>
      value === 'inherit' || ['auto', 'minimal', 'low', 'medium', 'high'].includes(String(value))
        ? value as AISettings['chatThinking']
        : 'inherit';
    return {
      ...AI_SETTINGS_DEFAULTS,
      ...parsed,
      model: safeModel(parsed.model, AI_SETTINGS_DEFAULTS.model),
      thinking,
      chatModel: safeModel(parsed.chatModel, ''),
      chatThinking: safeTaskThinking(parsed.chatThinking),
      analysisModel: safeModel(parsed.analysisModel, ''),
      analysisThinking: safeTaskThinking(parsed.analysisThinking),
      imageModel: safeModel(parsed.imageModel, ''),
      imageThinking: safeTaskThinking(parsed.imageThinking),
    };
  } catch {
    return { ...AI_SETTINGS_DEFAULTS };
  }
}

export function getAISettingsForTask(task: AITaskProfile): AISettings {
  const settings = getAISettings();
  const profile = task === 'chat'
    ? { model: settings.chatModel, thinking: settings.chatThinking }
    : task === 'analysis'
      ? { model: settings.analysisModel, thinking: settings.analysisThinking }
      : { model: settings.imageModel, thinking: settings.imageThinking };
  return {
    ...settings,
    model: profile.model || settings.model,
    thinking: profile.thinking === 'inherit' ? settings.thinking : profile.thinking,
  };
}

function fillModelSelect(select: HTMLSelectElement, selectedValue = select.value) {
  const inheritedLabel = select.dataset.inheritOption;
  select.replaceChildren();
  if (inheritedLabel) {
    const inherited = document.createElement('option');
    inherited.value = '';
    inherited.textContent = inheritedLabel;
    select.append(inherited);
  }
  for (const model of availableGeminiModels) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.name} · ${model.id}`;
    select.append(option);
  }
  if (selectedValue && !availableGeminiModels.some((model) => model.id === selectedValue)) {
    const saved = document.createElement('option');
    saved.value = selectedValue;
    saved.textContent = `${selectedValue} · no aparece en la última lista`;
    select.append(saved);
  }
  select.value = selectedValue;
  if (select.value !== selectedValue) select.value = inheritedLabel ? '' : availableGeminiModels[0]?.id || '';
}

export function populateAIModelSelects() {
  const ai = getAISettings();
  const selections: Record<string, string> = {
    aiModel: ai.model,
    aiChatModel: ai.chatModel,
    aiAnalysisModel: ai.analysisModel,
    aiImageModel: ai.imageModel,
  };
  document.querySelectorAll<HTMLSelectElement>('[data-model-select], #aiModel').forEach((select) => {
    fillModelSelect(select, selections[select.id] ?? select.value);
  });
}

function supportedThinkingLevels(modelId: string): AISettings['thinking'][] {
  if (/^gemini-[34](?:[.-])/.test(modelId)) {
    const levels: AISettings['thinking'][] = ['auto', 'low', 'medium', 'high'];
    if (/flash-lite|3\.(?:6|5)-flash|3-flash-preview/i.test(modelId)) levels.splice(1, 0, 'minimal');
    return levels;
  }
  return ['auto'];
}

function updateThinkingSelect(select: HTMLSelectElement, modelId: string, selectedValue: string) {
  const inheritedLabel = select.dataset.inheritOption;
  const levels = supportedThinkingLevels(modelId);
  select.replaceChildren();
  if (inheritedLabel) {
    const inherited = document.createElement('option');
    inherited.value = 'inherit';
    inherited.textContent = inheritedLabel;
    select.append(inherited);
  }
  for (const value of levels) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = ({ auto: 'Automático', minimal: 'Mínimo', low: 'Bajo', medium: 'Medio', high: 'Alto' })[value];
    select.append(option);
  }
  select.value = levels.includes(selectedValue as AISettings['thinking']) || selectedValue === 'inherit'
    ? selectedValue
    : inheritedLabel ? 'inherit' : 'auto';
}

export function syncAIThinkingOptions() {
  const pairs = [
    ['aiModel', 'aiThinking', false],
    ['aiChatModel', 'aiChatThinking', true],
    ['aiAnalysisModel', 'aiAnalysisThinking', true],
    ['aiImageModel', 'aiImageThinking', true],
  ] as const;
  for (const [modelId, thinkingId, isTask] of pairs) {
    const model = $<HTMLSelectElement>(`#${modelId}`);
    const thinking = $<HTMLSelectElement>(`#${thinkingId}`);
    if (!model || !thinking) continue;
    const taskModel = isTask && !model.value ? $<HTMLSelectElement>('#aiModel')?.value || '' : model.value;
    updateThinkingSelect(thinking, taskModel, thinking.value || (isTask ? 'inherit' : 'auto'));
  }
}

export function thinkingLabel(level: AISettings['thinking']) {
  return ({ auto: 'automático', minimal: 'mínimo', low: 'bajo', medium: 'medio', high: 'alto' })[level];
}

export async function refreshAIModels() {
  const status = $('#aiSettingsStatus');
  const button = $<HTMLButtonElement>('#refreshAIModels');
  if (!getPrivateGeminiKey()) {
    if (status) status.textContent = 'Guardá tu API key personal para consultar los modelos habilitados para tu clave.';
    return;
  }
  if (button) button.disabled = true;
  if (status) status.textContent = 'Consultando los modelos disponibles para tu clave…';
  try {
    const response = await requestGeminiFeature('list-models', {});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `Error HTTP ${response.status}`);
    const models = Array.isArray(result.models) ? result.models as GeminiModelChoice[] : [];
    if (!models.length) throw Error('Google no devolvió modelos compatibles con generateContent.');
    availableGeminiModels = models;
    populateAIModelSelects();
    syncAIThinkingOptions();
    if (status) status.textContent = `${models.length} modelos compatibles disponibles para tu clave. La lista viene directamente de Google.`;
  } catch (error: any) {
    if (status) status.textContent = `No se pudo actualizar la lista: ${error.message || 'error de conexión'}`;
  } finally {
    if (button) button.disabled = false;
  }
}

export function saveAISettings() {
  const settings: AISettings = {
    model: $<HTMLSelectElement>('#aiModel')?.value || AI_SETTINGS_DEFAULTS.model,
    thinking: ($<HTMLSelectElement>('#aiThinking')?.value as AISettings['thinking']) || 'auto',
    chatModel: $<HTMLSelectElement>('#aiChatModel')?.value || '',
    chatThinking: ($<HTMLSelectElement>('#aiChatThinking')?.value as AISettings['chatThinking']) || 'inherit',
    analysisModel: $<HTMLSelectElement>('#aiAnalysisModel')?.value || '',
    analysisThinking: ($<HTMLSelectElement>('#aiAnalysisThinking')?.value as AISettings['analysisThinking']) || 'inherit',
    imageModel: $<HTMLSelectElement>('#aiImageModel')?.value || '',
    imageThinking: ($<HTMLSelectElement>('#aiImageThinking')?.value as AISettings['imageThinking']) || 'inherit',
    style: ($<HTMLSelectElement>('#aiStyle')?.value as AISettings['style']) || 'natural',
    customStyle: ($<HTMLTextAreaElement>('#aiCustomStyle')?.value || '').trim().slice(0, 600),
  };
  try {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
    $('#aiSettingsStatus')!.textContent = 'Preferencias guardadas en este navegador.';
  } catch {
    $('#aiSettingsStatus')!.textContent = 'No se pudieron guardar las preferencias.';
  }
  $('#aiCustomStyleWrap')?.classList.toggle('hidden', settings.style !== 'custom');
  syncAIThinkingOptions();
}

/** Solo el tono y la extensión elegidos en Ajustes, sin la política de contexto de las notas. */
export function aiStyleOnly(settings = getAISettings()): string {
  const styles: Record<string, string> = {
    natural: 'Respondé en español, con claridad y tono natural. Explicá los términos difíciles cuando ayude.',
    concise: 'Respondé en español de forma breve y directa. Priorizá la respuesta principal y evitá repeticiones.',
    detailed:
      'Respondé en español con detalle y análisis ordenado. Desarrollá las ideas importantes sin agregar datos no respaldados.',
    socratic:
      'Respondé en español con preguntas orientadoras que ayuden a pensar el pasaje, junto con una explicación útil.',
  };
  const base = styles[settings.style] || styles.natural;
  return `${base}${
    settings.style === 'custom' && settings.customStyle ? `\nPreferencias adicionales: ${settings.customStyle}` : ''
  }`;
}

export function aiStyleInstruction(settings = getAISettings()): string {
  const contextPolicy =
    'Tomá la nota, el pasaje y el libro como contexto. Si el usuario pide relacionarlos, compararlos o aplicarlos a otro autor, obra, época o concepto, contestá directamente esa consigna con conocimiento general pertinente. No empieces aclarando que ese autor o tema no aparece en el fragmento, ni limites la respuesta al material citado, salvo que el usuario pida expresamente un análisis exclusivo de ese material. Separá con naturalidad lo que dice la fuente de la comparación o interpretación cuando sea útil. Evitá advertencias y aclaraciones genéricas; mencioná una limitación solo si cambia de verdad la respuesta.';
  const style = aiStyleOnly(settings);
  const [base, ...custom] = style.split('\nPreferencias adicionales: ');
  return `${base}\n${contextPolicy}${custom.length ? `\nPreferencias adicionales: ${custom.join('')}` : ''}`;
}

export function commentDiscussionPrompt(subject: string) {
  return `Quiero que evalúes críticamente mi comentario personal sobre ${subject}. Decime qué parte está bien fundamentada, qué puede ser discutible o incorrecto, y proponé contraargumentos razonables cuando corresponda. Decime con claridad si coincidís o no y por qué; no estés de acuerdo solo por cortesía. Tené en cuenta el libro y el fragmento asociados.`;
}

export function initAISettings() {
  const ai = getAISettings();
  const privateKeyInput = $<HTMLInputElement>('#privateGeminiKeyInput');
  const privateKeyStatus = $('#privateGeminiKeyStatus');
  populateAIModelSelects();
  ($<HTMLSelectElement>('#aiModel')!).value = ai.model;
  ($<HTMLSelectElement>('#aiThinking')!).value = ai.thinking;
  ($<HTMLSelectElement>('#aiChatModel')!).value = ai.chatModel;
  ($<HTMLSelectElement>('#aiChatThinking')!).value = ai.chatThinking;
  ($<HTMLSelectElement>('#aiAnalysisModel')!).value = ai.analysisModel;
  ($<HTMLSelectElement>('#aiAnalysisThinking')!).value = ai.analysisThinking;
  ($<HTMLSelectElement>('#aiImageModel')!).value = ai.imageModel;
  ($<HTMLSelectElement>('#aiImageThinking')!).value = ai.imageThinking;
  syncAIThinkingOptions();
  ($<HTMLSelectElement>('#aiStyle')!).value = ai.style;
  ($<HTMLTextAreaElement>('#aiCustomStyle')!).value = ai.customStyle;
  $('#aiCustomStyleWrap')?.classList.toggle('hidden', ai.style !== 'custom');

  ['#aiModel', '#aiThinking', '#aiChatModel', '#aiChatThinking', '#aiAnalysisModel', '#aiAnalysisThinking', '#aiImageModel', '#aiImageThinking', '#aiStyle'].forEach((selector) =>
    $(selector)?.addEventListener('change', () => {
      syncAIThinkingOptions();
      saveAISettings();
    }),
  );
  $('#refreshAIModels')?.addEventListener('click', () => void refreshAIModels());
  $('#aiCustomStyle')?.addEventListener('input', saveAISettings);

  if (privateKeyStatus) {
    privateKeyStatus.textContent = getPrivateGeminiKey()
      ? 'Clave guardada en este navegador. Las consultas de IA se envían directamente a Google.'
      : 'No hay una clave global de Librarium. Guardá tu clave personal para usar la IA.';
  }
  $('#savePrivateGeminiKey')?.addEventListener('click', () => {
    const key = privateKeyInput?.value.trim() || '';
    if (!key) {
      if (privateKeyStatus) privateKeyStatus.textContent = 'Pegá tu API key antes de guardarla.';
      return;
    }
    try {
      localStorage.setItem(PRIVATE_GEMINI_KEY, key);
      if (privateKeyInput) privateKeyInput.value = '';
      if (privateKeyStatus) privateKeyStatus.textContent = 'Clave guardada solo en este navegador. La IA usará conexiones directas con Google.';
      syncGeminiNoKeyBanner();
      void refreshAIModels();
    } catch {
      if (privateKeyStatus) privateKeyStatus.textContent = 'No se pudo guardar la clave en el almacenamiento local de este navegador.';
    }
  });
  $('#removePrivateGeminiKey')?.addEventListener('click', () => {
    try {
      localStorage.removeItem(PRIVATE_GEMINI_KEY);
      if (privateKeyInput) privateKeyInput.value = '';
      if (privateKeyStatus) privateKeyStatus.textContent = 'Clave eliminada. La IA queda desactivada hasta que guardes otra clave personal.';
      syncGeminiNoKeyBanner();
    } catch {
      if (privateKeyStatus) privateKeyStatus.textContent = 'No se pudo eliminar la clave de este navegador.';
    }
  });
  $('#togglePrivateGeminiKey')?.addEventListener('click', (event) => {
    if (!privateKeyInput) return;
    const button = event.currentTarget as HTMLButtonElement;
    const revealing = privateKeyInput.type === 'password';
    privateKeyInput.type = revealing ? 'text' : 'password';
    button.textContent = revealing ? 'Ocultar' : 'Mostrar';
  });


}


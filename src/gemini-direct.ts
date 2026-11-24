type Payload = Record<string, any>;

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODELS = [DEFAULT_MODEL, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

function apiError(data: any, status: number): Error & { status?: number } {
  const error = new Error(data?.error?.message || `Google Gemini respondió HTTP ${status}.`) as Error & {
    status?: number;
  };
  error.status = status;
  return error;
}

function thinkingConfig(level?: string, model?: string) {
  const selected = level && level !== 'auto' ? level.toUpperCase() : '';
  if (selected && !/^gemini-[34](?:[.-])/.test(model || '')) return {};
  return selected ? { thinkingConfig: { thinkingLevel: selected } } : {};
}

function modelFor(payload: Payload) {
  const selected = String(payload.model || DEFAULT_MODEL).trim();
  return /^gemini-[a-z0-9.-]{1,80}$/.test(selected) ? selected : DEFAULT_MODEL;
}

async function listModels(apiKey: string, signal?: AbortSignal) {
  const models: any[] = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) query.set('pageToken', pageToken);
    const response = await fetch(`${API_ROOT}?${query}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal,
    });
    if (!response.ok) {
      let details: any = {};
      try { details = await response.json(); } catch {}
      throw apiError(details, response.status);
    }
    const result = await response.json();
    models.push(...(Array.isArray(result.models) ? result.models : []));
    pageToken = String(result.nextPageToken || '');
  } while (pageToken && models.length < 2000);

  return models
    .filter((model) => {
      const id = String(model.name || '').replace(/^models\//, '');
      return /^gemini-[a-z0-9.-]+$/i.test(id)
        && model.supportedGenerationMethods?.includes('generateContent')
        && !/(?:image|live|tts|transcrib|embedding|robotics)/i.test(id);
    })
    .map((model) => ({
      id: String(model.name).replace(/^models\//, ''),
      name: String(model.displayName || model.name).slice(0, 120),
      thinking: Boolean(model.thinking),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function googleRequest(
  apiKey: string,
  model: string,
  request: Payload,
  signal?: AbortSignal,
  streaming = false,
) {
  const url = `${API_ROOT}/${encodeURIComponent(model)}:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    let details: any = {};
    try { details = await response.json(); } catch {}
    throw apiError(details, response.status);
  }
  return response;
}

async function generate(
  apiKey: string,
  preferredModel: string,
  requestForModel: (model: string) => Payload,
  signal?: AbortSignal,
) {
  const models = [preferredModel, ...FALLBACK_MODELS.filter((model) => model !== preferredModel)];
  let lastError: any;
  for (const model of models) {
    try {
      const response = await googleRequest(apiKey, model, requestForModel(model), signal);
      const result = await response.json();
      const text = (result.candidates?.[0]?.content?.parts || [])
        .map((part: any) => part.text || '')
        .join('');
      if (!text.trim()) throw Error('Gemini no devolvió texto.');
      return { text: text.trim(), model };
    } catch (error: any) {
      lastError = error;
      if (error?.name === 'AbortError' || ![404, 429, 503].includes(error?.status) || model === models.at(-1)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  throw lastError || Error('No se pudo consultar Gemini.');
}

function textRequest(contents: any, systemInstruction: string, model: string, thinking?: string, extra: Payload = {}) {
  return {
    contents,
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    generationConfig: { ...thinkingConfig(thinking, model), ...extra },
  };
}

function parseJson(text: string) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

function responseJSON(data: any) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function errorJSON(error: any) {
  const status = Number(error?.status) || 500;
  return new Response(JSON.stringify({ error: error?.message || 'No se pudo consultar Gemini.' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function directGeminiRequest(
  route: string,
  payload: Payload,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    if (route === 'list-models') {
      return responseJSON({ models: await listModels(apiKey, signal) });
    }
    const preferred = modelFor(payload);
    if (route === 'chat-stream') {
      const models = [preferred, ...FALLBACK_MODELS.filter((model) => model !== preferred)];
      let lastError: any;
      for (const model of models) {
        try {
          const response = await googleRequest(
            apiKey,
            model,
            textRequest(payload.contents, payload.systemInstruction || '', model, payload.thinking),
            signal,
            true,
          );
          return new Response(response.body, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Librarium-Model': model },
          });
        } catch (error: any) {
          lastError = error;
          if (error?.name === 'AbortError' || ![404, 429, 503].includes(error?.status) || model === models.at(-1)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      throw lastError || Error('No se pudo consultar Gemini.');
    }

    if (route === 'transcribe') {
      const prompt = 'Transcribí fielmente todo el texto legible de esta página, en el idioma original. Conservá palabras, acentos, puntuación y párrafos. No traduzcas, resumas, corrijas ni agregues explicaciones. Si un fragmento es realmente ilegible, indicá [ilegible]. Devolvé únicamente la transcripción, sin Markdown ni comentarios.';
      const result = await generate(apiKey, preferred, (model) => textRequest([{ role: 'user', parts: [
        { text: prompt }, { inlineData: { mimeType: payload.mimeType || 'image/jpeg', data: payload.data } },
      ] }], '', model, payload.thinking), signal);
      return responseJSON({ text: result.text, model: result.model });
    }

    if (route === 'book-autofill') {
      const tags = Array.isArray(payload.existingTags) ? payload.existingTags.map(String).filter(Boolean).slice(0, 40) : [];
      const prompt = [
        'Completá los datos bibliográficos disponibles y sugerí etiquetas temáticas en español para este libro.',
        payload.title ? `Título ingresado: ${String(payload.title).slice(0, 300)}` : '',
        payload.author ? `Autor ingresado: ${String(payload.author).slice(0, 300)}` : '',
        payload.isbn ? `ISBN ingresado: ${String(payload.isbn).slice(0, 32)}` : '',
        tags.length ? `Etiquetas ya existentes en la biblioteca del usuario (reutilizalas si aplican): ${tags.join(', ')}` : '',
        'Reglas estrictas:',
        '- Si un dato (como editorial, año o cantidad de páginas) no es seguro o no figura en la imagen, devolvé cadena vacía "" o 0 en totalPages en lugar de inventar.',
        '- En "tags" devolvé entre 2 y 5 etiquetas breves y útiles en español (máximo 24 caracteres cada una, formato título).',
      ].filter(Boolean).join('\n');
      const parts: any[] = [{ text: prompt }];
      if (payload.coverImage?.data) parts.push({ inlineData: { mimeType: payload.coverImage.mimeType || 'image/jpeg', data: payload.coverImage.data } });
      const schema = { type: 'OBJECT', properties: {
        title: { type: 'STRING' }, author: { type: 'STRING' }, publisher: { type: 'STRING' }, year: { type: 'STRING' },
        totalPages: { type: 'INTEGER' }, tags: { type: 'ARRAY', items: { type: 'STRING' } },
      } };
      const result = await generate(apiKey, preferred, (model) => textRequest(
        [{ role: 'user', parts }],
        'Sos un bibliotecario preciso. Respondés únicamente con JSON válido según el esquema y nunca inventás datos bibliográficos inciertos.',
        model, payload.thinking, { responseMimeType: 'application/json', responseSchema: schema },
      ), signal);
      const parsed = parseJson(result.text);
      return responseJSON({ suggestion: {
        title: String(parsed.title || '').trim().slice(0, 300), author: String(parsed.author || '').trim().slice(0, 300),
        publisher: String(parsed.publisher || '').trim().slice(0, 200), year: String(parsed.year || '').replace(/[^0-9]/g, '').slice(0, 4),
        totalPages: Number.isFinite(Number(parsed.totalPages)) && Number(parsed.totalPages) > 0 ? Math.min(20000, Math.round(Number(parsed.totalPages))) : 0,
        tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: unknown) => String(t).trim().slice(0, 32)).filter(Boolean).slice(0, 5) : [],
      }, model: result.model });
    }

    if (route === 'book-synthesis') {
      const sources = (Array.isArray(payload.items) ? payload.items : []).slice(0, 80).map((item: any) => {
        const header = `[${item.refId}] (${item.kindLabel}${item.location ? ` · ${item.location}` : ''})`;
        const comment = item.comment ? `\nReflexión del lector: ${String(item.comment).slice(0, 800)}` : '';
        return `${header}\n${String(item.text || '').slice(0, 2000)}${comment}`;
      }).join('\n\n---\n\n');
      const prompt = [
        `Analizá el cuaderno de lectura del libro «${payload.bookTitle}»${payload.bookAuthor ? ` de ${payload.bookAuthor}` : ''}.`,
        Array.isArray(payload.bookTags) && payload.bookTags.length ? `Etiquetas del lector: ${payload.bookTags.join(', ')}.` : '',
        'A continuación tenés las citas, anotaciones y notas comentadas que reunió el lector, cada una identificada con su código entre corchetes:',
        sources,
        'Elaborá una síntesis estructurada en español que revele hilos conductores reales entre los fragmentos elegidos por el lector:',
        '1. "summary": síntesis clara y profunda (2 a 4 párrafos). 2. "themes": entre 3 y 6 ejes temáticos breves.',
        '3. "connections": entre 2 y 8 conexiones concretas entre fragmentos; en "refs" usá exactamente los códigos provistos.',
        '4. "questions": entre 3 y 5 preguntas abiertas. Basate en el material y el contexto de la obra sin inventar citas.',
      ].filter(Boolean).join('\n\n');
      const schema = { type: 'OBJECT', properties: {
        summary: { type: 'STRING' }, themes: { type: 'ARRAY', items: { type: 'STRING' } },
        connections: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
          title: { type: 'STRING' }, explanation: { type: 'STRING' }, refs: { type: 'ARRAY', items: { type: 'STRING' } },
        } } }, questions: { type: 'ARRAY', items: { type: 'STRING' } },
      } };
      const result = await generate(apiKey, preferred, (model) => textRequest(prompt,
        'Sos un editor literario y asistente de lectura riguroso. Respondés siempre en español claro y preciso, devolviendo JSON válido según el esquema.',
        model, payload.thinking,
        { responseMimeType: 'application/json', responseSchema: schema },
      ), signal);
      const parsed = parseJson(result.text);
      return responseJSON({ analysis: {
        summary: String(parsed.summary || '').trim(),
        themes: Array.isArray(parsed.themes) ? parsed.themes.map(String).slice(0, 12) : [],
        connections: Array.isArray(parsed.connections) ? parsed.connections.slice(0, 20).map((c: any) => ({
          title: String(c?.title || 'Conexión temática').slice(0, 160), explanation: String(c?.explanation || '').slice(0, 2000),
          refs: Array.isArray(c?.refs) ? c.refs.map(String).slice(0, 8) : [],
        })) : [],
        questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).slice(0, 10) : [],
      }, model: result.model });
    }

    if (route === 'review-draft') {
      const snippets: string[] = [];
      if (Array.isArray(payload.quotes)) payload.quotes.slice(0, 25).forEach((q: any, i: number) => snippets.push(
        `Cita ${i + 1}${q.page != null ? ` (p. ${q.page})` : ''}: ${String(q.text || '').slice(0, 500)}${q.analysis ? ` | Reflexión: ${String(q.analysis).slice(0, 300)}` : ''}`,
      ));
      if (Array.isArray(payload.entries)) payload.entries.slice(0, 20).forEach((e: any, i: number) => snippets.push(
        `Anotación ${i + 1} (p. ${e.page ?? '?'}): ${e.title ? e.title + ': ' : ''}${String(e.text || '').slice(0, 400)}`,
      ));
      if (Array.isArray(payload.notes)) payload.notes.slice(0, 15).forEach((n: any) => { if (n.comment) snippets.push(`Comentario en nota ${n.number}: ${String(n.comment).slice(0, 350)}`); });
      const tags = Array.isArray(payload.existingTags) ? payload.existingTags.map(String).filter(Boolean).slice(0, 30) : [];
      const prompt = [
        `Redactá un borrador de reseña personal en primera persona (en español) para el libro «${payload.bookTitle}»${payload.bookAuthor ? ` de ${payload.bookAuthor}` : ''}.`,
        payload.rating ? `Puntuación dada por el lector: ${payload.rating}/5.` : '',
        payload.currentReview ? `Notas previas de reseña del lector:\n${String(payload.currentReview).slice(0, 1500)}` : '',
        snippets.length ? `Fragmentos y reflexiones guardadas por el lector:\n${snippets.join('\n')}` : 'El lector aún no guardó citas ni anotaciones; proponé una estructura breve y natural para que complete su experiencia de lectura.',
        tags.length ? `Etiquetas disponibles en su biblioteca: ${tags.join(', ')}` : '',
        'Devolvé JSON con "reviewDraft": reseña cálida, honesta y concisa en 2 o 3 párrafos, y "suggestedTags": entre 2 y 5 etiquetas temáticas breves.',
      ].filter(Boolean).join('\n\n');
      const schema = { type: 'OBJECT', properties: {
        reviewDraft: { type: 'STRING' }, suggestedTags: { type: 'ARRAY', items: { type: 'STRING' } },
      } };
      const result = await generate(apiKey, preferred, (model) => textRequest(prompt,
        'Sos un asistente editorial que ayuda al lector a ordenar sus propias impresiones en primera persona, en español natural. Respondé solo con JSON válido.',
        model, payload.thinking, { responseMimeType: 'application/json', responseSchema: schema },
      ), signal);
      const parsed = parseJson(result.text);
      return responseJSON({ reviewDraft: String(parsed.reviewDraft || '').trim().slice(0, 10000),
        suggestedTags: Array.isArray(parsed.suggestedTags) ? parsed.suggestedTags.map((t: unknown) => String(t).trim().slice(0, 32)).filter(Boolean).slice(0, 5) : [],
        model: result.model });
    }

    throw Error(`Función de IA no reconocida: ${route}`);
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    return errorJSON(error);
  }
}

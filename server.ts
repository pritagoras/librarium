import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const ALLOWED_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const;
type AllowedModel = (typeof ALLOWED_MODELS)[number];

function getGeminiClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw Object.assign(
      new Error('Falta configurar GEMINI_API_KEY en el servidor (Settings > Secrets).'),
      { status: 500 },
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function normalizeModel(requested?: string): AllowedModel {
  if (requested === 'gemini-3.1-flash-lite') return 'gemini-3.1-flash-lite';
  return 'gemini-4-hydrogen';
}

function resolveThinkingLevel(thinking: string | undefined, model: AllowedModel): ThinkingLevel | undefined {
  if (!thinking || thinking === 'auto') return undefined;
  if (thinking === 'low') return ThinkingLevel.LOW;
  if (thinking === 'medium') return ThinkingLevel.MEDIUM;
  if (thinking === 'high') return ThinkingLevel.HIGH;
  return model === 'gemini-3.1-flash-lite' ? ThinkingLevel.LOW : undefined;
}

async function generateWithFallback(
  paramsBuilder: (model: AllowedModel) => Parameters<GoogleGenAI['models']['generateContent']>[0],
  preferredModel?: string,
) {
  const ai = getGeminiClient();
  const primary = normalizeModel(preferredModel);
  const models: AllowedModel[] = [primary, ...ALLOWED_MODELS.filter((m) => m !== primary)];
  let lastError: unknown;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const response = await ai.models.generateContent(paramsBuilder(model));
      return { response, model };
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.code;
      if (status !== 503 && status !== 429) {
        throw err;
      }
      if (i === 0) {
        await new Promise((r) => setTimeout(r, 900));
      }
    }
  }
  throw lastError;
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));

  // Server-side Gemini Chat Endpoint
  app.post('/api/gemini/chat', async (req, res) => {
    try {
      const { contents, systemInstruction, model, thinking } = req.body || {};
      if (!Array.isArray(contents) || contents.length === 0) {
        return res.status(400).json({ error: 'Se requiere al menos un mensaje para consultar.' });
      }

      const { response, model: usedModel } = await generateWithFallback((m) => {
        const thinkingLevel = resolveThinkingLevel(thinking, m);
        const config: Record<string, unknown> = {};
        if (typeof systemInstruction === 'string' && systemInstruction.trim()) {
          config.systemInstruction = systemInstruction.trim();
        }
        if (thinkingLevel) {
          config.thinkingConfig = { thinkingLevel };
        }
        return {
          model: m,
          contents,
          config,
        };
      }, model);

      const text = (response.text || '').trim();
      if (!text) {
        return res.status(502).json({ error: 'Gemini no devolvió texto en la respuesta.' });
      }
      return res.json({ text, model: usedModel });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      return res.status(status).json({
        error: err?.message || 'Error al consultar el servicio de Gemini.',
      });
    }
  });

  // Server-side Quote Photo OCR Endpoint
  app.post('/api/gemini/transcribe', async (req, res) => {
    try {
      const { mimeType, data, model } = req.body || {};
      if (typeof data !== 'string' || !data.trim()) {
        return res.status(400).json({ error: 'Falta la imagen para transcribir.' });
      }
      const prompt =
        'Transcribí fielmente todo el texto legible de esta página, en el idioma original. ' +
        'Conservá palabras, acentos, puntuación y párrafos. No traduzcas, resumas, corrijas ni agregues explicaciones. ' +
        'Si un fragmento es realmente ilegible, indicá [ilegible]. Devolvé únicamente la transcripción, sin Markdown ni comentarios.';

      const { response, model: usedModel } = await generateWithFallback(
        (m) => ({
          model: m,
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                { inlineData: { mimeType: mimeType || 'image/jpeg', data } },
              ],
            },
          ],
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        }),
        model,
      );

      const text = (response.text || '').trim();
      if (!text) {
        return res.status(502).json({ error: 'Gemini no devolvió una transcripción.' });
      }
      return res.json({ text, model: usedModel });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      return res.status(status).json({
        error: err?.message || 'No se pudo transcribir la imagen.',
      });
    }
  });

  // Server-side Whole-Book Quotes & Notes Connections Synthesis Endpoint
  app.post('/api/gemini/book-synthesis', async (req, res) => {
    try {
      const { bookTitle, bookAuthor, bookTags, items, model, thinking } = req.body || {};
      if (!bookTitle || !Array.isArray(items) || items.length < 2) {
        return res.status(400).json({
          error: 'Se necesitan al menos 2 citas, anotaciones o notas comentadas para analizar conexiones.',
        });
      }

      const formattedSources = items
        .slice(0, 80)
        .map((item: any) => {
          const header = `[${item.refId}] (${item.kindLabel}${item.location ? ` · ${item.location}` : ''})`;
          const body = String(item.text || '').slice(0, 2000);
          const comment = item.comment ? `\nReflexión del lector: ${String(item.comment).slice(0, 800)}` : '';
          return `${header}\n${body}${comment}`;
        })
        .join('\n\n---\n\n');

      const prompt = [
        `Analizá el cuaderno de lectura del libro «${bookTitle}»${bookAuthor ? ` de ${bookAuthor}` : ''}.`,
        Array.isArray(bookTags) && bookTags.length ? `Etiquetas del lector: ${bookTags.join(', ')}.` : '',
        'A continuación tenés las citas, anotaciones y notas comentadas que reunió el lector, cada una identificada con su código entre corchetes (por ejemplo [CITA-1], [NOTA-3], [ANOT-2]):',
        formattedSources,
        'Elaborá una síntesis estructurada en español que revele hilos conductores reales entre los fragmentos elegidos por el lector:',
        '1. "summary": Una síntesis clara y profunda (2 a 4 párrafos) de las ideas que articulan estos fragmentos.',
        '2. "themes": Entre 3 y 6 ejes temáticos breves (frases cortas).',
        '3. "connections": Entre 2 y 8 conexiones concretas entre dos o más fragmentos (pueden ser contrastes, evoluciones de una idea, ejemplos que iluminan una tesis o ecos entre capítulos). En "refs" usá exactamente los códigos entre corchetes provistos arriba (por ejemplo "CITA-1", "CITA-3").',
        '4. "questions": Entre 3 y 5 preguntas abiertas para que el lector siga pensando o debatiendo en su cuaderno.',
        'Basate exclusivamente en el material provisto y en el contexto de la obra sin inventar citas.',
      ]
        .filter(Boolean)
        .join('\n\n');

      const { response, model: usedModel } = await generateWithFallback((m) => {
        const thinkingLevel = resolveThinkingLevel(thinking === 'auto' ? 'medium' : thinking, m);
        const config: Record<string, unknown> = {
          systemInstruction:
            'Sos un editor literario y asistente de lectura riguroso. Respondés siempre en español claro y preciso, devolviendo JSON válido según el esquema.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: 'Síntesis general en español de los fragmentos reunidos.',
              },
              themes: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Lista de ejes temáticos principales.',
              },
              connections: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: {
                      type: Type.STRING,
                      description: 'Título breve de la conexión temática.',
                    },
                    explanation: {
                      type: Type.STRING,
                      description: 'Explicación concreta de cómo dialogan o contrastan estos fragmentos.',
                    },
                    refs: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                      description: 'Códigos exactos de los fragmentos conectados, ej: CITA-1, CITA-4.',
                    },
                  },
                },
                description: 'Conexiones detectadas entre citas, anotaciones o notas.',
              },
              questions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Preguntas de profundización para el cuaderno del lector.',
              },
            },
          },
        };
        if (thinkingLevel) {
          config.thinkingConfig = { thinkingLevel };
        }
        return {
          model: m,
          contents: prompt,
          config,
        };
      }, model);

      const raw = (response.text || '{}').trim();
      const parsed = JSON.parse(raw);
      const analysis = {
        summary: String(parsed.summary || '').trim(),
        themes: Array.isArray(parsed.themes) ? parsed.themes.map(String).slice(0, 12) : [],
        connections: Array.isArray(parsed.connections)
          ? parsed.connections.slice(0, 20).map((c: any) => ({
              title: String(c?.title || 'Conexión temática').slice(0, 160),
              explanation: String(c?.explanation || '').slice(0, 2000),
              refs: Array.isArray(c?.refs) ? c.refs.map(String).slice(0, 8) : [],
            }))
          : [],
        questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).slice(0, 10) : [],
      };

      if (!analysis.summary) {
        return res.status(502).json({ error: 'No se pudo generar la síntesis del libro.' });
      }

      return res.json({ analysis, model: usedModel });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      return res.status(status).json({
        error: err?.message || 'Error al analizar las citas del libro.',
      });
    }
  });

  // Static PWA assets & Vite dev middleware / production build
  app.use('/assets', express.static(path.join(__dirname, 'assets')));
  app.get('/manifest.json', (_req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
  });
  app.get('/service-worker.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'service-worker.js'));
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`Librarium running at http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Librarium server:', err);
  process.exit(1);
});

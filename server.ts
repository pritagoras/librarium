import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.PORT === '8765' ? '127.0.0.1' : '0.0.0.0');
const ADMIN_EMAIL = '[redacted]';
const VISITS_FILE = path.join(os.tmpdir(), 'librarium-site-visits.json');
const MAX_TRACKED_SESSIONS = 5000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface DailyVisitBucket {
  total: number;
  anon: number;
  auth: number;
}

interface StoredVisitStats {
  startedAt: string;
  totalVisits: number;
  anonVisits: number;
  authVisits: number;
  daily: Record<string, DailyVisitBucket>;
}

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadFirebaseApiKey(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'firebase-applet-config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    return typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
  } catch {
    return '';
  }
}

function loadVisitStats(): StoredVisitStats {
  try {
    const raw = fs.readFileSync(VISITS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredVisitStats>;
    return {
      startedAt: typeof parsed.startedAt === 'string' && parsed.startedAt ? parsed.startedAt : new Date().toISOString(),
      totalVisits: Math.max(0, Math.floor(Number(parsed.totalVisits) || 0)),
      anonVisits: Math.max(0, Math.floor(Number(parsed.anonVisits) || 0)),
      authVisits: Math.max(0, Math.floor(Number(parsed.authVisits) || 0)),
      daily: parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {},
    };
  } catch {
    return {
      startedAt: new Date().toISOString(),
      totalVisits: 0,
      anonVisits: 0,
      authVisits: 0,
      daily: {},
    };
  }
}

function saveVisitStats(stats: StoredVisitStats) {
  try {
    const keys = Object.keys(stats.daily).sort();
    if (keys.length > 30) {
      for (const oldKey of keys.slice(0, keys.length - 30)) {
        delete stats.daily[oldKey];
      }
    }
    fs.writeFileSync(VISITS_FILE, JSON.stringify(stats), 'utf8');
  } catch {
    // Ignore ephemeral filesystem errors
  }
}

async function verifyAdminIdToken(idToken: string, apiKey: string): Promise<boolean> {
  if (!idToken || !apiKey) return false;
  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
    if (!resp.ok) return false;
    const data = (await resp.json()) as {
      users?: Array<{ email?: string; emailVerified?: boolean }>;
    };
    const user = data.users?.[0];
    return Boolean(
      user &&
        user.emailVerified === true &&
        typeof user.email === 'string' &&
        user.email.trim().toLowerCase() === ADMIN_EMAIL,
    );
  } catch {
    return false;
  }
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');

  const firebaseApiKey = loadFirebaseApiKey();
  const visitStats = loadVisitStats();
  const recentSessions = new Map<string, { authenticated: boolean; dateKey: string; ts: number }>();

  const pruneSessions = (now: number) => {
    for (const [key, entry] of recentSessions.entries()) {
      if (now - entry.ts > SESSION_TTL_MS || recentSessions.size > MAX_TRACKED_SESSIONS) {
        recentSessions.delete(key);
      }
    }
  };

  app.post('/api/visits', express.json({ limit: '4kb' }), (req, res) => {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    const authenticated = Boolean(req.body?.authenticated);
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId' });
      return;
    }

    const now = Date.now();
    const todayKey = getTodayKey();
    pruneSessions(now);

    if (!visitStats.daily[todayKey]) {
      visitStats.daily[todayKey] = { total: 0, anon: 0, auth: 0 };
    }
    const bucket = visitStats.daily[todayKey];
    const existing = recentSessions.get(sessionId);

    if (!existing) {
      recentSessions.set(sessionId, { authenticated, dateKey: todayKey, ts: now });
      visitStats.totalVisits += 1;
      bucket.total += 1;
      if (authenticated) {
        visitStats.authVisits += 1;
        bucket.auth += 1;
      } else {
        visitStats.anonVisits += 1;
        bucket.anon += 1;
      }
      saveVisitStats(visitStats);
    } else if (authenticated && !existing.authenticated) {
      existing.authenticated = true;
      existing.ts = now;
      if (visitStats.anonVisits > 0) visitStats.anonVisits -= 1;
      visitStats.authVisits += 1;
      const origBucket = visitStats.daily[existing.dateKey] || bucket;
      if (origBucket.anon > 0) origBucket.anon -= 1;
      origBucket.auth += 1;
      saveVisitStats(visitStats);
    } else {
      existing.ts = now;
    }

    res.json({ ok: true });
  });

  app.get('/api/visits', async (req, res) => {
    const authHeader = String(req.headers.authorization || '');
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const idToken = match?.[1]?.trim() || '';
    const isAdmin = await verifyAdminIdToken(idToken, firebaseApiKey);
    if (!isAdmin) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const todayKey = getTodayKey();
    const todayBucket = visitStats.daily[todayKey] || { total: 0, anon: 0, auth: 0 };
    const recentDays = Object.keys(visitStats.daily)
      .sort()
      .slice(-7)
      .reverse()
      .map((date) => ({
        date,
        total: visitStats.daily[date].total,
        anon: visitStats.daily[date].anon,
        auth: visitStats.daily[date].auth,
      }));

    res.json({
      startedAt: visitStats.startedAt,
      totalVisits: visitStats.totalVisits,
      anonVisits: visitStats.anonVisits,
      authVisits: visitStats.authVisits,
      todayDate: todayKey,
      todayVisits: todayBucket.total,
      todayAnonVisits: todayBucket.anon,
      todayAuthVisits: todayBucket.auth,
      recentDays,
    });
  });

  // Static PWA assets & Vite dev middleware / production build
  app.use('/assets', express.static(path.join(__dirname, 'assets')));
  app.get('/manifest.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
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
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html') || filePath.endsWith('service-worker.js') || filePath.endsWith('manifest.json')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
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

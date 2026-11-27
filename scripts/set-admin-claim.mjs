import { readFile } from 'node:fs/promises';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [uid, action] = process.argv.slice(2);
if (!uid || !['grant', 'revoke'].includes(action)) {
  console.error('Uso: npm run set-admin-claim -- <UID de Firebase> <grant|revoke>');
  process.exit(2);
}

const config = JSON.parse(await readFile(new URL('../firebase-applet-config.json', import.meta.url), 'utf8'));
const app = initializeApp({ credential: applicationDefault(), projectId: config.projectId });
const auth = getAuth(app);
const user = await auth.getUser(uid);
if (!user.emailVerified) throw new Error('La cuenta debe tener el correo verificado.');

const claims = { ...(user.customClaims || {}) };
if (action === 'grant') claims.admin = true;
else delete claims.admin;

await auth.setCustomUserClaims(uid, claims);
console.log(`Claim de administrador ${action === 'grant' ? 'asignado' : 'revocado'}. Cerrá y volvé a iniciar sesión para actualizar el token.`);

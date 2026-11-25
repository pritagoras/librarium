import { cpSync } from 'node:fs';

cpSync('assets', 'dist/assets', { recursive: true, force: true });
for (const file of ['manifest.json', 'service-worker.js']) {
  cpSync(file, `dist/${file}`);
}

import { build } from 'vite';
import { gzipSync } from 'node:zlib';

const report = {
  name: 'librarium-bundle-report',
  generateBundle(_options, bundle) {
    const rows = [];
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      for (const [id, details] of Object.entries(chunk.modules)) {
        rows.push({
          chunk: chunk.fileName,
          renderedKB: (details.renderedLength / 1024).toFixed(1),
          module: id.replaceAll('\\', '/').split('/node_modules/').at(-1),
        });
      }
    }
    rows.sort((a, b) => Number(b.renderedKB) - Number(a.renderedKB));
    console.log('\nMódulos más grandes del build (KB renderizados):');
    console.table(rows.slice(0, 30));
    console.log('\nTotales por chunk (tamaño sin comprimir):');
    console.table(Object.values(bundle)
      .filter((item) => item.type === 'chunk')
      .map((chunk) => ({
        chunk: chunk.fileName,
        renderedKB: (chunk.code.length / 1024).toFixed(1),
        gzipKB: (gzipSync(chunk.code).length / 1024).toFixed(1),
      })));
  },
};

await build({ plugins: [report], build: { write: false } });

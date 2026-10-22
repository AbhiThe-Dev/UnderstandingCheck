// Bundles the Electron main and preload scripts. The Recall SDK ships native binaries, so it stays external.
import { build } from 'esbuild';

for (const entry of ['main', 'preload']) {
  await build({
    entryPoints: [`src/${entry}.ts`],
    outfile: `dist/${entry}.cjs`,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', '@recallai/desktop-sdk'],
    logLevel: 'warning',
  });
}
console.log('built dist/main.cjs, dist/preload.cjs');

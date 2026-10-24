// Bundles the Electron main and preload scripts. The Recall SDK ships native binaries, so it stays external.
// Also compiles the on-device screen-text helper (Swift + Apple Vision) when a Swift compiler is present.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
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

const helperSrc = 'native/screen-text.swift';
const helperOut = 'dist/uc-screen-text';
const swiftc = process.platform === 'darwin' ? spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }) : null;
if (!swiftc || swiftc.status !== 0) {
  console.warn('swiftc not found: screen context will be unavailable (install Xcode Command Line Tools).');
} else if (!existsSync(helperOut) || statSync(helperOut).mtimeMs < statSync(helperSrc).mtimeMs) {
  const r = spawnSync('xcrun', ['swiftc', '-O', '-swift-version', '5', helperSrc, '-o', helperOut], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('compiling the screen-text helper failed');
  console.log(`built ${helperOut}`);
}

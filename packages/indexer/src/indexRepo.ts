import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { CodeSymbol } from '@uc/core';
import { extractSymbols, propagateEffects } from './extract';
import { LANGUAGE_BY_EXTENSION } from './parser';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'out', 'vendor', '.turbo']);
const MAX_FILE_BYTES = 200_000;

export interface IndexResult {
  commitSha: string;
  symbols: CodeSymbol[];
  files: number;
  skipped: { path: string; reason: string }[];
  durationMs: number;
}

export interface IndexProgress {
  (done: number, total: number, path: string): void;
}

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // never follow links out of the repository
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(root, full, out);
    } else if (LANGUAGE_BY_EXTENSION[extname(entry.name)] && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

async function gitHead(dir: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 5000 });
    const sha = stdout.trim();
    const { stdout: top } = await promisify(execFile)('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
    // Only trust HEAD when `dir` is the repository root itself (fixtures live inside this monorepo).
    return /^[0-9a-f]{40}$/.test(sha) && relative(top.trim(), dir) === '' ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Index a local checkout. The commit SHA is the git HEAD when `dir` is a repository root,
 * otherwise a content hash of the indexed files (stable for unchanged content).
 */
export async function indexDirectory(dir: string, opts: { onProgress?: IndexProgress; commitSha?: string } = {}): Promise<IndexResult> {
  const started = Date.now();
  const paths = (await walk(dir)).sort();
  const files: { rel: string; source: string; ext: string }[] = [];
  const skipped: IndexResult['skipped'] = [];
  for (const p of paths) {
    const s = await stat(p);
    const rel = relative(dir, p).split(sep).join('/');
    if (s.size > MAX_FILE_BYTES) {
      skipped.push({ path: rel, reason: 'file too large' });
      continue;
    }
    files.push({ rel, source: await readFile(p, 'utf8'), ext: extname(p) });
  }

  let commitSha = opts.commitSha ?? (await gitHead(dir));
  if (!commitSha) {
    const h = createHash('sha1');
    for (const f of files) h.update(f.rel).update('\0').update(f.source).update('\0');
    commitSha = `content-${h.digest('hex').slice(0, 32)}`;
  }

  const symbols: CodeSymbol[] = [];
  let done = 0;
  for (const f of files) {
    try {
      symbols.push(...(await extractSymbols({ filePath: f.rel, source: f.source, language: LANGUAGE_BY_EXTENSION[f.ext]!, commitSha })));
    } catch (err) {
      skipped.push({ path: f.rel, reason: `parse error: ${(err as Error).message}` });
    }
    opts.onProgress?.(++done, files.length, f.rel);
  }
  propagateEffects(symbols);
  return { commitSha, symbols, files: files.length, skipped, durationMs: Date.now() - started };
}

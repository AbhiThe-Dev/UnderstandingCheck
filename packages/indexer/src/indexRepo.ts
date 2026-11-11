import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { CodeSymbol } from '@uc/core';
import { extractDocSections, isDocFile } from './docs';
import { extractSymbols, propagateEffects } from './extract';
import { LANGUAGE_BY_EXTENSION } from './parser';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'out', 'vendor', '.turbo']);
export const MAX_FILE_BYTES = 200_000;

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

export interface SourceFile {
  /** Repository-relative path with forward slashes. */
  path: string;
  source: string;
}

/**
 * Whether a repository path should be indexed: a supported TS/JS file, or project documentation
 * (Markdown), outside dependency, build and hidden directories (declaration files excluded). Used
 * for local walks and for remote file trees.
 */
export function shouldIndexPath(path: string): boolean {
  const parts = path.split('/');
  const file = parts.at(-1) ?? '';
  if (parts.slice(0, -1).some((d) => IGNORED_DIRS.has(d) || d.startsWith('.'))) return false;
  return (Boolean(LANGUAGE_BY_EXTENSION[extname(file)]) && !file.endsWith('.d.ts')) || isDocFile(path);
}

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // never follow links out of the repository
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(root, full, out);
    } else if (shouldIndexPath(relative(root, full).split(sep).join('/'))) {
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

/** Stable id for content that is not a git commit (e.g. a local folder). */
export function contentSha(files: SourceFile[]): string {
  const h = createHash('sha1');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) h.update(f.path).update('\0').update(f.source).update('\0');
  return `content-${h.digest('hex').slice(0, 32)}`;
}

/** Parse a set of files at one commit: symbols, calls and side effects, with one hop of effect propagation. */
export async function indexFiles(files: SourceFile[], commitSha: string, onProgress?: IndexProgress): Promise<Omit<IndexResult, 'files' | 'durationMs'> & { files: number }> {
  const symbols: CodeSymbol[] = [];
  const skipped: IndexResult['skipped'] = [];
  let done = 0;
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!shouldIndexPath(f.path)) {
      skipped.push({ path: f.path, reason: 'unsupported path' });
    } else if (Buffer.byteLength(f.source) > MAX_FILE_BYTES) {
      skipped.push({ path: f.path, reason: 'file too large' });
    } else {
      try {
        if (isDocFile(f.path)) symbols.push(...extractDocSections({ filePath: f.path, source: f.source, commitSha }));
        else symbols.push(...(await extractSymbols({ filePath: f.path, source: f.source, language: LANGUAGE_BY_EXTENSION[extname(f.path)]!, commitSha })));
      } catch (err) {
        skipped.push({ path: f.path, reason: `parse error: ${(err as Error).message}` });
      }
    }
    onProgress?.(++done, files.length, f.path);
  }
  propagateEffects(symbols);
  return { commitSha, symbols, files: files.length - skipped.length, skipped };
}

/**
 * Index a local checkout. The commit SHA is the git HEAD when `dir` is a repository root,
 * otherwise a content hash of the indexed files (stable for unchanged content).
 */
export async function indexDirectory(dir: string, opts: { onProgress?: IndexProgress; commitSha?: string } = {}): Promise<IndexResult> {
  const started = Date.now();
  const files: SourceFile[] = [];
  const skipped: IndexResult['skipped'] = [];
  for (const p of (await walk(dir)).sort()) {
    const rel = relative(dir, p).split(sep).join('/');
    if ((await stat(p)).size > MAX_FILE_BYTES) {
      skipped.push({ path: rel, reason: 'file too large' });
      continue;
    }
    files.push({ path: rel, source: await readFile(p, 'utf8') });
  }
  const commitSha = opts.commitSha ?? (await gitHead(dir)) ?? contentSha(files);
  const r = await indexFiles(files, commitSha, opts.onProgress);
  return { ...r, skipped: [...skipped, ...r.skipped], durationMs: Date.now() - started };
}

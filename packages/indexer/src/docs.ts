import type { CodeSymbol } from '@uc/core';

/** Documentation files that describe the project; changelogs and licenses are history and legal text, not design. */
const SKIPPED_DOCS = /(^|\/)(changelog|changes|history|license|licence|code_of_conduct|contributing|security)\.mdx?$/i;
const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
/** Long sections are split so a decision reads only the part that matters. */
const MAX_SECTION_LINES = 60;

export function isDocFile(path: string): boolean {
  return /\.mdx?$/i.test(path) && !SKIPPED_DOCS.test(path);
}

/**
 * Split a Markdown file into sections at headings (h1–h4), each a `doc` symbol named after its
 * heading ("Sessions › Entitlement caching"), with the file's line numbers. Fenced code blocks are
 * kept as text; headings inside them are ignored. No calls or effects: documentation is context only.
 */
export function extractDocSections(file: { filePath: string; source: string; commitSha: string }): CodeSymbol[] {
  const lines = file.source.split('\n');
  const out: CodeSymbol[] = [];
  const trail: string[] = [];
  let start = 0;
  let title = file.filePath.split('/').at(-1)!.replace(/\.mdx?$/i, '');
  let fenced = false;
  const flush = (end: number) => {
    // Trim blank lines so the cited range is the text itself.
    let a = start;
    let b = end;
    while (a < b && !lines[a]!.trim()) a++;
    while (b > a && !lines[b - 1]!.trim()) b--;
    for (let from = a; from < b; from += MAX_SECTION_LINES) {
      const to = Math.min(b, from + MAX_SECTION_LINES);
      const content = lines.slice(from, to).join('\n');
      if (content.replace(HEADING, '').trim().length < 20) continue; // a bare heading says nothing
      out.push({
        id: `${file.commitSha.slice(0, 12)}:${file.filePath}:${title}:${from + 1}`,
        commitSha: file.commitSha,
        filePath: file.filePath,
        symbolName: title,
        symbolType: 'doc',
        startLine: from + 1,
        endLine: to,
        signature: lines[a]!.trim().slice(0, 160),
        content,
        calls: [],
        effects: [],
        imports: [],
        isTest: false,
        language: 'markdown',
      });
    }
  };
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : line.match(HEADING);
    if (!m) return;
    flush(i);
    const level = m[1]!.length;
    trail.length = level - 1;
    trail[level - 1] = m[2]!.replace(/[*_`]/g, '');
    title = trail.filter(Boolean).join(' › ');
    start = i;
  });
  flush(lines.length);
  return out;
}

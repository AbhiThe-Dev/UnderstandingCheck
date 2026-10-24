/**
 * Turns text recognised on the screen into code mentions: identifiers and file paths, nothing else.
 * Raw screen text never leaves the desktop process; only this output is sent to the API, which then
 * keeps just the names that exist in the session's repository.
 */

export interface ScreenLine {
  text: string;
  confidence?: number;
}

export interface CodeMentions {
  identifiers: string[];
  files: { path: string; line?: number }[];
}

const MAX_IDENTIFIERS = 200;
const MAX_FILES = 50;
const MIN_CONFIDENCE = 0.3;

const EXT = 'ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|rs|cs|php|swift';
// A path ending in a code extension, optionally followed by a line: `approve.ts:22`, `approve.ts, line 22`, `#L22`.
const FILE = new RegExp(`((?:[\\w.-]+/)*[\\w.-]+\\.(?:${EXT}))\\b(?:(?::|,?\\s+line\\s+|#L)(\\d{1,6}))?`, 'gi');
// GitHub file pages: .../blob/<branch-or-sha>/<path>#L22
const GITHUB_BLOB = new RegExp(`/blob/[^/\\s]+/((?:[\\w.-]+/)*[\\w.-]+\\.(?:${EXT}))(?:#L(\\d{1,6}))?`, 'gi');
const WORD = /[A-Za-z_$][\w$]*(\s*\()?/g;

const KEYWORDS = new Set(
  [
    'const', 'let', 'var', 'function', 'return', 'export', 'import', 'from', 'default', 'async', 'await', 'class', 'interface',
    'type', 'extends', 'implements', 'new', 'this', 'super', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
    'throw', 'try', 'catch', 'finally', 'typeof', 'instanceof', 'void', 'null', 'undefined', 'true', 'false', 'def', 'self',
    'print', 'console', 'require', 'module', 'string', 'number', 'boolean', 'object', 'Promise', 'Error', 'Array', 'Object',
    'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON', 'Map', 'Set',
  ].map((k) => k.toLowerCase()),
);

/** camelCase, PascalCase with two humps, or snake_case: the shapes code names have and prose doesn't. */
function looksLikeCode(word: string) {
  return /^[a-z][a-z0-9]*[A-Z]/.test(word) || /^[A-Z][a-z0-9]+[A-Z]/.test(word) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(word);
}

/** Random-looking tokens (keys, hashes, ids) are never useful context; leave them out. */
function looksRandom(word: string) {
  return word.length > 60 || (word.match(/\d/g)?.length ?? 0) >= 4;
}

export function extractCodeMentions(lines: ScreenLine[]): CodeMentions {
  const identifiers = new Set<string>();
  const files = new Map<string, number | undefined>();
  const addFile = (path: string, line: string | undefined) => {
    const p = path.replace(/^\.\//, '');
    if (files.size >= MAX_FILES && !files.has(p)) return;
    const n = line ? Number(line) : undefined;
    if (!files.has(p) || (files.get(p) === undefined && n !== undefined)) files.set(p, n);
  };

  for (const l of lines) {
    if ((l.confidence ?? 1) < MIN_CONFIDENCE) continue;
    const text = l.text;
    for (const m of text.matchAll(GITHUB_BLOB)) addFile(m[1]!, m[2]);
    for (const m of text.matchAll(FILE)) if (!m[1]!.includes('://')) addFile(m[1]!, m[2]);
    // Paths are handled above; strip them so their parts are not read as identifiers.
    const rest = text.replace(GITHUB_BLOB, ' ').replace(FILE, ' ');
    for (const m of rest.matchAll(WORD)) {
      const word = m[0].replace(/\s*\($/, '');
      const isCall = m[1] !== undefined;
      if (KEYWORDS.has(word.toLowerCase()) || looksRandom(word)) continue;
      if (isCall ? word.length >= 3 : word.length >= 4 && looksLikeCode(word)) {
        if (identifiers.size < MAX_IDENTIFIERS) identifiers.add(word);
      }
    }
  }
  return {
    identifiers: [...identifiers],
    files: [...files].map(([path, line]) => (line === undefined ? { path } : { path, line })),
  };
}

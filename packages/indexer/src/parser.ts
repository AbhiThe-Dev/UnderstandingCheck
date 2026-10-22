import { createRequire } from 'node:module';
import type { Language as TSLanguage, Parser as TSParser } from 'web-tree-sitter';

export type SupportedLanguage = 'typescript' | 'tsx' | 'javascript';

/**
 * Language adapter boundary: adding a language means adding a grammar here and,
 * if its node types differ, a node-type mapping in extract.ts.
 */
export const LANGUAGE_BY_EXTENSION: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
};

const require = createRequire(import.meta.url);

const GRAMMAR_PATH: Record<SupportedLanguage, () => string> = {
  typescript: () => require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
  tsx: () => require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
  javascript: () => require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm'),
};

let initPromise: Promise<typeof import('web-tree-sitter')> | null = null;
const languages = new Map<SupportedLanguage, Promise<TSLanguage>>();

async function runtime() {
  initPromise ??= (async () => {
    const mod = await import('web-tree-sitter');
    await mod.Parser.init({
      locateFile: (name: string) => require.resolve(`web-tree-sitter/${name}`),
    });
    return mod;
  })();
  return initPromise;
}

export async function parserFor(lang: SupportedLanguage): Promise<TSParser> {
  const mod = await runtime();
  let l = languages.get(lang);
  if (!l) {
    l = mod.Language.load(GRAMMAR_PATH[lang]());
    languages.set(lang, l);
  }
  const parser = new mod.Parser();
  parser.setLanguage(await l);
  return parser;
}

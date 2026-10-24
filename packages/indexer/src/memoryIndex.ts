import { identifierTerms, splitIdentifier, stem, type CodeSymbol, type SymbolHit, type SymbolSearch } from '@uc/core';

interface Doc {
  symbol: CodeSymbol;
  name: Set<string>;
  path: Set<string>;
  content: Set<string>;
}

export function codeTerms(code: string): Set<string> {
  const out = new Set<string>();
  for (const tok of code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    for (const w of splitIdentifier(tok)) if (w.length >= 3) out.add(stem(w));
  }
  return out;
}

export function pathTerms(path: string): Set<string> {
  return new Set(path.replace(/\.[a-z]+$/, '').split(/[/._-]+/).flatMap(identifierTerms));
}

/**
 * Field-weighted lexical scoring with IDF: name matches dominate, then path, then body.
 * Used directly for tests/the CLI demo and as the re-ranker behind Postgres full-text recall.
 */
export function scoreDoc(doc: Doc, terms: string[], idf: (t: string) => number): SymbolHit | null {
  let score = 0;
  const matched: string[] = [];
  let nameMatch = false;
  for (const t of new Set(terms)) {
    const inName = doc.name.has(t);
    const inPath = doc.path.has(t);
    const inContent = doc.content.has(t);
    if (!inName && !inPath && !inContent) continue;
    matched.push(t);
    nameMatch ||= inName;
    score += idf(t) * ((inName ? 3 : 0) + (inPath ? 1 : 0) + (inContent ? 0.5 : 0));
  }
  return matched.length ? { symbol: doc.symbol, score: Math.round(score * 100) / 100, matchedTerms: matched, nameMatch } : null;
}

export function toDoc(symbol: CodeSymbol): Doc {
  return {
    symbol,
    name: new Set(identifierTerms(symbol.symbolName)),
    path: pathTerms(symbol.filePath),
    content: codeTerms(symbol.content),
  };
}

export class InMemorySymbolIndex implements SymbolSearch {
  private docs: Doc[];
  private df = new Map<string, number>();

  constructor(
    symbols: CodeSymbol[],
    readonly commitSha: string,
  ) {
    this.docs = symbols.map(toDoc);
    for (const d of this.docs) {
      for (const t of new Set([...d.name, ...d.path, ...d.content])) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }

  private idf = (t: string) => Math.log(1 + this.docs.length / (this.df.get(t) ?? 1));

  async lexical(query: { terms: string[]; words: string[] }, limit: number): Promise<SymbolHit[]> {
    return this.docs
      .map((d) => scoreDoc(d, query.terms, this.idf))
      .filter((h): h is SymbolHit => h !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async byNames(names: string[]): Promise<CodeSymbol[]> {
    const set = new Set(names);
    return this.docs.filter((d) => !d.symbol.isTest && set.has(d.symbol.symbolName)).map((d) => d.symbol);
  }

  async inFiles(paths: string[], limit: number): Promise<CodeSymbol[]> {
    const wanted = paths.map((p) => p.replace(/^\/+/, ''));
    return this.docs
      .filter((d) => !d.symbol.isTest && wanted.some((p) => d.symbol.filePath === p || d.symbol.filePath.endsWith(`/${p}`)))
      .slice(0, limit)
      .map((d) => d.symbol);
  }

  async testsFor(symbolName: string, limit: number): Promise<CodeSymbol[]> {
    return this.docs
      .filter((d) => d.symbol.isTest && (d.symbol.calls.includes(symbolName) || d.symbol.content.includes(symbolName)))
      .slice(0, limit)
      .map((d) => d.symbol);
  }
}

import type { EngineConfig } from './config';
import type { SymbolSearch } from './ports';
import type { CodeEvidence, CodeSymbol } from './types';
import { estimateTokens } from './text';

export interface RetrievalResult {
  evidence: Omit<CodeEvidence, 'id'>[];
  sufficient: boolean;
  steps: string[];
  cacheHit: boolean;
}

/**
 * Retrieval cache keyed by commit SHA + query. Code at a given SHA never changes,
 * so entries never need invalidation — only eviction.
 */
export class RetrievalCache {
  private map = new Map<string, RetrievalResult>();
  constructor(private maxEntries = 500) {}
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, value: RetrievalResult) {
    if (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, value);
  }
}

export function toEvidence(sym: CodeSymbol, reason: string): Omit<CodeEvidence, 'id'> {
  return {
    symbolId: sym.id,
    symbolName: sym.symbolName,
    filePath: sym.filePath,
    startLine: sym.startLine,
    endLine: sym.endLine,
    commitSha: sym.commitSha,
    snippet: sym.content,
    reason,
    effects: sym.effects,
    isTest: sym.isTest,
  };
}

/**
 * Module 2 — Context Retrieval.
 * 1. lexical match on names/paths/content  2. matching functions/classes  3. one hop of direct calls
 * 4. associated tests  5. (semantic search: not enabled in the MVP)  6. stop at the token budget.
 * Never fabricates: if nothing scores above the threshold the result is marked insufficient.
 */
export async function retrieveContext(
  query: { terms: string[]; words: string[] },
  search: SymbolSearch,
  cfg: EngineConfig['retrieval'],
  cache?: RetrievalCache,
): Promise<RetrievalResult> {
  const key = `${search.commitSha}:${[...query.terms].sort().join(',')}`;
  const cached = cache?.get(key);
  if (cached) return { ...cached, cacheHit: true };

  const steps: string[] = [];
  const out: Omit<CodeEvidence, 'id'>[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  const push = (sym: CodeSymbol, reason: string): boolean => {
    if (seen.has(sym.id)) return true;
    const cost = estimateTokens(sym.content);
    if (tokens + cost > cfg.contextBudgetTokens || out.length >= cfg.maxSymbols) return false;
    seen.add(sym.id);
    tokens += cost;
    out.push(toEvidence(sym, reason));
    return true;
  };

  if (query.terms.length === 0) {
    return { evidence: [], sufficient: false, steps: ['no content terms'], cacheHit: false };
  }

  const hits = (await search.lexical(query, cfg.maxSymbols * 2)).filter(
    (h) => h.score >= cfg.minScore && (h.nameMatch || h.matchedTerms.length >= 2) && !h.symbol.isTest,
  );
  steps.push(`lexical: ${hits.length} hits ≥ ${cfg.minScore}`);
  if (hits.length === 0) {
    const result = { evidence: [], sufficient: false, steps, cacheHit: false };
    cache?.set(key, result);
    return result;
  }

  // Keep only hits close to the best one so a weak match does not crowd the budget.
  const best = hits[0]!.score;
  const primary = hits.filter((h) => h.score >= best * 0.5).slice(0, 3);
  for (const h of primary) push(h.symbol, `matches ${h.matchedTerms.join(', ')}`);

  // Associated tests document intended behavior; they get a slot before callees can fill the budget.
  for (const h of primary.slice(0, 2)) {
    const tests = await search.testsFor(h.symbol.symbolName, cfg.maxTestsPerSymbol);
    for (const t of tests) push(t, `test for ${h.symbol.symbolName}`);
  }

  // One hop along direct calls from the primary symbols, consequential callees first.
  const callees = [...new Set(primary.flatMap((h) => h.symbol.calls))];
  if (callees.length) {
    const called = (await search.byNames(callees)).sort((a, b) => b.effects.length - a.effects.length);
    steps.push(`calls: ${called.length} callees resolved`);
    for (const sym of called) {
      const caller = primary.find((h) => h.symbol.calls.includes(sym.symbolName));
      if (!push(sym, `called by ${caller?.symbol.symbolName ?? 'match'}`)) break;
    }
  }
  steps.push(`budget: ${tokens}/${cfg.contextBudgetTokens} tokens, ${out.length} symbols`);

  const result = { evidence: out, sufficient: out.length > 0, steps, cacheHit: false };
  cache?.set(key, result);
  return result;
}

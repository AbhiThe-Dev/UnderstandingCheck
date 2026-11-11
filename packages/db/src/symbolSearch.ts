import { and, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { identifierTerms, splitIdentifier, stem, type CodeSymbol, type SymbolHit, type SymbolSearch } from '@uc/core';
import type { Db } from './client';
import { codeSymbols } from './schema';

type Row = typeof codeSymbols.$inferSelect;

export function rowToSymbol(r: Row): CodeSymbol {
  return {
    id: r.id,
    commitSha: r.commitSha,
    filePath: r.filePath,
    symbolName: r.symbolName,
    symbolType: r.symbolType as CodeSymbol['symbolType'],
    startLine: r.startLine,
    endLine: r.endLine,
    signature: r.signature,
    content: r.content,
    calls: r.calls,
    effects: r.effects as CodeSymbol['effects'],
    imports: r.imports,
    isTest: r.isTest,
    language: r.language as CodeSymbol['language'],
  };
}

export function searchColumns(s: CodeSymbol) {
  const codeWords = (s.content.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).flatMap(splitIdentifier);
  return {
    nameTerms: splitIdentifier(s.symbolName).join(' '),
    pathTerms: s.filePath.replace(/\.[a-z]+$/, '').split(/[/._-]+/).flatMap(splitIdentifier).join(' '),
    bodyTerms: [...new Set(codeWords)].join(' '),
  };
}

const sanitize = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Postgres full-text search for recall (GIN index, weighted name > path > body), then the same
 * field-weighted scoring as the in-memory index so results are consistent across backends.
 */
export class PgSymbolSearch implements SymbolSearch {
  constructor(
    private db: Db,
    private repositoryId: string,
    readonly commitSha: string,
  ) {}

  private scope() {
    return and(eq(codeSymbols.repositoryId, this.repositoryId), eq(codeSymbols.commitSha, this.commitSha));
  }

  async lexical(query: { terms: string[]; words: string[] }, limit: number): Promise<SymbolHit[]> {
    const ws = [...new Set(query.words.map(sanitize).filter((w) => w.length >= 3))];
    if (ws.length === 0) return [];
    const tsq = ws.join(' | ');
    const rows = await this.db
      .select()
      .from(codeSymbols)
      .where(and(this.scope(), sql`${codeSymbols.searchableContent} @@ to_tsquery('english', ${tsq})`))
      .orderBy(sql`ts_rank(${codeSymbols.searchableContent}, to_tsquery('english', ${tsq})) desc`)
      .limit(40);
    if (rows.length === 0) return [];

    const [{ total } = { total: 1 }] = await this.db.select({ total: count() }).from(codeSymbols).where(this.scope());
    const df = new Map<string, number>();
    for (const w of ws) {
      const [{ n } = { n: 1 }] = await this.db
        .select({ n: count() })
        .from(codeSymbols)
        .where(and(this.scope(), sql`${codeSymbols.searchableContent} @@ to_tsquery('english', ${w})`));
      df.set(stem(w), Math.max(1, n));
    }
    const idf = (t: string) => Math.log(1 + total / (df.get(t) ?? 1));
    const terms = new Set(query.terms);
    const hits: SymbolHit[] = [];
    for (const r of rows) {
      const name = new Set(identifierTerms(r.symbolName));
      const path = new Set(r.pathTerms.split(' ').map(stem));
      const body = new Set(r.bodyTerms.split(' ').filter((w) => w.length >= 3).map((w) => stem(w)));
      let score = 0;
      const matched: string[] = [];
      let nameMatch = false;
      for (const t of terms) {
        const inName = name.has(t);
        const inPath = path.has(t);
        const inBody = body.has(t);
        if (!inName && !inPath && !inBody) continue;
        matched.push(t);
        nameMatch ||= inName;
        score += idf(t) * ((inName ? 3 : 0) + (inPath ? 1 : 0) + (inBody ? 0.5 : 0));
      }
      if (matched.length) hits.push({ symbol: rowToSymbol(r), score: Math.round(score * 100) / 100, matchedTerms: matched, nameMatch });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async byNames(names: string[]): Promise<CodeSymbol[]> {
    if (names.length === 0) return [];
    const rows = await this.db
      .select()
      .from(codeSymbols)
      .where(and(this.scope(), inArray(codeSymbols.symbolName, names), eq(codeSymbols.isTest, false)));
    return rows.map(rowToSymbol);
  }

  async inFiles(paths: string[], limit: number): Promise<CodeSymbol[]> {
    const wanted = paths.map((p) => p.replace(/^\/+/, '')).filter(Boolean);
    if (wanted.length === 0) return [];
    const esc = (p: string) => p.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await this.db
      .select()
      .from(codeSymbols)
      .where(and(this.scope(), eq(codeSymbols.isTest, false), or(...wanted.flatMap((p) => [eq(codeSymbols.filePath, p), ilike(codeSymbols.filePath, `%/${esc(p)}`)]))))
      .limit(limit);
    return rows.map(rowToSymbol);
  }

  async testsFor(symbolName: string, limit: number): Promise<CodeSymbol[]> {
    const rows = await this.db
      .select()
      .from(codeSymbols)
      .where(and(this.scope(), eq(codeSymbols.isTest, true), ilike(codeSymbols.content, `%${symbolName.replace(/[%_]/g, '')}%`)))
      .limit(limit);
    return rows.map(rowToSymbol);
  }

  async callersOf(names: string[], limit: number): Promise<CodeSymbol[]> {
    if (names.length === 0) return [];
    const rows = await this.db
      .select()
      .from(codeSymbols)
      .where(
        and(
          this.scope(),
          eq(codeSymbols.isTest, false),
          or(...names.map((n) => sql`${codeSymbols.calls} @> ${JSON.stringify([n])}::jsonb`)),
          sql`not (${inArray(codeSymbols.symbolName, names)})`,
        ),
      )
      .limit(limit);
    return rows.map(rowToSymbol);
  }
}

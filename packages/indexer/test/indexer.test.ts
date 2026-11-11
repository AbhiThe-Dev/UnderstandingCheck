import { retrieveContext, DEFAULT_CONFIG, RetrievalCache } from '@uc/core';
import { sampleRepoPath } from '@uc/fixtures';
import { describe, expect, it } from 'vitest';
import { InMemorySymbolIndex, extractDocSections, extractSymbols, indexDirectory, isDocFile } from '../src';

describe('tree-sitter extraction', () => {
  it('extracts functions, arrow functions, methods and classes with line ranges', async () => {
    const src = `export async function a() {\n  grantAccess(u);\n}\nexport const b = () => 1;\nclass C {\n  m() {\n    sendEmail(x);\n  }\n}\n`;
    const syms = await extractSymbols({ filePath: 'x.ts', source: src, language: 'typescript', commitSha: 'sha' });
    expect(syms.map((s) => [s.symbolName, s.symbolType, s.startLine, s.endLine])).toEqual(
      expect.arrayContaining([
        ['a', 'function', 1, 3],
        ['b', 'arrow_function', 4, 4],
        ['C', 'class', 5, 9],
        ['m', 'method', 6, 8],
      ]),
    );
    expect(syms.find((s) => s.symbolName === 'a')!.effects[0]).toMatchObject({ target: 'grantAccess', category: 'permission', line: 2 });
  });

  it('records conditions around effects', async () => {
    const syms = await extractSymbols({
      filePath: 'auth.js',
      source: `function login(u) {\n  if (u.isStaff) {\n    grantAdminPrivileges(u);\n  }\n}`,
      language: 'javascript',
      commitSha: 'sha',
    });
    expect(syms[0]!.effects[0]).toMatchObject({ target: 'grantAdminPrivileges', condition: '(u.isStaff)', line: 3 });
  });

  it('propagates consequential effects from repo functions with bland names', async () => {
    const r = await indexDirectory(sampleRepoPath('approvals'));
    const approve = r.symbols.find((s) => s.symbolName === 'approveApplication')!;
    expect(approve.effects.map((e) => `${e.category}:${e.target}@${e.line}`)).toEqual(
      expect.arrayContaining(['data:status@17', 'permission:grantAccess@22', 'external:sendApprovalEmail@23']),
    );
    expect(r.commitSha).toMatch(/^content-[0-9a-f]{32}$/);
    const tests = r.symbols.filter((s) => s.isTest);
    expect(tests).toHaveLength(1);
  });

  it('is deterministic: the same content yields the same commit id', async () => {
    const [a, b] = await Promise.all([indexDirectory(sampleRepoPath('billing')), indexDirectory(sampleRepoPath('billing'))]);
    expect(a.commitSha).toBe(b.commitSha);
  });
});

describe('retrieval', () => {
  it('finds the operation, follows its calls, adds its test, and respects the budget', async () => {
    const r = await indexDirectory(sampleRepoPath('approvals'));
    const index = new InMemorySymbolIndex(r.symbols, r.commitSha);
    const res = await retrieveContext({ terms: ['undo', 'approv'], words: ['undo', 'approval'] }, index, DEFAULT_CONFIG.retrieval);
    expect(res.sufficient).toBe(true);
    const names = res.evidence.map((e) => e.symbolName);
    expect(names[0]).toBe('approveApplication');
    expect(names).toEqual(expect.arrayContaining(['grantAccess', 'approve.test.ts']));
    expect(res.evidence.every((e) => e.commitSha === r.commitSha)).toBe(true);
  });

  it('marks context insufficient instead of guessing', async () => {
    const r = await indexDirectory(sampleRepoPath('approvals'));
    const index = new InMemorySymbolIndex(r.symbols, r.commitSha);
    const res = await retrieveContext({ terms: ['csv', 'export', 'report'], words: [] }, index, DEFAULT_CONFIG.retrieval);
    expect(res).toMatchObject({ sufficient: false, evidence: [] });
  });

  it('caches by commit SHA and query', async () => {
    const r = await indexDirectory(sampleRepoPath('approvals'));
    const index = new InMemorySymbolIndex(r.symbols, r.commitSha);
    const cache = new RetrievalCache();
    await retrieveContext({ terms: ['approv'], words: [] }, index, DEFAULT_CONFIG.retrieval, cache);
    const again = await retrieveContext({ terms: ['approv'], words: [] }, index, DEFAULT_CONFIG.retrieval, cache);
    expect(again.cacheHit).toBe(true);
  });
});

describe('project documentation', () => {
  it('indexes Markdown as heading-named sections with file line numbers, skipping code fences and changelogs', () => {
    const source = '# Sessions\n\nIntro text that explains how sign-in works today.\n\n## Caching\n\nEntitlements are cached for at most one hour.\n```\n# not a heading\n```\n';
    const sections = extractDocSections({ filePath: 'docs/sessions.md', source, commitSha: 'sha' });
    expect(sections.map((s) => [s.symbolName, s.symbolType, s.startLine, s.endLine])).toEqual([
      ['Sessions', 'doc', 1, 3],
      ['Sessions › Caching', 'doc', 5, 10],
    ]);
    expect(isDocFile('docs/adr/0001-queues.md')).toBe(true);
    expect(isDocFile('CHANGELOG.md')).toBe(false);
  });

  it('keeps documentation out of per-turn retrieval and returns it only when asked', async () => {
    const r = await indexDirectory(sampleRepoPath('subscriptions'));
    expect(r.symbols.some((s) => s.symbolType === 'doc' && s.filePath === 'docs/entitlements.md')).toBe(true);
    const index = new InMemorySymbolIndex(r.symbols, r.commitSha);
    const query = { terms: ['premium', 'entitl', 'cach', 'hour'], words: ['premium', 'entitlements', 'cache', 'hour'] };
    const code = await retrieveContext(query, index, DEFAULT_CONFIG.retrieval);
    expect(code.evidence.some((e) => e.filePath.endsWith('.md'))).toBe(false);
    const docs = await retrieveContext(query, index, { ...DEFAULT_CONFIG.retrieval, docs: 'only', maxSymbols: 2 });
    expect(docs.evidence.map((e) => e.symbolName)).toContain('Entitlements › Downgrades take effect within one hour');
    expect(docs.evidence.every((e) => e.filePath.endsWith('.md'))).toBe(true);
  });

  it('finds the callers of a symbol', async () => {
    const r = await indexDirectory(sampleRepoPath('subscriptions'));
    const index = new InMemorySymbolIndex(r.symbols, r.commitSha);
    expect((await index.callersOf(['getSession'], 5)).map((s) => s.symbolName)).toEqual(['hasPremiumAccess']);
  });
});

import { retrieveContext, DEFAULT_CONFIG, RetrievalCache } from '@uc/core';
import { sampleRepoPath } from '@uc/fixtures';
import { describe, expect, it } from 'vitest';
import { InMemorySymbolIndex, extractSymbols, indexDirectory } from '../src';

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

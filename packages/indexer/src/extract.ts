import { classifyAssignment, classifyCall, type CodeSymbol, type Effect, type SymbolType } from '@uc/core';
import type { Node as TSNode } from 'web-tree-sitter';
import { parserFor, type SupportedLanguage } from './parser';

export interface FileInput {
  filePath: string;
  source: string;
  language: SupportedLanguage;
  commitSha: string;
}

const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const MAX_TEXT = 160;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

function oneLine(text: string, max = MAX_TEXT): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function symbolId(commitSha: string, filePath: string, name: string, line: number) {
  return `${commitSha.slice(0, 12)}:${filePath}:${name}:${line}`;
}

function calleeName(call: TSNode): string | null {
  const fn = call.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') return fn.childForFieldName('property')?.text ?? null;
  return null;
}

/** The condition of the nearest enclosing `if` between `node` and the function boundary. */
function enclosingCondition(node: TSNode, boundary: TSNode): string | undefined {
  let cur: TSNode | null = node.parent;
  let child: TSNode = node;
  while (cur && cur.id !== boundary.id) {
    if (cur.type === 'if_statement') {
      const consequence = cur.childForFieldName('consequence');
      if (consequence && consequence.startIndex <= child.startIndex && child.endIndex <= consequence.endIndex) {
        return oneLine(cur.childForFieldName('condition')?.text ?? '', 80);
      }
    }
    child = cur;
    cur = cur.parent;
  }
  return undefined;
}

function collect(node: TSNode, types: string[], out: TSNode[] = []): TSNode[] {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (types.includes(c.type)) out.push(c);
    collect(c, types, out);
  }
  return out;
}

function analyzeBody(body: TSNode): { calls: string[]; effects: Effect[] } {
  const calls = new Set<string>();
  const effects: Effect[] = [];
  for (const call of collect(body, ['call_expression'])) {
    const name = calleeName(call);
    if (!name) continue;
    calls.add(name);
    const category = classifyCall(name);
    if (!category) continue;
    const condition = enclosingCondition(call, body);
    effects.push({
      kind: 'call',
      target: name,
      category,
      line: call.startPosition.row + 1,
      text: oneLine(call.text),
      ...(condition ? { condition } : {}),
    });
  }
  for (const asg of collect(body, ['assignment_expression', 'augmented_assignment_expression'])) {
    const left = asg.childForFieldName('left');
    if (!left || left.type !== 'member_expression') continue;
    const prop = left.childForFieldName('property')?.text;
    if (!prop) continue;
    const category = classifyAssignment(prop);
    if (!category) continue;
    const condition = enclosingCondition(asg, body);
    effects.push({
      kind: 'assign',
      target: prop,
      category,
      line: asg.startPosition.row + 1,
      text: oneLine(asg.text),
      value: oneLine(asg.childForFieldName('right')?.text ?? '', 60),
      ...(condition ? { condition } : {}),
    });
  }
  effects.sort((a, b) => a.line - b.line);
  return { calls: [...calls], effects };
}

/** Extract functions, methods, classes, arrow functions, interfaces and types from one file. */
export async function extractSymbols(file: FileInput): Promise<CodeSymbol[]> {
  const parser = await parserFor(file.language);
  const tree = parser.parse(file.source);
  if (!tree) return [];
  const root = tree.rootNode;
  const imports = collect(root, ['import_statement'])
    .map((n) => n.childForFieldName('source')?.text.replace(/['"]/g, '') ?? '')
    .filter(Boolean);
  const lines = file.source.split('\n');
  const base = { commitSha: file.commitSha, filePath: file.filePath, imports, language: file.language };

  if (isTestFile(file.filePath)) {
    // Tests are indexed per file: what matters is which production symbols they exercise.
    const { calls } = analyzeBody(root);
    const name = file.filePath.split('/').pop()!;
    return [
      {
        ...base,
        id: symbolId(file.commitSha, file.filePath, name, 1),
        symbolName: name,
        symbolType: 'function',
        startLine: 1,
        endLine: lines.length,
        signature: name,
        content: file.source.slice(0, 4000),
        calls,
        effects: [],
        isTest: true,
      },
    ];
  }

  const out: CodeSymbol[] = [];
  const push = (node: TSNode, name: string, type: SymbolType, body: TSNode | null, outer: TSNode = node) => {
    const startLine = outer.startPosition.row + 1;
    const endLine = outer.endPosition.row + 1;
    const content = lines.slice(startLine - 1, endLine).join('\n');
    const { calls, effects } = body ? analyzeBody(body) : { calls: [], effects: [] };
    out.push({
      ...base,
      id: symbolId(file.commitSha, file.filePath, name, startLine),
      symbolName: name,
      symbolType: type,
      startLine,
      endLine,
      signature: oneLine((content.split('{')[0] ?? content).trim(), 200),
      content,
      calls,
      effects,
      isTest: false,
    });
  };

  const outerOf = (n: TSNode) => (n.parent?.type === 'export_statement' ? n.parent : n);

  for (const n of collect(root, ['function_declaration', 'generator_function_declaration'])) {
    const name = n.childForFieldName('name')?.text;
    if (name) push(n, name, 'function', n.childForFieldName('body'), outerOf(n));
  }
  for (const n of collect(root, ['class_declaration', 'abstract_class_declaration'])) {
    const name = n.childForFieldName('name')?.text;
    if (name) push(n, name, 'class', null, outerOf(n));
  }
  for (const n of collect(root, ['method_definition'])) {
    const name = n.childForFieldName('name')?.text;
    if (name && name !== 'constructor') push(n, name, 'method', n.childForFieldName('body'));
  }
  for (const n of collect(root, ['variable_declarator'])) {
    const value = n.childForFieldName('value');
    const name = n.childForFieldName('name')?.text;
    if (!name || !value || !['arrow_function', 'function_expression', 'function'].includes(value.type)) continue;
    const decl = n.parent;
    const outer = decl ? outerOf(decl) : n;
    push(n, name, 'arrow_function', value.childForFieldName('body'), outer);
  }
  for (const n of collect(root, ['interface_declaration', 'type_alias_declaration'])) {
    const name = n.childForFieldName('name')?.text;
    if (name) push(n, name, n.type === 'interface_declaration' ? 'interface' : 'type', null, outerOf(n));
  }
  tree.delete();
  return out;
}

const RANK: Record<Effect['category'], number> = { permission: 5, financial: 5, irreversible: 4, external: 3, data: 1 };

/**
 * One hop of effect propagation: a call to a repo function that itself has consequential effects
 * is recorded as an effect of the caller, so `finalizeApproval()` is not mistaken for a no-op.
 */
export function propagateEffects(symbols: CodeSymbol[]): void {
  const byName = new Map<string, CodeSymbol>();
  for (const s of symbols) if (!s.isTest && s.effects.length) byName.set(s.symbolName, s);
  for (const s of symbols) {
    if (s.isTest) continue;
    for (const callName of s.calls) {
      const callee = byName.get(callName);
      if (!callee || callee.id === s.id) continue;
      const strongest = [...callee.effects].sort((a, b) => RANK[b.category] - RANK[a.category])[0];
      if (!strongest || strongest.category === 'data') continue;
      const direct = s.effects.find((e) => e.kind === 'call' && e.target === callName);
      if (direct) {
        if (RANK[direct.category] < RANK[strongest.category]) {
          direct.category = strongest.category;
          direct.via = `${callName} → ${strongest.target}`;
        }
        continue;
      }
      const lineIdx = s.content.split('\n').findIndex((l) => new RegExp(`\\b${callName}\\s*\\(`).test(l));
      if (lineIdx < 0) continue;
      s.effects.push({
        kind: 'call',
        target: callName,
        category: strongest.category,
        line: s.startLine + lineIdx,
        text: oneLine(s.content.split('\n')[lineIdx] ?? callName),
        via: `${callName} → ${strongest.target}`,
      });
      s.effects.sort((a, b) => a.line - b.line);
    }
  }
}

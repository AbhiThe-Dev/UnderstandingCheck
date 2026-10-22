import { estimateTokens, type LlmProvider, type LlmRequest, type LlmResult } from '@uc/core';

type Script = unknown | ((req: LlmRequest<unknown>) => unknown);

/**
 * Deterministic provider for tests: returns scripted outputs per operation, still validated against
 * the request schema like real model output, with token usage estimated from the prompt.
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly calls: { operation: string; user: string }[] = [];
  constructor(private scripts: Record<string, Script[] | Script>) {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push({ operation: req.operation, user: req.user });
    const entry = this.scripts[req.operation];
    const script = Array.isArray(entry) ? entry.shift() : entry;
    if (script === undefined) throw new Error(`No scripted output for ${req.operation}`);
    const raw = typeof script === 'function' ? (script as (r: LlmRequest<unknown>) => unknown)(req as LlmRequest<unknown>) : script;
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) throw new Error(`Scripted output failed validation for ${req.operation}`);
    return {
      data: parsed.data,
      usage: { model: 'scripted', inputTokens: estimateTokens(req.system + req.user), outputTokens: estimateTokens(JSON.stringify(raw)) },
    };
  }
}

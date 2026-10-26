import OpenAI from 'openai';
import { z } from 'zod';
import { LlmOutputError, type LlmProvider, type LlmRequest, type LlmResult, type ModelTier } from '@uc/core';

export interface OpenAiProviderOptions {
  apiKey: string;
  models?: Partial<Record<ModelTier, string>>;
  baseURL?: string;
  timeoutMs?: number;
  /** Replaces the OpenAI client (tests). */
  client?: { chat: { completions: { create: OpenAI['chat']['completions']['create'] } } };
}

/**
 * OpenAI Chat Completions with JSON-schema structured output. Output is always re-validated with Zod;
 * anything that does not parse is rejected (the caller falls back or drops the candidate).
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private client: NonNullable<OpenAiProviderOptions['client']>;
  private models: Record<ModelTier, string>;
  /** Models that rejected `reasoning_effort` (non-reasoning models, or an effort level they lack). */
  private noEffort = new Set<string>();

  constructor(opts: OpenAiProviderOptions) {
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 30_000, maxRetries: 1 });
    this.models = { cheap: opts.models?.cheap ?? 'gpt-5-mini', reasoning: opts.models?.reasoning ?? 'gpt-5' };
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const model = this.models[req.tier];
    const create = (withEffort: boolean) =>
      this.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: {
          type: 'json_schema',
          // Input shape: what the model writes, before trimming transforms run.
          json_schema: { name: req.schemaName, schema: z.toJSONSchema(req.schema, { io: 'input' }) as Record<string, unknown>, strict: false },
        },
        max_completion_tokens: req.maxOutputTokens,
        ...(withEffort && req.effort ? { reasoning_effort: req.effort } : {}),
        ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
        stream: false,
      }, req.timeoutMs ? { timeout: req.timeoutMs, maxRetries: 0 } : undefined);
    let res;
    try {
      res = await create(!this.noEffort.has(model));
    } catch (err) {
      // Not every model accepts every effort level; fall back to the model's default once and remember.
      if (!req.effort || this.noEffort.has(model) || !/reasoning_effort|reasoning effort/i.test((err as Error).message)) throw err;
      this.noEffort.add(model);
      res = await create(false);
    }
    const usage = {
      model,
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      cachedInputTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    };
    const finish = res.choices[0]?.finish_reason ?? undefined;
    const content = res.choices[0]?.message?.content ?? '';
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      // Usually the answer was cut off at max_completion_tokens (finish_reason "length").
      throw new LlmOutputError(`Model returned non-JSON output for ${req.operation} (finish: ${finish})`, usage, finish);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new LlmOutputError(`Model output failed validation for ${req.operation}: ${parsed.error.message.slice(0, 300)}`, usage, finish);
    return { data: parsed.data, usage };
  }
}

import OpenAI from 'openai';
import { z } from 'zod';
import type { LlmProvider, LlmRequest, LlmResult, ModelTier } from '@uc/core';

export interface OpenAiProviderOptions {
  apiKey: string;
  models?: Partial<Record<ModelTier, string>>;
  baseURL?: string;
  timeoutMs?: number;
}

/**
 * OpenAI Chat Completions with JSON-schema structured output. Output is always re-validated with Zod;
 * anything that does not parse is rejected (the caller falls back or drops the candidate).
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private models: Record<ModelTier, string>;

  constructor(opts: OpenAiProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 30_000, maxRetries: 1 });
    this.models = { cheap: opts.models?.cheap ?? 'gpt-5-mini', reasoning: opts.models?.reasoning ?? 'gpt-5' };
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const model = this.models[req.tier];
    const res = await this.client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: req.schemaName, schema: z.toJSONSchema(req.schema) as Record<string, unknown>, strict: false },
      },
      max_completion_tokens: req.maxOutputTokens,
    });
    const content = res.choices[0]?.message?.content ?? '';
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new Error(`Model returned non-JSON output for ${req.operation}`);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new Error(`Model output failed validation for ${req.operation}: ${parsed.error.message.slice(0, 300)}`);
    return {
      data: parsed.data,
      usage: { model, inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
    };
  }
}

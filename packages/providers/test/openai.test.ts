import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { OpenAiProvider } from '../src';

const req = { operation: 'screen', tier: 'cheap' as const, system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), schemaName: 'x', maxOutputTokens: 100 };
const reply = { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 768 } } };

function stub(fail?: (params: any) => Error | null) {
  const sent: any[] = [];
  const client = {
    chat: {
      completions: {
        create: (async (params: any) => {
          sent.push(params);
          const err = fail?.(params);
          if (err) throw err;
          return reply;
        }) as any,
      },
    },
  };
  return { client, sent };
}

describe('OpenAiProvider', () => {
  it('sends reasoning effort and the cache key, and reports cached input tokens', async () => {
    const { client, sent } = stub();
    const p = new OpenAiProvider({ apiKey: 'k', client });
    const r = await p.complete({ ...req, effort: 'minimal', cacheKey: 'session-1' });
    expect(sent[0]).toMatchObject({ model: 'gpt-5-mini', reasoning_effort: 'minimal', prompt_cache_key: 'session-1', max_completion_tokens: 100 });
    expect(r.usage).toEqual({ model: 'gpt-5-mini', inputTokens: 1000, outputTokens: 50, cachedInputTokens: 768 });
  });

  it('omits effort when not asked for', async () => {
    const { client, sent } = stub();
    await new OpenAiProvider({ apiKey: 'k', client }).complete(req);
    expect(sent[0]).not.toHaveProperty('reasoning_effort');
    expect(sent[0]).not.toHaveProperty('prompt_cache_key');
  });

  it('retries without effort once a model rejects it, and remembers', async () => {
    const { client, sent } = stub((params) => (params.reasoning_effort ? new Error("400 Unsupported value: 'reasoning_effort' does not support 'minimal' with this model") : null));
    const p = new OpenAiProvider({ apiKey: 'k', client });
    await p.complete({ ...req, effort: 'minimal' });
    await p.complete({ ...req, effort: 'minimal' });
    expect(sent.map((s) => s.reasoning_effort)).toEqual(['minimal', undefined, undefined]);
  });

  it('does not swallow unrelated errors', async () => {
    const { client } = stub(() => new Error('429 rate limited'));
    await expect(new OpenAiProvider({ apiKey: 'k', client }).complete({ ...req, effort: 'low' })).rejects.toThrow('429');
  });
});

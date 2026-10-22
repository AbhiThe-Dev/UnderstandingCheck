import type { LlmProvider } from '@uc/core';
import { OpenAiProvider } from './openai';

export { OpenAiProvider, type OpenAiProviderOptions } from './openai';
export { ScriptedLlmProvider } from './scripted';
export { MAX_SPEED, MIN_SPEED, ReplayTranscriptSource, type ReplayOptions, type ReplayStatus, type TranscriptSource } from './transcription';

/** Returns null when no credentials are configured; callers then use the heuristic analyzer. */
export function createLlmProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  if (!env.OPENAI_API_KEY) return null;
  return new OpenAiProvider({
    apiKey: env.OPENAI_API_KEY,
    models: { cheap: env.UC_MODEL_CHEAP, reasoning: env.UC_MODEL_REASONING },
    baseURL: env.OPENAI_BASE_URL,
  });
}

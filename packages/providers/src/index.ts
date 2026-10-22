import { readFileSync } from 'node:fs';
import type { LlmProvider } from '@uc/core';
import { GitHubAppHost, type RepoHost } from './github';
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
export {
  FakeRepoHost,
  GitHubAppHost,
  RepoAccessError,
  gitBlobSha,
  type GitHubAppOptions,
  type HostRepo,
  type IssueSnapshot,
  type RepoHost,
  type RepoRef,
  type TreeEntry,
} from './github';

/**
 * GitHub App host from `GITHUB_APP_ID` plus `GITHUB_APP_PRIVATE_KEY_PATH` (preferred: a file only the
 * user can read) or `GITHUB_APP_PRIVATE_KEY`. Returns null when not configured.
 */
export function createRepoHostFromEnv(env: NodeJS.ProcessEnv = process.env): RepoHost | null {
  if (!env.GITHUB_APP_ID) return null;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY_PATH ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8') : env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!privateKey) return null;
  return new GitHubAppHost({ appId: env.GITHUB_APP_ID, privateKey });
}
export { RECALL_REGIONS, RecallClient, createRecallClientFromEnv, parseRecallTranscript, recallSegment, type RecallRegion, type RecallTranscript, type RecallUpload } from './recall';
export { LIVE_SAMPLE_RATE, OpenAiLiveTranscriber, type LiveTranscriber, type LiveTranscriberEvents, type OpenAiLiveOptions } from './liveTranscribe';

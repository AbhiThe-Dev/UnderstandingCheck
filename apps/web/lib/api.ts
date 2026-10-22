import type { Segment, SessionState } from '@uc/core';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
  if (!res.ok) throw new ApiError(res.status, [data.error ?? res.statusText, ...(data.issues ?? [])].join(' — '));
  return data as T;
}

export interface SessionView {
  state: SessionState;
  segments: Segment[];
  status: 'active' | 'ended';
}

export interface SessionMeta {
  id: string;
  title: string;
  status: 'active' | 'ended';
  repositoryId: string | null;
  featureDescription: string | null;
  githubIssueReference: string | null;
  analyzer: string;
  commitSha: string | null;
  consentConfirmedAt: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface SessionResponse extends SessionView {
  session: SessionMeta;
  repo: { id: string; name: string; indexedCommitSha: string | null } | null;
}

export interface RepoRow {
  id: string;
  name: string;
  source: 'sample' | 'github';
  sampleKey: string | null;
  indexingStatus: 'pending' | 'indexing' | 'ready' | 'failed';
  indexingError: string | null;
  indexingProgress: { done: number; total: number } | null;
  indexedCommitSha: string | null;
  symbolCount: number;
  indexedAt: string | null;
}

export interface SampleTranscript {
  id: string;
  title: string;
  repo: string | null;
  featureDescription: string;
  transcript: string;
  priorDecisions: { id: string; description: string; source: string }[];
}

export interface Samples {
  repos: { key: string; name: string; description: string }[];
  transcripts: SampleTranscript[];
  demo: { id: string; resolution: string };
}

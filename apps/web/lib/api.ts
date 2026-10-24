import type { Segment, SessionMetrics, SessionState } from '@uc/core';

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

export interface ReplayInfo {
  jobId: string;
  status: 'idle' | 'playing' | 'paused' | 'finished' | 'stopped' | 'failed';
  delivered: number;
  total: number;
  speed: number;
  error: string | null;
}

export interface CaptureInfo {
  source: 'recall' | 'microphone';
  status: 'live' | 'stopped' | 'error';
  startedAt: string;
  stoppedAt: string | null;
  segments: number;
  duplicates: number;
  partial: { speaker: string; text: string } | null;
  speaker: string | null;
  meeting: { title?: string; platform?: string } | null;
  error: string | null;
  audioSeconds: number;
  model: string | null;
  screen?: { lastAt: string; matched: string[] } | null;
}

export interface CaptureConfig {
  recall: { configured: boolean; region?: string; apiUrl?: string };
  microphone: { configured: boolean; model?: string };
}

export interface SessionView {
  state: SessionState;
  segments: Segment[];
  status: 'active' | 'ended';
  replay: ReplayInfo | null;
  capture: CaptureInfo | null;
  metrics: SessionMetrics;
  /** Text of Slack messages the copilot is using, from server memory only (never stored). */
  slackExcerpts?: { id: string; text: string }[];
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
  githubIssue: { number: number; title: string; state: string; url: string; bodyExcerpt: string } | null;
  startedAt: string;
  endedAt: string | null;
}

export interface SessionResponse extends SessionView {
  session: SessionMeta;
  repo: { id: string; name: string; indexedCommitSha: string | null; htmlUrl: string | null } | null;
}

export interface RepoRow {
  id: string;
  name: string;
  source: 'sample' | 'github';
  sampleKey: string | null;
  htmlUrl: string | null;
  defaultBranch: string;
  lastSyncedAt: string | null;
  lastSync: { mode: 'full' | 'incremental' | 'unchanged'; changed: number; removed: number; fetched: number; files: number; durationMs: number } | null;
  indexingStatus: 'pending' | 'indexing' | 'ready' | 'failed' | 'revoked';
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

export interface RecordVersion {
  id: string;
  version: number;
  description: string;
  acceptanceCriteria: string[];
  codeRefs: import('@uc/core').CodeRef[];
  slackRefs?: import('@uc/core').SlackCitation[];
  evidence: import('@uc/core').RecordEvidence[];
  evidenceRedacted: boolean;
  confirmedBy: string[];
  confirmation: 'verbal' | 'clarified';
  concern: string | null;
  origin: 'created' | 'supersedes';
  revisedInMeeting: boolean;
  sessionId: string | null;
  sessionTitle: string;
  createdAt: string;
}

export interface RecordRow {
  id: string;
  number: number;
  title: string;
  status: 'active' | 'retired';
  retiredReason: string | null;
  currentVersion: number;
  repositoryId: string | null;
  reaffirmations: { sessionId: string | null; sessionTitle: string; at: string; confirmedBy: string[] }[];
  lastConfirmedAt: string;
  createdAt: string;
}

export interface RecordListItem extends RecordRow {
  label: string;
  repositoryName: string | null;
  repositoryUrl: string | null;
  current: RecordVersion;
}

export interface RecordDetail {
  record: RecordRow;
  versions: RecordVersion[];
  label: string;
  repositoryName: string | null;
  repositoryUrl: string | null;
}

export interface PublishedRecord {
  recordId: string;
  number: number;
  version: number;
  outcome: 'created' | 'superseded' | 'reaffirmed';
  title: string;
}

export interface SlackStatus {
  configured: boolean;
  canConnect: boolean;
  connected: boolean;
  source?: 'oauth' | 'env' | null;
  team?: string | null;
  user?: string | null;
  scopes?: string[];
  privateAccess?: boolean;
  problem?: string | null;
  message?: string;
}

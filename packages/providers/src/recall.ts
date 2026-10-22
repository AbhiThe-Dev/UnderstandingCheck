import type { TranscriptSegmentInput } from '@uc/core';

export const RECALL_REGIONS = ['us-west-2', 'us-east-1', 'eu-central-1', 'ap-northeast-1'] as const;
export type RecallRegion = (typeof RECALL_REGIONS)[number];

export interface RecallUpload {
  id: string;
  uploadToken: string;
  recordingId: string | null;
  status: string;
}

/**
 * Server-side Recall.ai client. The API key stays here; the desktop app only ever receives a
 * short-lived upload token for one recording.
 */
export class RecallClient {
  readonly apiUrl: string;
  private readonly http: typeof fetch;

  constructor(private readonly opts: { apiKey: string; region: RecallRegion; fetch?: typeof fetch }) {
    this.apiUrl = `https://${opts.region}.recall.ai`;
    this.http = opts.fetch ?? fetch;
  }

  get region() {
    return this.opts.region;
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.http(`${this.apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Token ${this.opts.apiKey}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Recall.ai ${res.status} on ${path}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  /**
   * Create a Desktop SDK upload for one meeting, with Recall's own streaming transcription delivered
   * to the desktop app as `realtime-event`s. Only call this when the user starts capture: an upload
   * that never records stays pending at Recall.
   */
  async createSdkUpload(metadata: Record<string, string>): Promise<RecallUpload> {
    const r = await this.request<{ id: string; upload_token: string; recording_id: string | null; status: { code: string } }>('/api/v1/sdk_upload/', {
      method: 'POST',
      body: {
        recording_config: {
          transcript: { provider: { recallai_streaming: { mode: 'prioritize_low_latency' } } },
          realtime_endpoints: [{ type: 'desktop_sdk_callback', events: ['transcript.data', 'transcript.partial_data'] }],
        },
        metadata,
      },
    });
    return { id: r.id, uploadToken: r.upload_token, recordingId: r.recording_id, status: r.status.code };
  }

  async getSdkUpload(id: string): Promise<{ id: string; status: string; recordingId: string | null }> {
    const r = await this.request<{ id: string; recording_id: string | null; status: { code: string } }>(`/api/v1/sdk_upload/${encodeURIComponent(id)}/`);
    return { id: r.id, status: r.status.code, recordingId: r.recording_id };
  }
}

export function createRecallClientFromEnv(env: NodeJS.ProcessEnv = process.env): RecallClient | null {
  if (!env.RECALL_API_KEY) return null;
  const region = (env.RECALL_REGION ?? 'us-west-2') as RecallRegion;
  if (!RECALL_REGIONS.includes(region)) throw new Error(`RECALL_REGION must be one of ${RECALL_REGIONS.join(', ')}`);
  return new RecallClient({ apiKey: env.RECALL_API_KEY, region });
}

export interface RecallTranscript {
  final: boolean;
  participantId: string;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number | null;
}

interface RecallWord {
  text?: string;
  start_timestamp?: { relative?: number } | null;
  end_timestamp?: { relative?: number } | null;
}

/**
 * Normalize a Desktop SDK `realtime-event` (`transcript.data` / `transcript.partial_data`).
 * Accepts the payload with or without the outer `data` wrapper, since the SDK passes the event's
 * `data` through. Returns null for other events or empty utterances.
 */
export function parseRecallTranscript(evt: { event?: string; data?: unknown }): RecallTranscript | null {
  if (evt.event !== 'transcript.data' && evt.event !== 'transcript.partial_data') return null;
  const outer = (evt.data ?? {}) as { data?: unknown };
  const payload = ((outer.data && typeof outer.data === 'object' ? outer.data : outer) ?? {}) as {
    words?: RecallWord[];
    participant?: { id?: number | string; name?: string | null } | null;
  };
  const words = Array.isArray(payload.words) ? payload.words : [];
  const text = words
    .map((w) => (w.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
  if (!text) return null;
  const participantId = String(payload.participant?.id ?? 'unknown');
  const name = payload.participant?.name?.trim();
  const toMs = (s: number | undefined) => (typeof s === 'number' && Number.isFinite(s) ? Math.round(s * 1000) : null);
  return {
    final: evt.event === 'transcript.data',
    participantId,
    // An unnamed participant becomes "Participant N", which the engine treats as unattributed.
    speaker: name || `Participant ${participantId}`,
    text,
    startMs: toMs(words[0]?.start_timestamp?.relative) ?? 0,
    endMs: toMs(words.at(-1)?.end_timestamp?.relative ?? undefined),
  };
}

/** A final Recall utterance as an engine segment, with an id stable across resends. */
export function recallSegment(t: RecallTranscript, uploadId: string, baseTimestampMs = 0): TranscriptSegmentInput {
  return {
    speaker: t.speaker,
    text: t.text,
    timestamp: baseTimestampMs + t.startMs,
    externalId: `recall:${uploadId}:${t.participantId}:${t.startMs}`,
  };
}

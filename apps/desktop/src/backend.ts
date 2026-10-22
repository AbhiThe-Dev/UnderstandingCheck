export interface ApiConfig {
  apiUrl: string;
  webUrl: string;
}

export async function api<T = unknown>(cfg: ApiConfig, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
  if (!res.ok) {
    const detail = data.issues?.length ? ` (${data.issues.join('; ')})` : '';
    throw new Error(`${data.error ?? `${res.status} ${res.statusText}`}${detail}`);
  }
  return data as T;
}

interface QueuedEvent {
  event: string;
  data: unknown;
}

export interface ForwardStats {
  sent: number;
  pending: number;
  failures: number;
  lastError: string | null;
}

/**
 * Delivers Recall realtime events to the API in order, in small batches, retrying with backoff when
 * the API is unreachable. Only the newest partial caption is kept while waiting (older partials are
 * superseded anyway); final utterances are never dropped unless the backlog exceeds its cap. The API
 * ignores resends, so retrying a batch that partly succeeded is safe.
 */
export class ForwardQueue {
  private items: { sessionId: string; evt: QueuedEvent }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  private backoffMs = 0;
  private stats: ForwardStats = { sent: 0, pending: 0, failures: 0, lastError: null };
  static readonly MAX_BACKLOG = 2000;

  constructor(
    private cfg: ApiConfig,
    private onStats: (s: ForwardStats) => void,
    private intervalMs = 250,
  ) {}

  enqueue(sessionId: string, evt: QueuedEvent) {
    if (evt.event === 'transcript.partial_data') {
      this.items = this.items.filter((i) => !(i.sessionId === sessionId && i.evt.event === 'transcript.partial_data'));
    }
    this.items.push({ sessionId, evt });
    if (this.items.length > ForwardQueue.MAX_BACKLOG) this.items.splice(0, this.items.length - ForwardQueue.MAX_BACKLOG);
    this.report();
    this.schedule();
  }

  private report() {
    this.stats.pending = this.items.length;
    this.onStats({ ...this.stats });
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.intervalMs + this.backoffMs);
  }

  async flush(): Promise<void> {
    if (this.sending || this.items.length === 0) return;
    this.sending = true;
    try {
      while (this.items.length) {
        const sessionId = this.items[0]!.sessionId;
        const batch = this.items.filter((i) => i.sessionId === sessionId).slice(0, 50);
        await api(this.cfg, `/api/sessions/${sessionId}/capture/recall/events`, { method: 'POST', body: batch.map((b) => b.evt) });
        this.items = this.items.filter((i) => !batch.includes(i));
        this.stats.sent += batch.length;
        this.backoffMs = 0;
        this.report();
      }
    } catch (err) {
      this.stats.failures++;
      this.stats.lastError = (err as Error).message;
      this.backoffMs = Math.min(10_000, Math.max(500, this.backoffMs * 2));
      this.report();
      this.schedule();
    } finally {
      this.sending = false;
    }
  }
}

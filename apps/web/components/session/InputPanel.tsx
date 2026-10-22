'use client';

import { useEffect, useRef, useState } from 'react';
import { parseTranscript, type TranscriptSegmentInput } from '@uc/core';
import { Badge, Button, Input, Textarea } from '@/components/ui/primitives';
import { API_URL, api, type ReplayInfo, type Samples } from '@/lib/api';
import { cn } from '@/lib/utils';

type Send = (seg: TranscriptSegmentInput) => Promise<void>;

interface Props {
  sessionId: string;
  send: Send;
  samples: Samples | null;
  initialSample?: string;
  speakers: string[];
  disabled: boolean;
  replay: ReplayInfo | null;
}

/**
 * Mode A (server-side replay of a transcript at adjustable speed) and Mode B (live input through
 * the same streaming endpoint an external transcription source would use).
 */
export function InputPanel(props: Props) {
  const [tab, setTab] = useState<'replay' | 'live'>('replay');
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="flex border-b border-[var(--color-line)] text-sm">
        {(['replay', 'live'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn('px-4 py-2', tab === t ? 'border-b-2 border-[var(--color-accent)] font-medium' : 'text-[var(--color-muted)]')}>
            {t === 'replay' ? 'Replay transcript' : 'Live input'}
          </button>
        ))}
      </div>
      {tab === 'replay' ? <Replay {...props} /> : <Live {...props} />}
    </div>
  );
}

const STATUS_TONE: Record<ReplayInfo['status'], 'accent' | 'amber' | 'green' | 'red' | 'neutral'> = {
  idle: 'neutral',
  playing: 'accent',
  paused: 'amber',
  finished: 'green',
  stopped: 'neutral',
  failed: 'red',
};

function Replay({ sessionId, samples, initialSample, disabled, replay }: Props) {
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState(replay?.speed ?? 4);
  const [error, setError] = useState<string | null>(null);
  const speedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!samples || !initialSample || text) return;
    const t = samples.transcripts.find((x) => x.id === initialSample);
    if (t) setText(t.transcript);
  }, [samples, initialSample, text]);

  const active = replay && (replay.status === 'playing' || replay.status === 'paused');
  const segments = parseTranscript(text);

  const call = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const start = (paused = false) => api(`/api/sessions/${sessionId}/replay`, { body: { text, speed, paused } });
  const control = (body: { action?: 'pause' | 'resume' | 'step' | 'stop'; speed?: number }) => api(`/api/sessions/${sessionId}/replay/control`, { body });

  const onSpeed = (v: number) => {
    setSpeed(v);
    if (!active) return;
    if (speedTimer.current) clearTimeout(speedTimer.current);
    speedTimer.current = setTimeout(() => void call(() => control({ speed: v })), 150);
  };

  return (
    <div className="space-y-3 p-3">
      <select
        className="h-8 w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 text-xs"
        onChange={(e) => {
          const value = e.target.value === '__demo_followup' ? samples?.demo.resolution : samples?.transcripts.find((x) => x.id === e.target.value)?.transcript;
          if (value) setText(value);
        }}
        defaultValue=""
        aria-label="Load sample transcript"
        disabled={Boolean(active)}
      >
        <option value="">Load a sample transcript…</option>
        {samples?.transcripts.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
        {samples && <option value="__demo_followup">Demo follow-up: the team settles the question</option>}
      </select>
      <Textarea
        rows={7}
        value={text}
        onChange={(e) => setText(e.target.value)}
        readOnly={Boolean(active)}
        placeholder={'Priya (PO): We need a way to undo approvals.\nSam (Developer): I’ll set the status back to pending.'}
        aria-label="Transcript"
        data-testid="replay-text"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {replay?.status === 'playing' ? (
          <Button size="sm" onClick={() => call(() => control({ action: 'pause' }))} data-testid="replay-pause">
            Pause
          </Button>
        ) : replay?.status === 'paused' ? (
          <Button size="sm" variant="primary" onClick={() => call(() => control({ action: 'resume' }))} data-testid="replay-play">
            Resume
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={disabled || segments.length === 0} onClick={() => call(() => start())} data-testid="replay-play">
            Play
          </Button>
        )}
        <Button
          size="sm"
          disabled={disabled || replay?.status === 'playing' || (!active && segments.length === 0)}
          onClick={() => call(() => (active ? control({ action: 'step' }) : start(true).then(() => control({ action: 'step' }))))}
          title="Send the next turn now"
        >
          Step
        </Button>
        {active && (
          <Button size="sm" variant="ghost" onClick={() => call(() => control({ action: 'stop' }))}>
            Stop
          </Button>
        )}
        <label className="ml-1 flex items-center gap-1.5 text-[var(--color-muted)]">
          Speed
          <input type="range" min={0.5} max={20} step={0.5} value={speed} onChange={(e) => onSpeed(Number(e.target.value))} aria-label="Replay speed" />
          <span className="w-8 tabular-nums">{speed}×</span>
        </label>
        <span className="ml-auto flex items-center gap-2 tabular-nums text-[var(--color-muted)]" data-testid="replay-progress">
          {replay && <Badge tone={STATUS_TONE[replay.status]}>{replay.status}</Badge>}
          {replay && replay.status !== 'stopped' ? `${replay.delivered}/${replay.total}` : `0/${segments.length}`} segments
        </span>
      </div>
      {(error || replay?.error) && <p className="text-xs text-red-600">{error ?? replay?.error}</p>}
      <p className="text-[11px] text-[var(--color-muted)]">Replays run on the server, paced like speech, and feed the same pipeline as live transcription.</p>
    </div>
  );
}

function Live({ send, sessionId, speakers, disabled }: Props) {
  const [speaker, setSpeaker] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!speaker.trim() || !text.trim()) return;
    try {
      await send({ speaker: speaker.trim(), text: text.trim() });
      setText('');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2 p-3">
      <div className="flex gap-2">
        <Input list="speakers" className="w-40" value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="Speaker" aria-label="Speaker" data-testid="live-speaker" />
        <datalist id="speakers">
          {speakers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="What they said…" aria-label="Utterance" data-testid="live-text" />
        <Button type="submit" variant="primary" disabled={disabled} data-testid="live-send">
          Send
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
        External transcription can stream into this session (send an <code>externalId</code> to make retries safe):{' '}
        <code className="break-all">
          POST {API_URL}/api/sessions/{sessionId}/segments {'{"speaker","text","timestamp","externalId"}'}
        </code>
      </p>
    </form>
  );
}

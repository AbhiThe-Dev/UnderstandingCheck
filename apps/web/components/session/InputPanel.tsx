'use client';

import { useEffect, useRef, useState } from 'react';
import { parseTranscript, type TranscriptSegmentInput } from '@uc/core';
import { Button, Input, Textarea } from '@/components/ui/primitives';
import { API_URL, type Samples } from '@/lib/api';
import { cn } from '@/lib/utils';

type Send = (seg: TranscriptSegmentInput) => Promise<void>;

/**
 * Mode A (replay a transcript at adjustable speed, segment by segment) and Mode B (live input
 * through the same streaming endpoint an external transcription source would use).
 */
export function InputPanel(props: { sessionId: string; send: Send; samples: Samples | null; initialSample?: string; speakers: string[]; disabled: boolean }) {
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

function Replay({ send, samples, initialSample, disabled }: Parameters<typeof InputPanel>[0]) {
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState(4);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speedRef = useRef(speed);
  const playingRef = useRef(false);
  speedRef.current = speed;

  useEffect(() => {
    if (!samples || !initialSample || text) return;
    const t = samples.transcripts.find((x) => x.id === initialSample);
    if (t) setText(t.transcript);
  }, [samples, initialSample, text]);

  const segments = parseTranscript(text);

  const step = async (i: number) => {
    const seg = segments[i];
    if (!seg) return false;
    try {
      await send(seg);
      setCursor(i + 1);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const play = async () => {
    setError(null);
    setPlaying(true);
    playingRef.current = true;
    let i = cursor;
    while (playingRef.current && i < segments.length) {
      // Pace roughly like speech: longer utterances take longer to say.
      const gap = Math.min(4000, Math.max(800, segments[i]!.text.length * 45));
      if (i > 0) await new Promise((r) => setTimeout(r, gap / speedRef.current));
      if (!playingRef.current) break;
      if (!(await step(i))) break;
      i++;
    }
    playingRef.current = false;
    setPlaying(false);
  };

  const pause = () => {
    playingRef.current = false;
    setPlaying(false);
  };

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 min-w-0 flex-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 text-xs"
          onChange={(e) => {
            const value = e.target.value === '__demo_followup' ? samples?.demo.resolution : samples?.transcripts.find((x) => x.id === e.target.value)?.transcript;
            if (value) {
              setText(value);
              setCursor(0);
            }
          }}
          defaultValue=""
          aria-label="Load sample transcript"
        >
          <option value="">Load a sample transcript…</option>
          {samples?.transcripts.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
          {samples && <option value="__demo_followup">Demo follow-up: the team settles the question</option>}
        </select>
      </div>
      <Textarea
        rows={7}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCursor(0);
        }}
        placeholder={'Priya (PO): We need a way to undo approvals.\nSam (Developer): I’ll set the status back to pending.'}
        aria-label="Transcript"
        data-testid="replay-text"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {playing ? (
          <Button size="sm" onClick={pause}>
            Pause
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={disabled || cursor >= segments.length} onClick={play} data-testid="replay-play">
            {cursor > 0 ? 'Resume' : 'Play'}
          </Button>
        )}
        <Button size="sm" disabled={disabled || playing || cursor >= segments.length} onClick={() => step(cursor)}>
          Step
        </Button>
        <label className="ml-1 flex items-center gap-1.5 text-[var(--color-muted)]">
          Speed
          <input type="range" min={0.5} max={20} step={0.5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          <span className="w-8 tabular-nums">{speed}×</span>
        </label>
        <span className="ml-auto tabular-nums text-[var(--color-muted)]" data-testid="replay-progress">
          {cursor}/{segments.length} segments
        </span>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function Live({ send, sessionId, speakers, disabled }: Parameters<typeof InputPanel>[0]) {
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
        External transcription can stream into this session:{' '}
        <code className="break-all">
          POST {API_URL}/api/sessions/{sessionId}/segments {'{"speaker","text","timestamp"}'}
        </code>
      </p>
    </form>
  );
}

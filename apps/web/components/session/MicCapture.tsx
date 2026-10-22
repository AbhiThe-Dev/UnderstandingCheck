'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Input } from '@/components/ui/primitives';
import { API_URL, type CaptureInfo } from '@/lib/api';

const SAMPLE_RATE = 24_000;
/** RMS above this counts as speech. Conservative; quiet rooms rarely exceed ~0.005. */
const SPEECH_RMS = 0.015;
/** A pause this long after speech ends the turn. */
const PAUSE_MS = 700;

// Runs on the audio thread: forwards mono frames to the main thread.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('uc-tap', Tap);
`;

type Status = 'idle' | 'connecting' | 'live' | 'error';

/**
 * In-person capture: the microphone is streamed to the API, which relays it to live transcription.
 * Live transcription does not separate voices, so whoever runs the session taps the current speaker.
 */
export function MicCapture(props: { sessionId: string; speakers: string[]; capture: CaptureInfo | null; configured: boolean; disabled: boolean }) {
  const [consent, setConsent] = useState(false);
  const [speaker, setSpeaker] = useState(props.speakers[0] ?? 'Room');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState<string[]>([]);
  const stopRef = useRef<(() => void) | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const setSpeakerLive = (name: string) => {
    setSpeaker(name);
    if (wsRef.current?.readyState === WebSocket.OPEN && name.trim()) wsRef.current.send(JSON.stringify({ type: 'speaker', name: name.trim() }));
  };

  const start = async () => {
    setError(null);
    setStatus('connecting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      setStatus('error');
      setError(`Microphone unavailable: ${(e as Error).message}`);
      return;
    }
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ctx, 'uc-tap');
    source.connect(tap);

    const wsUrl = `${API_URL.replace(/^http/, 'ws')}/api/sessions/${props.sessionId}/audio?consent=1&speaker=${encodeURIComponent(speaker.trim() || 'Room')}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    // ~100 ms chunks of 16-bit PCM; simple energy-based pause detection decides turn boundaries.
    let pending: Float32Array[] = [];
    let pendingLen = 0;
    let speaking = false;
    let silentMs = 0;
    tap.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      const frame = ev.data;
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
      const rms = Math.sqrt(sum / frame.length);
      setLevel((l) => l * 0.8 + Math.min(1, rms * 12) * 0.2);
      const frameMs = (frame.length / SAMPLE_RATE) * 1000;
      if (rms > SPEECH_RMS) {
        speaking = true;
        silentMs = 0;
      } else if (speaking) {
        silentMs += frameMs;
      }
      pending.push(frame);
      pendingLen += frame.length;
      if (pendingLen >= SAMPLE_RATE / 10 && ws.readyState === WebSocket.OPEN) {
        const pcm = new Int16Array(pendingLen);
        let o = 0;
        for (const f of pending) for (let i = 0; i < f.length; i++) pcm[o++] = Math.max(-1, Math.min(1, f[i]!)) * 0x7fff;
        ws.send(pcm.buffer);
        pending = [];
        pendingLen = 0;
      }
      if (speaking && silentMs >= PAUSE_MS && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'commit' }));
        speaking = false;
        silentMs = 0;
      }
    };

    const stop = () => {
      tap.port.onmessage = null;
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
      stopRef.current = null;
    };
    stopRef.current = stop;

    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { type: string; text?: string; speaker?: string; message?: string };
      if (m.type === 'ready') setStatus('live');
      if (m.type === 'final' && m.text) setHeard((h) => [`${m.speaker}: ${m.text}`, ...h].slice(0, 3));
      if (m.type === 'error') {
        setError(m.message ?? 'Transcription error');
      }
    };
    ws.onclose = () => {
      stopRef.current?.();
      setStatus((s) => (s === 'live' || s === 'connecting' ? 'idle' : s));
      setLevel(0);
    };
    ws.onerror = () => {
      setStatus('error');
      setError((e) => e ?? 'Could not connect to the transcription service');
    };
  };

  const stop = () => {
    stopRef.current?.();
    setStatus('idle');
  };

  if (!props.configured) {
    return (
      <p className="p-3 text-xs text-[var(--color-muted)]">
        Microphone transcription needs <code>OPENAI_API_KEY</code> in <code>.env</code> (with credits on the OpenAI account). Meeting calls are captured by the desktop app.
      </p>
    );
  }

  const live = status === 'live' || status === 'connecting';
  return (
    <div className="space-y-3 p-3 text-sm">
      {!live && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" data-testid="mic-consent" />
          Everyone in the room knows they are being transcribed. Audio is not stored; only the text is kept.
        </label>
      )}
      <div className="flex items-center gap-2">
        {live ? (
          <Button size="sm" variant="danger" onClick={stop} data-testid="mic-stop">
            Stop microphone
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={!consent || props.disabled} onClick={start} data-testid="mic-start">
            Start microphone
          </Button>
        )}
        {status === 'live' && (
          <Badge tone="red">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" aria-hidden /> listening
          </Badge>
        )}
        {status === 'connecting' && <Badge tone="amber">connecting…</Badge>}
        <div className="h-1.5 flex-1 overflow-hidden rounded bg-[var(--color-canvas)]" aria-label="Input level">
          <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
      </div>
      <div>
        <div className="mb-1 text-[11px] text-[var(--color-muted)]">Who is speaking? Live transcription can’t tell voices apart, so tap the current speaker.</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {props.speakers.map((s) => (
            <Button key={s} size="sm" variant={s === speaker ? 'primary' : 'secondary'} onClick={() => setSpeakerLive(s)}>
              {s}
            </Button>
          ))}
          <Input className="h-7 w-36 text-xs" value={speaker} onChange={(e) => setSpeaker(e.target.value)} onBlur={(e) => setSpeakerLive(e.target.value)} placeholder="Speaker name" aria-label="Current speaker" />
        </div>
      </div>
      {props.capture?.source === 'microphone' && props.capture.partial && (
        <p className="text-xs italic text-[var(--color-muted)]">
          {props.capture.partial.speaker}: {props.capture.partial.text}…
        </p>
      )}
      {heard.length > 0 && (
        <ul className="space-y-0.5 text-xs text-[var(--color-muted)]">
          {heard.map((h, i) => (
            <li key={i}>✓ {h}</li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-red-600" data-testid="mic-error">{error}</p>}
    </div>
  );
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { desktopCapturer, screen as displays, type NativeImage } from 'electron';
import { api, type ApiConfig } from './backend';
import { extractCodeMentions, type CodeMentions, type ScreenLine } from './screenText';

export interface ScreenStatus {
  state: 'off' | 'unavailable' | 'reading' | 'error';
  /** The first code match from the last screen read, e.g. "approveApplication (src/applications/approve.ts:11)". */
  lastMatch: string | null;
  message: string | null;
}

/** Re-send unchanged code names this often, so the copilot knows they are still on screen. */
const HEARTBEAT_MS = 60_000;
const OCR_TIMEOUT_MS = 15_000;
/** Cells (of 256) that must change before a display counts as changed; ignores a ticking clock. */
const CHANGED_CELLS = 6;

/**
 * Reads code names from the screen while a meeting is recorded, so "this function" during a screen
 * share has something to refer to. Everything happens on this Mac: snapshots stay in memory, text is
 * recognised by the bundled Vision helper, and only extracted identifiers and file paths are sent to
 * the API. The suggestions panel is content-protected, so it never appears in a snapshot.
 */
export class ScreenWatcher {
  private sessionId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private helper: ChildProcessWithoutNullStreams | null = null;
  private waiting = new Map<string, (lines: ScreenLine[]) => void>();
  private seq = 0;
  private busy = false;
  private prints = new Map<string, number[]>();
  private texts = new Map<string, ScreenLine[]>();
  private lastSent = '';
  private lastSentAt = 0;
  private status: ScreenStatus = { state: 'off', lastMatch: null, message: null };

  constructor(
    private cfg: ApiConfig,
    private onStatus: (s: ScreenStatus) => void,
    private intervalMs = 3000,
    private helperPath = join(__dirname, 'uc-screen-text'),
  ) {}

  get available() {
    return process.platform === 'darwin' && existsSync(this.helperPath);
  }

  start(sessionId: string) {
    this.stop();
    if (!this.available) return this.set({ state: 'unavailable', lastMatch: null, message: 'Screen reading needs the bundled text helper (build on a Mac with Xcode Command Line Tools).' });
    this.sessionId = sessionId;
    this.helper = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.helper.stdout }).on('line', (line) => {
      try {
        const reply = JSON.parse(line) as { id: string; lines?: ScreenLine[] };
        this.waiting.get(reply.id)?.(reply.lines ?? []);
        this.waiting.delete(reply.id);
      } catch {
        // not a reply line
      }
    });
    this.helper.on('exit', () => {
      for (const done of this.waiting.values()) done([]);
      this.waiting.clear();
      this.helper = null;
    });
    this.set({ state: 'reading', lastMatch: null, message: null });
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.helper?.kill();
    this.helper = null;
    this.sessionId = null;
    this.prints.clear();
    this.texts.clear();
    this.lastSent = '';
    if (this.status.state !== 'off') this.set({ state: 'off', lastMatch: null, message: null });
  }

  private set(s: ScreenStatus) {
    this.status = s;
    this.onStatus(s);
  }

  private async tick() {
    if (this.busy || !this.sessionId) return;
    this.busy = true;
    const sessionId = this.sessionId;
    try {
      for (const { id, image } of await snapshots()) {
        const print = fingerprint(image);
        const before = this.prints.get(id);
        if (before && changedCells(before, print) < CHANGED_CELLS) continue;
        this.prints.set(id, print);
        this.texts.set(id, await this.read(image));
      }
      const mentions: CodeMentions = extractCodeMentions([...this.texts.values()].flat());
      const key = JSON.stringify(mentions);
      if (key === this.lastSent && Date.now() - this.lastSentAt < HEARTBEAT_MS) return;
      const r = await api<{ matched: string[] }>(this.cfg, `/api/sessions/${sessionId}/capture/screen`, { method: 'POST', body: mentions });
      this.lastSent = key;
      this.lastSentAt = Date.now();
      if (this.sessionId === sessionId) this.set({ state: 'reading', lastMatch: r.matched[0] ?? null, message: null });
    } catch (err) {
      if (this.sessionId === sessionId) this.set({ state: 'error', lastMatch: this.status.lastMatch, message: (err as Error).message });
    } finally {
      this.busy = false;
    }
  }

  private read(image: NativeImage): Promise<ScreenLine[]> {
    const helper = this.helper;
    if (!helper) return Promise.resolve([]);
    const id = String(++this.seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve([]);
      }, OCR_TIMEOUT_MS);
      this.waiting.set(id, (lines) => {
        clearTimeout(timer);
        resolve(lines);
      });
      helper.stdin.write(`${JSON.stringify({ id, png: image.toPNG().toString('base64') })}\n`);
    });
  }
}

/** Every display, at native resolution capped at 2560 px wide (enough for code-sized text). */
async function snapshots(): Promise<{ id: string; image: NativeImage }[]> {
  const all = displays.getAllDisplays();
  const widest = Math.max(...all.map((d) => d.size.width * d.scaleFactor));
  const scale = Math.min(1, 2560 / widest);
  const big = all.reduce((a, d) => (d.size.width * d.size.height > a.size.width * a.size.height ? d : a), all[0]!);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(big.size.width * big.scaleFactor * scale), height: Math.round(big.size.height * big.scaleFactor * scale) },
  });
  return sources.filter((s) => !s.thumbnail.isEmpty()).map((s) => ({ id: s.display_id || s.id, image: s.thumbnail }));
}

/** 16×16 grayscale, 16 levels: cheap enough to run every few seconds, coarse enough to ignore noise. */
function fingerprint(image: NativeImage): number[] {
  const px = image.resize({ width: 16, height: 16, quality: 'good' }).toBitmap(); // BGRA
  const out: number[] = [];
  for (let i = 0; i + 3 < px.length; i += 4) out.push(Math.round((px[i]! * 0.11 + px[i + 1]! * 0.59 + px[i + 2]! * 0.3) / 16));
  return out;
}

function changedCells(a: number[], b: number[]) {
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

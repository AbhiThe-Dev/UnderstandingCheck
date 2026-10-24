// Live end-to-end test of meeting capture: a real Google Meet call, real Recall.ai capture, the real
// GitHub repository, no people needed in the room.
//
//   node scripts/live-call-test.mjs <meet-url> [--unmute] [--screen]
//
// --screen: a screen-share run. Keep src/applications/approve.ts (e.g. on GitHub) visible on this Mac's
// screen; Sam talks about "this" without ever naming the function, and the copilot must tie it to the
// code it reads from the screen.
//
// A 1:1 call between the person at this Mac and "Sam":
// - Sam is a Recall.ai bot that joins the call and speaks his lines (OpenAI text-to-speech).
// - "Your" lines play through this Mac's speakers so its microphone hears them, as in a real call.
//   Known limitation: Recall records everything this Mac plays as call audio, so these lines come out
//   as the other person, and the "your name" check fails. Verifying your side needs a real voice.
//   --unmute turns the speakers up for the run if they are muted, and restores them afterwards.
// - The desktop app (launched here with a local debugging port) captures the call exactly as a person would:
//   select the meeting, new session, repository, your name, consent, Start.
// - The script then checks what reached the session: order, speakers, and the suggestion with its code link.
//
// The meeting itself must be open in Chrome or Safari on this Mac, as the active tab of a visible window
// (Recall cannot see a background tab), and the bots admitted when they knock. Keep the display awake.
// Costs: a few minutes of two Recall bots plus the desktop recording, and a few cents of speech.
// Needs the API running (pnpm dev) and OPENAI_API_KEY, RECALL_API_KEY, RECALL_REGION in .env.

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(join(root, '.env'));

const API = process.env.UC_API_URL ?? 'http://127.0.0.1:4000';
const RECALL = `https://${process.env.RECALL_REGION ?? 'us-west-2'}.recall.ai/api/v1`;
// The real path (not pnpm's symlink), so macOS matches the permissions granted to this Electron.app.
const ELECTRON_APP = realpathSync(join(root, 'apps/desktop/node_modules/electron/dist/Electron.app'));
const DEBUG_PORT = 9333;
const REPO_NAME = process.env.UC_LIVE_REPO ?? 'AbhiThe-Dev/approvals-demo';
const OUT = join(root, '.data/live-call');

// 'you' is the person at this Mac (spoken locally); everyone else is a bot in the call.
const SPEAKERS = { you: 'nova', Sam: 'onyx' };
const BOTS = ['Sam'];
const SCRIPT = [
  ['you', 'Admins need to be able to undo an approval when a reviewer approves the wrong application.'],
  ['Sam', "Easy enough. I'll just set the status back to pending."],
  ['you', 'Sounds good.'],
];

// Nobody names the code: "this" is whatever is on the shared screen.
const SCREEN_SCRIPT = [
  ['Sam', 'We need a way to undo this when someone gets it wrong.'],
  ['Sam', "Easy enough. I'll just set the status back to pending."],
  ['Sam', "I'll get it done this sprint."],
];

const meetUrl = process.argv[2];
const unmute = process.argv.includes('--unmute');
const screenRun = process.argv.includes('--screen');
const LINES = screenRun ? SCREEN_SCRIPT : SCRIPT;
if (!meetUrl?.startsWith('https://meet.google.com/')) {
  console.error('usage: node scripts/live-call-test.mjs https://meet.google.com/xxx-xxxx-xxx');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

async function http(url, init = {}, auth) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: auth } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
const api = (path, init) => http(`${API}${path}`, init);
const recall = (path, init) => http(`${RECALL}${path}`, init, `Token ${process.env.RECALL_API_KEY}`);

// ---------------- speech

async function speak(text, voice) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3' }),
  });
  if (!res.ok) throw new Error(`text-to-speech failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** One second of MPEG-1 Layer III silence (mono, 44.1 kHz, 128 kbps): Recall requires a clip at bot creation. */
function silentMp3() {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  return Buffer.concat(Array.from({ length: 39 }, () => frame));
}

// ---------------- Recall bots (the other people in the call)

async function joinBots() {
  const silence = silentMp3().toString('base64');
  const bots = {};
  for (const name of BOTS) {
    const bot = await recall('/bot/', {
      method: 'POST',
      body: {
        meeting_url: meetUrl,
        bot_name: name,
        automatic_audio_output: { in_call_recording: { data: { kind: 'mp3', b64_data: silence } } },
      },
    });
    bots[name] = bot.id;
    log(`bot ${name} created (${bot.id})`);
  }
  return bots;
}

async function botStatus(id) {
  const bot = await recall(`/bot/${id}/`);
  return bot.status_changes?.at(-1)?.code ?? 'unknown';
}

async function waitForBots(bots, timeoutMs = 5 * 60_000) {
  const end = Date.now() + timeoutMs;
  const announced = new Set();
  while (Date.now() < end) {
    const states = Object.fromEntries(await Promise.all(Object.entries(bots).map(async ([n, id]) => [n, await botStatus(id)])));
    for (const [n, s] of Object.entries(states)) {
      if (!announced.has(`${n}:${s}`)) log(`bot ${n}: ${s}${s === 'in_waiting_room' ? '  ← admit it in the Meet' : ''}`);
      announced.add(`${n}:${s}`);
    }
    if (Object.values(states).some((s) => ['fatal', 'call_ended', 'done'].includes(s))) throw new Error(`a bot could not join: ${JSON.stringify(states)}`);
    if (Object.values(states).every((s) => s.startsWith('in_call'))) return;
    await sleep(3000);
  }
  throw new Error('bots were not admitted within 5 minutes');
}

async function leaveBots(bots) {
  for (const [name, id] of Object.entries(bots)) {
    await recall(`/bot/${id}/leave_call/`, { method: 'POST' }).catch((e) => log(`bot ${name} leave: ${e.message}`));
  }
}

// ---------------- this Mac's speakers (the local side of the call)

const osa = (script) => execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();

/** macOS stops screen and audio capture while the screen is locked, so a run would record nothing. */
function screenLocked() {
  const out = execFileSync('ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8' });
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out);
}

function speakersAudible() {
  return !/output muted:true|output volume:0,/.test(osa('get volume settings'));
}

/** Turns the speakers up for the run; returns how to put them back. */
function ensureSpeakers() {
  if (speakersAudible()) return () => undefined;
  if (!unmute) {
    log('WARNING: this Mac\'s speakers are muted, so your lines will not reach the microphone (pass --unmute)');
    return () => undefined;
  }
  const before = osa('get volume settings');
  const volume = Number(/output volume:(\d+)/.exec(before)?.[1] ?? 0);
  const muted = before.includes('output muted:true');
  osa('set volume output volume 60 without output muted');
  log('speakers turned up for the test');
  return () => osa(`set volume output volume ${volume}${muted ? ' with output muted' : ''}`);
}

function playLocally(mp3File) {
  return new Promise((resolve, reject) => execFile('afplay', [mp3File], (err) => (err ? reject(err) : resolve())));
}

// ---------------- desktop app, driven through its own control window

function quitDesktop() {
  try {
    execFileSync('osascript', ['-e', `tell application "${ELECTRON_APP}" to quit`], { stdio: 'ignore' });
  } catch {
    // not running
  }
}

async function launchDesktop() {
  quitDesktop();
  await sleep(3000);
  mkdirSync(OUT, { recursive: true });
  const logFile = join(OUT, 'desktop.log');
  // `open` makes macOS check Electron's own privacy permissions, not those of this terminal.
  execFileSync('open', ['-n', '-a', ELECTRON_APP, '--stdout', logFile, '--stderr', logFile, '--args', `--remote-debugging-port=${DEBUG_PORT}`, join(root, 'apps/desktop')]);
  for (let i = 0; i < 60; i++) {
    const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then((r) => r.json()).catch(() => []);
    const control = targets.find((t) => t.type === 'page' && t.url.endsWith('static/index.html'));
    if (control) return control.webSocketDebuggerUrl;
    await sleep(1000);
  }
  throw new Error('desktop app did not start');
}

async function control(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.result?.exceptionDetails ? reject(new Error(msg.result.exceptionDetails.exception?.description ?? 'evaluate failed')) : resolve(msg.result?.result?.value)));
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  return { evaluate, close: () => ws.close() };
}

async function startCapture(page, repoId, title) {
  for (let i = 0; i < 90; i++) {
    const state = await page.evaluate(`window.uc.state().then((s) => ({ sdk: s.sdk, meetings: s.meetings, perms: s.permissions }))`);
    const meet = state.meetings.find((m) => m.platform === 'google-meet');
    if (state.sdk === 'ready' && meet) {
      log(`desktop app sees the call (${meet.title || 'untitled'}) — starting capture`);
      return page.evaluate(`(async () => {
        const $ = (id) => document.getElementById(id);
        const radio = [...document.querySelectorAll('input[name=meeting]')].find((r) => r.value === ${JSON.stringify(meet.id)});
        radio.click();
        for (let i = 0; i < 20 && ![...$('repo').options].some((o) => o.value === ${JSON.stringify(repoId)}); i++) await new Promise((r) => setTimeout(r, 250));
        $('session').value = '__new'; $('session').dispatchEvent(new Event('change'));
        $('title').value = ${JSON.stringify(title)};
        $('repo').value = ${JSON.stringify(repoId)};
        const you = $('you').value.trim();
        if (!$('screenContext').checked && !$('screenContext').disabled) $('screenContext').click();
        $('consent').click();
        if ($('start').disabled) throw new Error('Start capture is disabled');
        $('start').click();
        for (let i = 0; i < 60; i++) {
          if ($('startError').textContent) throw new Error($('startError').textContent);
          if ($('session').value !== '__new') return { sessionId: $('session').value, you };
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error('capture did not start');
      })()`);
    }
    if (i % 10 === 0) log(`waiting for the desktop app to see the call (sdk ${state.sdk}, ${state.meetings.length} meetings)`);
    await sleep(2000);
  }
  throw new Error('the desktop app never detected the Google Meet call');
}

// ---------------- checks

async function verify(sessionId, you) {
  const view = await api(`/api/sessions/${sessionId}`);
  const names = Object.fromEntries(view.state.participants.map((p) => [p.id, p.displayName]));
  const transcript = view.segments.map((s) => ({ speaker: names[s.participantId], text: s.text }));
  const live = view.state.discrepancies.filter((d) => d.visibility === 'live');
  const all = transcript.map((t) => t.text.toLowerCase()).join(' ');
  if (screenRun) {
    const seen = (view.state.screen?.evidenceIds ?? []).map((id) => view.state.evidence.find((e) => e.id === id)?.symbolName);
    const checks = [
      ['capture came from Recall', view.capture?.source === 'recall'],
      ['every scripted line arrived', transcript.length >= LINES.length],
      ['nobody named the function', !all.includes('approv')],
      ['approveApplication was read from the screen', seen.includes('approveApplication')],
      ['a live suggestion was raised', live.length > 0],
      ['the suggestion cites src/applications/approve.ts', live.some((d) => d.codeRefs.some((r) => r.filePath === 'src/applications/approve.ts'))],
    ];
    return { sessionId, transcript, onScreen: seen, suggestions: live.map((d) => ({ category: d.category, title: d.title, code: d.codeRefs.map((r) => `${r.filePath}:${r.startLine}`) })), checks, capture: view.capture };
  }
  const checks = [
    ['capture came from Recall', view.capture?.source === 'recall'],
    ['every scripted line arrived', transcript.length >= LINES.length],
    [`speakers are named ${you} and Sam`, [you, 'Sam'].every((n) => Object.values(names).includes(n))],
    ['no line attributed to "Guest", "Host" or "Others"', !Object.values(names).some((n) => ['Guest', 'Host', 'Others'].includes(n))],
    ['key words transcribed ("undo", "pending")', all.includes('undo') && all.includes('pending')],
    ['a live suggestion was raised', live.length > 0],
    ['the suggestion cites src/applications/approve.ts', live.some((d) => d.codeRefs.some((r) => r.filePath === 'src/applications/approve.ts'))],
    ['the quick fix agreed to is flagged (false alignment)', live.some((d) => d.category === 'false_alignment')],
  ];
  return { sessionId, transcript, suggestions: live.map((d) => ({ category: d.category, title: d.title, code: d.codeRefs.map((r) => `${r.filePath}:${r.startLine}`) })), checks, capture: view.capture };
}

// ---------------- run

const bots = {};
let page;
let restoreSpeakers = () => undefined;
try {
  if (screenLocked()) throw new Error('the screen is locked; macOS does not allow recording until it is unlocked');
  const repo = (await api('/api/repos')).find((r) => r.name === REPO_NAME && r.indexingStatus === 'ready');
  if (!repo) throw new Error(`repository ${REPO_NAME} is not indexed in the API`);

  log('generating speech');
  mkdirSync(OUT, { recursive: true });
  const audio = [];
  for (const [i, [who, text]] of LINES.entries()) {
    const mp3 = await speak(text, SPEAKERS[who]);
    const file = join(OUT, `line-${i}.mp3`);
    writeFileSync(file, mp3);
    audio.push({ who, text, file, mp3: mp3.toString('base64') });
  }
  restoreSpeakers = ensureSpeakers();

  page = await control(await launchDesktop());
  Object.assign(bots, await joinBots());
  await waitForBots(bots);

  const { sessionId, you } = await startCapture(page, repo.id, `Live call test ${new Date().toISOString().slice(0, 16)}`);
  log(`capturing into session ${sessionId} as "${you}"`);
  await sleep(8000); // let Recall's transcription warm up before anyone speaks

  for (const { who, text, file, mp3 } of audio) {
    log(`${who === 'you' ? you : who}: ${text}`);
    if (who === 'you') {
      await playLocally(file);
      await sleep(1500);
    } else {
      await recall(`/bot/${bots[who]}/output_audio/`, { method: 'POST', body: { kind: 'mp3', b64_data: mp3 } });
      await sleep(2500 + text.split(/\s+/).length * 450);
    }
  }
  log('waiting for the last transcripts');
  await sleep(15_000);

  await page.evaluate(`document.getElementById('stop').click()`);
  await sleep(5000);
  const report = await verify(sessionId, you);
  const file = join(OUT, `report-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));

  console.log('\nTranscript:');
  for (const t of report.transcript) console.log(`  ${t.speaker}: ${t.text}`);
  if (report.onScreen) console.log(`\nOn screen: ${report.onScreen.join(', ') || '(nothing matched)'}`);
  console.log('\nSuggestions:');
  for (const s of report.suggestions) console.log(`  [${s.category}] ${s.title} (${s.code.join(', ')})`);
  console.log('\nChecks:');
  for (const [name, ok] of report.checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`\nReport: ${file}`);
  process.exitCode = report.checks.every(([, ok]) => ok) ? 0 : 1;
} catch (err) {
  console.error(`\nLive call test failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  restoreSpeakers();
  await leaveBots(bots);
  page?.close();
}

import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, screen, shell } from 'electron';
import { join } from 'node:path';
import { ForwardQueue, api, type ApiConfig } from './backend';

/**
 * Desktop companion for meeting capture.
 * - Detects Zoom / Meet / Teams with the Recall.ai Desktop SDK (no bot joins the call).
 * - Records only after an explicit Start with consent confirmed; a menu-bar indicator shows when.
 * - Forwards Recall's speaker-labeled transcript events to the local API, which runs the analysis.
 * - Shows the copilot's private suggestions in a narrow always-on-top side panel. Nothing is spoken.
 * The Recall API key never reaches this app: the API creates each upload and returns a short-lived token.
 */

const cfg: ApiConfig = {
  apiUrl: process.env.UC_API_URL ?? 'http://127.0.0.1:4000',
  webUrl: process.env.UC_WEB_URL ?? 'http://localhost:3000',
};

type Sdk = typeof import('@recallai/desktop-sdk').default;
type PermissionName = Parameters<Sdk['requestPermission']>[0];

interface Meeting {
  id: string;
  title?: string;
  platform?: string;
  url?: string;
}

interface State {
  sdk: 'starting' | 'ready' | 'unavailable' | 'error';
  sdkMessage: string | null;
  apiReachable: boolean;
  recallRegion: string | null;
  permissions: Record<string, string>;
  meetings: Meeting[];
  network: 'online' | 'disconnected';
  recording: {
    windowId: string;
    sessionId: string;
    uploadId: string;
    meeting: Meeting | null;
    status: 'starting' | 'recording' | 'ended' | 'error';
    startedAt: string;
    error: string | null;
  } | null;
  forwarding: { sent: number; pending: number; failures: number; lastError: string | null };
  log: string[];
}

const state: State = {
  sdk: 'starting',
  sdkMessage: null,
  apiReachable: false,
  recallRegion: null,
  permissions: {},
  meetings: [],
  network: 'online',
  recording: null,
  forwarding: { sent: 0, pending: 0, failures: 0, lastError: null },
  log: [],
};

let sdk: Sdk | null = null;
let control: BrowserWindow | null = null;
let panel: BrowserWindow | null = null;
let tray: Tray | null = null;

const queue = new ForwardQueue(cfg, (stats) => {
  state.forwarding = stats;
  push();
});

function log(line: string) {
  state.log = [`${new Date().toLocaleTimeString()} ${line}`, ...state.log].slice(0, 40);
  console.log(`[desktop] ${line}`);
}

function push() {
  control?.webContents.send('state', state);
  const rec = state.recording?.status === 'recording';
  tray?.setTitle(rec ? ' ● REC' : '');
  tray?.setToolTip(rec ? `Recording ${state.recording?.meeting?.title ?? 'meeting'} for Understanding Check` : 'Understanding Check — not recording');
}

// ---------------- Recall.ai Desktop SDK

async function startSdk() {
  let capture: { recall: { configured: boolean; apiUrl?: string; region?: string } };
  try {
    capture = await api(cfg, '/api/capture/config');
    state.apiReachable = true;
  } catch (err) {
    state.sdk = 'error';
    state.sdkMessage = `Cannot reach the Understanding Check API at ${cfg.apiUrl}. Start it with "pnpm dev". (${(err as Error).message})`;
    return push();
  }
  if (!capture.recall.configured || !capture.recall.apiUrl) {
    state.sdk = 'unavailable';
    state.sdkMessage = 'Recall.ai is not configured on the API (set RECALL_API_KEY and RECALL_REGION in .env).';
    return push();
  }
  state.recallRegion = capture.recall.region ?? null;

  try {
    sdk = (await import('@recallai/desktop-sdk')).default;
  } catch (err) {
    state.sdk = 'unavailable';
    state.sdkMessage = `The Recall.ai Desktop SDK is not available on this machine: ${(err as Error).message}`;
    return push();
  }

  // Listeners first, so initial permission and already-running meeting events are not missed.
  sdk.addEventListener('permission-status', ({ permission, status }) => {
    if (state.permissions[permission] !== status) log(`Permission ${permission}: ${status}`);
    state.permissions[permission] = status;
    push();
  });
  sdk.addEventListener('meeting-detected', ({ window }) => {
    state.meetings = [...state.meetings.filter((m) => m.id !== window.id), { ...window }];
    log(`Meeting detected: ${window.title ?? window.platform ?? window.id}`);
    push();
  });
  sdk.addEventListener('meeting-updated', ({ window }) => {
    state.meetings = state.meetings.map((m) => (m.id === window.id ? { ...m, ...window } : m));
    if (state.recording?.windowId === window.id) state.recording.meeting = { ...window };
    push();
  });
  sdk.addEventListener('meeting-closed', ({ window }) => {
    state.meetings = state.meetings.filter((m) => m.id !== window.id);
    log(`Meeting closed: ${window.title ?? window.id}`);
    push();
  });
  sdk.addEventListener('recording-started', ({ window }) => {
    if (state.recording?.windowId === window.id) state.recording.status = 'recording';
    log('Recording started');
    push();
  });
  sdk.addEventListener('recording-ended', ({ window }) => {
    if (state.recording?.windowId === window.id) void endCapture();
  });
  sdk.addEventListener('realtime-event', (evt) => {
    const rec = state.recording;
    if (!rec || evt.window.id !== rec.windowId) return;
    queue.enqueue(rec.sessionId, { event: evt.event, data: evt.data });
  });
  sdk.addEventListener('network-status', ({ status }) => {
    state.network = status === 'disconnected' ? 'disconnected' : 'online';
    log(status === 'disconnected' ? 'Network disconnected — Recall stops recording after 2 minutes offline' : 'Network reconnected');
    push();
  });
  sdk.addEventListener('error', ({ type, message, window }) => {
    log(`SDK error (${type}): ${message}`);
    if (state.recording && (!window || window.id === state.recording.windowId)) {
      state.recording.status = 'error';
      state.recording.error = message;
    }
    push();
  });
  sdk.addEventListener('shutdown', ({ code }) => {
    log(`Recall SDK process exited (code ${code}); it restarts automatically`);
    push();
  });

  try {
    await sdk.init({ apiUrl: capture.recall.apiUrl, acquirePermissionsOnStartup: ['accessibility', 'screen-capture', 'microphone'] });
    state.sdk = 'ready';
    state.sdkMessage = null;
    log(`Recall SDK ready (${state.recallRegion})`);
  } catch (err) {
    state.sdk = 'unavailable';
    state.sdkMessage = `Recall.ai Desktop SDK could not start: ${(err as Error).message}`;
    log(state.sdkMessage);
  }
  push();
}

async function startCapture(args: { windowId: string; sessionId: string; consentConfirmed: boolean }) {
  if (!sdk || state.sdk !== 'ready') throw new Error(state.sdkMessage ?? 'The Recall SDK is not ready');
  if (!args.consentConfirmed) throw new Error('Confirm that participants know the meeting is recorded and transcribed');
  if (state.recording && ['starting', 'recording'].includes(state.recording.status)) throw new Error('Already recording; stop first');
  const meeting = state.meetings.find((m) => m.id === args.windowId) ?? null;
  const { uploadId, uploadToken } = await api<{ uploadId: string; uploadToken: string }>(cfg, `/api/sessions/${args.sessionId}/capture/recall`, {
    method: 'POST',
    body: { consentConfirmed: true, meeting: meeting ? { title: meeting.title, platform: meeting.platform } : null },
  });
  state.recording = { windowId: args.windowId, sessionId: args.sessionId, uploadId, meeting, status: 'starting', startedAt: new Date().toISOString(), error: null };
  push();
  try {
    await sdk.startRecording({ windowId: args.windowId, uploadToken });
  } catch (err) {
    state.recording.status = 'error';
    state.recording.error = (err as Error).message;
    await api(cfg, `/api/sessions/${args.sessionId}/capture/stop`, { method: 'POST', body: { error: (err as Error).message } }).catch(() => undefined);
    push();
    throw err;
  }
  openPanel(args.sessionId);
}

async function endCapture() {
  const rec = state.recording;
  if (!rec || rec.status === 'ended') return;
  rec.status = 'ended';
  await queue.flush();
  await api(cfg, `/api/sessions/${rec.sessionId}/capture/stop`, { method: 'POST', body: {} }).catch(() => undefined);
  log('Recording ended');
  push();
}

async function stopCapture() {
  const rec = state.recording;
  if (!rec) return;
  if (sdk && ['starting', 'recording'].includes(rec.status)) await sdk.stopRecording({ windowId: rec.windowId }).catch(() => undefined);
  await endCapture();
}

// ---------------- windows

function openPanel(sessionId: string) {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 460;
  if (!panel || panel.isDestroyed()) {
    panel = new BrowserWindow({
      width,
      height: workArea.height,
      x: workArea.x + workArea.width - width,
      y: workArea.y,
      alwaysOnTop: true,
      title: 'Understanding Check — private suggestions',
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    // The side panel is private to this screen: keep it out of screen shares where the OS allows.
    panel.setContentProtection(true);
  }
  void panel.loadURL(`${cfg.webUrl}/sessions/${sessionId}`);
  panel.show();
}

function createControl() {
  control = new BrowserWindow({
    width: 440,
    height: 720,
    title: 'Understanding Check — capture',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  void control.loadFile(join(__dirname, '../static/index.html'));
  // Only the web app may be opened from the control window, and in the side panel or the browser.
  control.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(cfg.webUrl)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('state', () => state);
ipcMain.handle('sessions', () => api(cfg, '/api/sessions'));
ipcMain.handle('repos', () => api(cfg, '/api/repos'));
ipcMain.handle('session:create', (_e, body: { title: string; repositoryId: string | null; featureDescription?: string }) =>
  api(cfg, '/api/sessions', { method: 'POST', body: { ...body, consentConfirmed: true } }),
);
ipcMain.handle('capture:start', (_e, args: { windowId: string; sessionId: string; consentConfirmed: boolean }) => startCapture(args));
ipcMain.handle('capture:stop', () => stopCapture());
ipcMain.handle('permission', (_e, p: PermissionName) => sdk?.requestPermission(p));
ipcMain.handle('panel', (_e, sessionId: string) => openPanel(sessionId));
ipcMain.handle('retry', () => startSdk());

app.whenReady().then(() => {
  tray = new Tray(nativeImage.createEmpty());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show capture window', click: () => (control && !control.isDestroyed() ? control.show() : createControl()) },
      { label: 'Stop recording', click: () => void stopCapture() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  createControl();
  void startSdk();
});

app.on('before-quit', async (e) => {
  if (state.recording && ['starting', 'recording'].includes(state.recording.status)) {
    e.preventDefault();
    await stopCapture();
    await sdk?.shutdown().catch(() => undefined);
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  // Keep running in the menu bar while a recording is active.
  if (!state.recording || state.recording.status !== 'recording') app.quit();
});

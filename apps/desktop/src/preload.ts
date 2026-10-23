import { contextBridge, ipcRenderer } from 'electron';

// The control window gets a narrow, explicit API; it has no Node or Electron access of its own.
contextBridge.exposeInMainWorld('uc', {
  state: () => ipcRenderer.invoke('state'),
  onState: (cb: (s: unknown) => void) => ipcRenderer.on('state', (_e, s) => cb(s)),
  sessions: () => ipcRenderer.invoke('sessions'),
  repos: () => ipcRenderer.invoke('repos'),
  createSession: (body: { title: string; repositoryId: string | null; featureDescription?: string }) => ipcRenderer.invoke('session:create', body),
  start: (args: { windowId: string; sessionId: string; consentConfirmed: boolean; localName: string | null }) => ipcRenderer.invoke('capture:start', args),
  stop: () => ipcRenderer.invoke('capture:stop'),
  requestPermission: (p: string) => ipcRenderer.invoke('permission', p),
  openPanel: (sessionId: string) => ipcRenderer.invoke('panel', sessionId),
  retry: () => ipcRenderer.invoke('retry'),
});

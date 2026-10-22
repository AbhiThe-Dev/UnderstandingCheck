'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_URL, api, type SessionResponse, type SessionView } from './api';

/**
 * Session data kept live over Server-Sent Events: segments arriving from any source
 * (replay in this tab, another tab, or the streaming endpoint) update the panel.
 */
export function useSession(id: string) {
  const [data, setData] = useState<SessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const reload = useCallback(async () => {
    try {
      setData(await api<SessionResponse>(`/api/sessions/${id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void reload();
    const es = new EventSource(`${API_URL}/api/sessions/${id}/stream`);
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));
    es.addEventListener('state', (ev) => {
      const view = JSON.parse((ev as MessageEvent<string>).data) as SessionView;
      setData((prev) => (prev ? { ...prev, ...view, session: { ...prev.session, status: view.status } } : prev));
    });
    return () => es.close();
  }, [id, reload]);

  const apply = useCallback((view: SessionView) => {
    setData((prev) => (prev ? { ...prev, ...view, session: { ...prev.session, status: view.status } } : prev));
  }, []);

  return { data, error, connected, reload, apply };
}

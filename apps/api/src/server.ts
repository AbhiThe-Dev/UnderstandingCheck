import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { Services } from './services';

// Local secrets/settings (git-ignored). Real environment variables take precedence.
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

// UC_DATA_DIR=:memory: runs on a throwaway in-memory database (used by the browser tests).
const dataDir = process.env.UC_DATA_DIR ?? fileURLToPath(new URL('../../../.data/pglite', import.meta.url));
const port = Number(process.env.API_PORT ?? 4000);

const services = await Services.create({ dataDir: dataDir === ':memory:' ? undefined : dataDir });
const app = createApp(services);

const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  const cap = services.capture.config();
  console.log(
    `[api] listening on http://127.0.0.1:${port} · analyzer=${services.analyzerMode} · github=${services.host ? 'app configured' : 'off'} · recall=${cap.recall.configured ? cap.recall.region : 'off'} · mic=${cap.microphone.configured ? 'on' : 'off'} · slack=${services.slack ? 'configured' : 'off'} · data=${dataDir}`,
  );
});
app.injectWebSocket(server);

// Poll connected GitHub repositories for new commits (no webhooks needed on a laptop).
const syncMinutes = Number(process.env.GITHUB_SYNC_INTERVAL_MINUTES ?? 5);
if (services.github && syncMinutes > 0) {
  setInterval(() => {
    void services.syncAllGitHub().then((results) => {
      for (const r of results) if ('mode' in r && r.mode !== 'unchanged') console.log(`[sync] ${r.id}: ${r.mode}, ${r.fetched} files fetched`);
    });
  }, syncMinutes * 60_000).unref();
}

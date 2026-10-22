import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { Services } from './services';

// UC_DATA_DIR=:memory: runs on a throwaway in-memory database (used by the browser tests).
const dataDir = process.env.UC_DATA_DIR ?? fileURLToPath(new URL('../../../.data/pglite', import.meta.url));
const port = Number(process.env.API_PORT ?? 4000);

const services = await Services.create({ dataDir: dataDir === ':memory:' ? undefined : dataDir });
const app = createApp(services);

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`[api] listening on http://127.0.0.1:${port} · analyzer=${services.analyzerMode} · data=${dataDir}`);
});

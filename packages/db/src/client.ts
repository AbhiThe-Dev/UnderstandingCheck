import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

export type Db = PgliteDatabase<typeof schema>;

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Embedded Postgres (PGlite) — real Postgres semantics (FTS, jsonb, FKs) with zero setup.
 * `dataDir` persists to disk; omit it for an in-memory database (tests).
 * A hosted Postgres/Supabase adapter (drizzle-orm/node-postgres) is planned for Phase 3; the schema
 * and migrations are already plain Postgres.
 */
export async function openDatabase(dataDir?: string): Promise<{ db: Db; client: PGlite }> {
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

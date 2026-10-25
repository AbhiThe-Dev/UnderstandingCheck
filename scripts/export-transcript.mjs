#!/usr/bin/env node
// Export one session's transcript as "[h:mm:ss] Speaker: text" lines (the format parseTranscript and
// eval:compare read). Reads a temporary copy of the database, never the live one.
//
//   node scripts/export-transcript.mjs [--data .data/pglite] (--session <id> | --title <title>) > meeting.txt
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const data = args.data ?? '.data/pglite';
if (!args.session && !args.title) {
  console.error('Usage: export-transcript.mjs [--data dir] (--session <id> | --title <title>)');
  process.exit(2);
}

const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { PGlite } = await import(pathToFileURL(require.resolve('@electric-sql/pglite')).href);

const copy = mkdtempSync(join(tmpdir(), 'uc-export-'));
cpSync(data, copy, { recursive: true });
const db = new PGlite(copy);
try {
  const where = args.session ? 'id = $1' : 'title = $1';
  const { rows: sessions } = await db.query(
    `select id, title, (select count(*)::int from transcript_segments t where t.session_id = s.id) as n
     from meeting_sessions s where ${where} order by n desc limit 1`,
    [args.session ?? args.title],
  );
  const s = sessions[0];
  if (!s) throw new Error('No such session');
  const { rows } = await db.query(
    `select t.text, t.timestamp_ms as ts, p.display_name as speaker
     from transcript_segments t
     left join participants p on p.session_id = t.session_id and p.local_id = t.participant_local_id
     where t.session_id = $1 order by t.idx`,
    [s.id],
  );
  const clock = (ms) => {
    const t = Math.floor(ms / 1000);
    return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  console.log(`# ${s.title} (${s.id}), ${rows.length} turns`);
  for (const r of rows) console.log(`[${clock(Number(r.ts))}] ${(r.speaker ?? 'Unknown').replace(/[:()[\]]/g, ' ').trim()}: ${r.text.replace(/\s+/g, ' ')}`);
} finally {
  await db.close();
  rmSync(copy, { recursive: true, force: true });
}

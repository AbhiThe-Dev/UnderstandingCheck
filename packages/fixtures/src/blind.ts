import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiscrepancyCategory } from '@uc/core';
import type { FixtureCase, RepoName } from './cases';

/**
 * Blind cases: transcripts written or recorded by people who have not read the analyzer's rules or
 * prompts, each in `blind/<case>/transcript.txt` with its labels in `expected.json`. They are scored
 * separately (`pnpm eval:compare --blind`) and must never be used to tune rules or prompts.
 */
export const BLIND_DIR = fileURLToPath(new URL('../blind', import.meta.url));

interface BlindExpected {
  repo: RepoName | null;
  featureDescription?: string;
  surfaced: DiscrepancyCategory[];
  notSurfaced?: DiscrepancyCategory[];
  notes?: string;
}

export function loadBlindCases(dir = BLIND_DIR): FixtureCase[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'transcript.txt')) && existsSync(join(dir, d.name, 'expected.json')))
    .map((d) => {
      const expected = JSON.parse(readFileSync(join(dir, d.name, 'expected.json'), 'utf8')) as BlindExpected;
      return {
        id: `blind:${d.name}`,
        title: expected.notes ?? d.name,
        repo: expected.repo,
        featureDescription: expected.featureDescription,
        transcript: readFileSync(join(dir, d.name, 'transcript.txt'), 'utf8'),
        heldOut: true,
        expected: { surfaced: expected.surfaced, notSurfaced: expected.notSurfaced },
      };
    });
}

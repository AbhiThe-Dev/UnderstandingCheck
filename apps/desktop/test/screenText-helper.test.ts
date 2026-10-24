import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = join(__dirname, '../dist/uc-screen-text');

describe.skipIf(!existsSync(helper))('on-device screen-text helper', () => {
  it('reads code text back from an image', () => {
    const out = execFileSync(helper, ['--self-test'], { encoding: 'utf8' });
    expect(out).toContain('approveApplication(');
    expect(out).toContain('src/applications/approve.ts:22');
  });
});

import { describe, expect, it } from 'vitest';
import { createSession } from '../auth/sessions';
import { downgradeSubscription } from '../billing/downgrade';
import { db } from '../billing/store';
import { hasPremiumAccess } from '../entitlements/entitlements';

describe('hasPremiumAccess', () => {
  it('keeps premium access on an existing session after a downgrade, until the session expires', async () => {
    await db.updateSubscription('c1', 'premium');
    const token = await createSession('c1');
    await downgradeSubscription('c1', 'free');
    expect(await hasPremiumAccess(token)).toBe(true);
  });
});

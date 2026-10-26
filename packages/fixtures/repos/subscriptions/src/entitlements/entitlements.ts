import { db } from '../billing/store';
import { getSession } from '../auth/sessions';

/** Features a customer's plan includes, read from the subscription record. */
export async function loadEntitlements(customerId: string): Promise<string[]> {
  const sub = await db.findSubscription(customerId);
  return sub?.plan === 'premium' ? ['basic', 'premium'] : ['basic'];
}

/** Premium features check the entitlements cached on the caller's session, not the subscription record. */
export async function hasPremiumAccess(sessionToken: string): Promise<boolean> {
  const session = await getSession(sessionToken);
  return !!session && session.entitlements.includes('premium');
}

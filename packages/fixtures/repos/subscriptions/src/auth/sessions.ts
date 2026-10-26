import { loadEntitlements } from '../entitlements/entitlements';

interface Session {
  customerId: string;
  entitlements: string[];
  expiresAt: Date;
}

const sessions = new Map<string, Session>();

/** Sign-in: entitlements are loaded once and cached on the session token. */
export async function createSession(customerId: string): Promise<string> {
  const token = Math.random().toString(36).slice(2);
  const entitlements = await loadEntitlements(customerId);
  sessions.set(token, { customerId, entitlements, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  return token;
}

/**
 * Look up a session. Cached entitlements are used until the token expires (60 minutes after
 * sign-in); an expired token is refreshed, which reloads entitlements from the subscription.
 */
export async function getSession(token: string): Promise<Session | undefined> {
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt.getTime() <= Date.now()) {
    session.entitlements = await loadEntitlements(session.customerId);
    session.expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  }
  return session;
}

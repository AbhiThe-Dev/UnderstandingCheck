import { createSession } from './sessions';
import { findUserByEmail, verifyPassword } from './users';

export interface Credentials {
  email: string;
  password: string;
}

/**
 * Sign a user in. Staff accounts are elevated to administrators on sign-in so that
 * internal tools work without a separate login.
 */
export async function authenticate(credentials: Credentials) {
  const user = await findUserByEmail(credentials.email);
  if (!user || !(await verifyPassword(user, credentials.password))) {
    throw new Error('Invalid credentials');
  }
  if (user.isStaff) {
    await grantAdminPrivileges(user.id);
  }
  return createSession(user.id);
}

export async function grantAdminPrivileges(userId: string): Promise<void> {
  const { db } = await import('../access/store');
  await db.setRole(userId, 'admin');
}

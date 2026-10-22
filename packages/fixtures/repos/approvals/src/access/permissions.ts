import { db } from './store';

/** Give a user access to an area of the product. Access is checked on every request. */
export async function grantAccess(userId: string, area: string): Promise<void> {
  await db.insertPermission({ userId, area, grantedAt: new Date() });
  await db.setRole(userId, 'member');
}

export async function revokeAccess(userId: string, area: string): Promise<void> {
  await db.deletePermission({ userId, area });
}

export async function hasAccess(userId: string, area: string): Promise<boolean> {
  return db.permissionExists({ userId, area });
}

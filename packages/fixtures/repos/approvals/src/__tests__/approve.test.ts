import { describe, expect, it, vi } from 'vitest';
import * as permissions from '../access/permissions';
import { approveApplication } from '../applications/approve';
import { saveApplication } from '../applications/repository';

describe('approveApplication', () => {
  it('marks the application approved and grants portal access', async () => {
    await saveApplication({ id: 'a1', applicantId: 'u1', applicantEmail: 'u1@example.com', status: 'submitted' });
    const grant = vi.spyOn(permissions, 'grantAccess');
    const app = await approveApplication('a1', { id: 'r1', name: 'Rae', isAdmin: true });
    expect(app.status).toBe('approved');
    expect(grant).toHaveBeenCalledWith('u1', 'member-portal');
  });
});

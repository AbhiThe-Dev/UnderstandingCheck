import { describe, expect, it } from 'vitest';
import { extractCodeMentions } from '../src/screenText';

const lines = (text: string, confidence = 0.9) => text.split('\n').map((t) => ({ text: t, confidence }));

describe('reading code names from the screen', () => {
  it('picks function names and file paths out of an editor', () => {
    const m = extractCodeMentions(
      lines(`approve.ts   reject.ts   README.md
src > applications > approve.ts
11  export async function approveApplication(applicationId: string, reviewer: Reviewer): Promise<Application> {
12    const application = await findApplication(applicationId);
17    application.status = 'approved';
22    await grantPortalAccess(application.applicantId);
23    await sendApprovalEmail(application);`),
    );
    expect(m.identifiers).toEqual(expect.arrayContaining(['approveApplication', 'applicationId', 'findApplication', 'grantPortalAccess', 'applicantId', 'sendApprovalEmail']));
    expect(m.identifiers).not.toContain('const');
    expect(m.identifiers).not.toContain('application'); // a plain word
    expect(m.files).toEqual(expect.arrayContaining([{ path: 'approve.ts' }, { path: 'reject.ts' }]));
  });

  it('reads the path and line from a GitHub file page', () => {
    const m = extractCodeMentions(
      lines(`github.com/AbhiThe-Dev/approvals-demo/blob/main/src/applications/approve.ts#L22
approvals-demo / src / applications / approve.ts
see src/auth/authenticate.ts:19 and permissions.ts, line 8`),
    );
    expect(m.files).toEqual(
      expect.arrayContaining([
        { path: 'src/applications/approve.ts', line: 22 },
        { path: 'src/auth/authenticate.ts', line: 19 },
        { path: 'permissions.ts', line: 8 },
      ]),
    );
  });

  it('finds nothing in ordinary chat or email text', () => {
    const m = extractCodeMentions(
      lines(`Priya Shah 10:42 AM
Hey team, can we sync tomorrow about the release? Thanks!
Re: Quarterly planning — Sounds good, see you at 3pm.
Order #48213 shipped to john.doe@example.com`),
    );
    expect(m).toEqual({ identifiers: [], files: [] });
  });

  it('ignores low-confidence lines and random-looking tokens', () => {
    const m = extractCodeMentions([
      { text: 'approveApplication(', confidence: 0.1 },
      { text: 'token sk_live_4f9a8b7c6d5e and hash a1b2c3d4e5_f6', confidence: 0.95 },
    ]);
    expect(m).toEqual({ identifiers: [], files: [] });
  });
});

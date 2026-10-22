# Membership approvals (demo repository)

A tiny membership service used to demonstrate the Understanding Copilot.

- Reviewers approve or reject submitted applications (`src/applications/approve.ts`).
- Approving an application grants the applicant access to the member portal and emails them.
- Staff accounts are elevated to administrators when they sign in (`src/auth/authenticate.ts`).

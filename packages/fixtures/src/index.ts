import { fileURLToPath } from 'node:url';
import type { RepoName } from './cases';

export * from './cases';
export { BLIND_DIR, loadBlindCases } from './blind';
export * from './preview';

export const SAMPLE_REPOS: Record<RepoName, { name: string; description: string }> = {
  approvals: { name: 'demo/approvals', description: 'Membership approval workflow: approving grants portal access and sends an email.' },
  billing: { name: 'demo/billing', description: 'Invoices, refunds paid as store credit, receipts synced to accounting.' },
  subscriptions: { name: 'demo/subscriptions', description: 'Plans, downgrades with proration credit, and sessions that cache entitlements for 60 minutes.' },
};

export function sampleRepoPath(repo: RepoName): string {
  return fileURLToPath(new URL(`../repos/${repo}`, import.meta.url));
}

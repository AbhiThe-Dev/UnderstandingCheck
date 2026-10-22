import { fileURLToPath } from 'node:url';
import type { RepoName } from './cases';

export * from './cases';

export const SAMPLE_REPOS: Record<RepoName, { name: string; description: string }> = {
  approvals: { name: 'demo/approvals', description: 'Membership approval workflow: approving grants portal access and sends an email.' },
  billing: { name: 'demo/billing', description: 'Invoices, refunds paid as store credit, receipts synced to accounting.' },
};

export function sampleRepoPath(repo: RepoName): string {
  return fileURLToPath(new URL(`../repos/${repo}`, import.meta.url));
}

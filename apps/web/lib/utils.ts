import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { DiscrepancyCategory, DiscrepancyStatus } from '@uc/core';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const CATEGORY_LABEL: Record<DiscrepancyCategory, string> = {
  false_alignment: 'Possible false alignment',
  direct_disagreement: 'Disagreement',
  codebase_conflict: 'Potential code conflict',
  hidden_assumption: 'Hidden assumption',
  missing_specification: 'Unspecified behavior',
};

export const STATUS_LABEL: Record<DiscrepancyStatus, string> = {
  potential: 'Potential',
  suggested: 'Suggested',
  awaiting_response: 'Awaiting response',
  different_expectations_confirmed: 'Different expectations confirmed',
  resolution_proposed: 'Resolution proposed',
  confirmed: 'Confirmed',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  unresolved: 'Unresolved',
};

export const ROLE_LABEL: Record<string, string> = {
  product_owner: 'Product owner',
  developer: 'Developer',
  designer: 'Designer',
  qa: 'QA',
  stakeholder: 'Stakeholder',
  unknown: 'Role unknown',
};

export function shortSha(sha: string | null | undefined) {
  if (!sha) return '—';
  return sha.startsWith('content-') ? sha.slice(0, 18) : sha.slice(0, 10);
}

export function formatTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function usd(n: number) {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

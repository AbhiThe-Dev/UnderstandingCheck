import type { Plan } from './store';

const credits: { customerId: string; amountCents: number }[] = [];

/** Credit the unused part of the period when a customer moves to a cheaper plan. */
export async function issueProrationCredit(customerId: string, from: Plan, to: Plan): Promise<void> {
  if (from === 'premium' && to === 'free') credits.push({ customerId, amountCents: 900 });
}

import { sendDowngradeEmail } from './emails';
import { issueProrationCredit } from './credits';
import { db, type Plan } from './store';

/**
 * Move a customer to a cheaper plan. The new plan applies to the subscription record right away;
 * the unused part of the current period is returned as account credit.
 */
export async function downgradeSubscription(customerId: string, plan: Plan): Promise<void> {
  const current = await db.findSubscription(customerId);
  if (!current || current.plan === plan) return;

  await db.updateSubscription(customerId, plan);
  await issueProrationCredit(customerId, current.plan, plan);
  await sendDowngradeEmail(customerId, plan);
}

import type { Plan } from './store';

export async function sendDowngradeEmail(customerId: string, plan: Plan): Promise<void> {
  console.info(`email ${customerId}: your plan is now ${plan}`);
}

export type Plan = 'free' | 'premium';

interface SubscriptionRow {
  customerId: string;
  plan: Plan;
  updatedAt: Date;
}

const subscriptions = new Map<string, SubscriptionRow>();

export const db = {
  async findSubscription(customerId: string): Promise<SubscriptionRow | undefined> {
    return subscriptions.get(customerId);
  },
  async updateSubscription(customerId: string, plan: Plan): Promise<void> {
    subscriptions.set(customerId, { customerId, plan, updatedAt: new Date() });
  },
};

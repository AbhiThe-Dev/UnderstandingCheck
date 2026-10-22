const balances = new Map<string, number>();

export async function issueStoreCredit(customerId: string, amount: number): Promise<number> {
  const next = (balances.get(customerId) ?? 0) + amount;
  balances.set(customerId, next);
  return next;
}

export async function getCreditBalance(customerId: string): Promise<number> {
  return balances.get(customerId) ?? 0;
}

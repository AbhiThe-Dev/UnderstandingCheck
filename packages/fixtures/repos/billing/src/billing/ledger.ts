export interface LedgerEntry {
  invoiceId: string;
  amount: number;
  kind: 'payment' | 'refund' | 'adjustment';
}

const entries: LedgerEntry[] = [];

export async function recordLedgerEntry(entry: LedgerEntry): Promise<void> {
  entries.push(entry);
}

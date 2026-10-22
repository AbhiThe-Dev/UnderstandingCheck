export interface Invoice {
  id: string;
  customerId: string;
  total: number;
  status: 'open' | 'paid' | 'refunded' | 'void';
  refundedBy?: string;
  footerText?: string;
}

const invoices = new Map<string, Invoice>();

export async function findInvoice(id: string): Promise<Invoice> {
  const inv = invoices.get(id);
  if (!inv) throw new Error(`Invoice ${id} not found`);
  return { ...inv };
}

export async function saveInvoice(inv: Invoice): Promise<void> {
  invoices.set(inv.id, { ...inv });
}

export async function markInvoicePaid(id: string): Promise<Invoice> {
  const inv = await findInvoice(id);
  inv.status = 'paid';
  await saveInvoice(inv);
  return inv;
}

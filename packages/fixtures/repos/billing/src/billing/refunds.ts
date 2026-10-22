import { issueStoreCredit } from './credits';
import { findInvoice, saveInvoice } from './invoices';
import { recordLedgerEntry } from './ledger';
import { notifyCustomer } from './notify';

export interface Agent {
  id: string;
  team: 'support' | 'finance';
}

/**
 * Refund a paid invoice. Refunds are paid out as store credit so the money stays on platform.
 */
export async function refundInvoice(invoiceId: string, agent: Agent) {
  const invoice = await findInvoice(invoiceId);
  if (invoice.status !== 'paid') throw new Error('Only paid invoices can be refunded');

  invoice.status = 'refunded';
  invoice.refundedBy = agent.id;
  await saveInvoice(invoice);

  await issueStoreCredit(invoice.customerId, invoice.total);
  await recordLedgerEntry({ invoiceId, amount: -invoice.total, kind: 'refund' });
  await notifyCustomer(invoice.customerId, 'refund-issued');
  return invoice;
}

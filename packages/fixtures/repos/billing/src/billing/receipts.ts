import type { Invoice } from './invoices';
import { notifyCustomer } from './notify';

const ACCOUNTING_WEBHOOK = process.env.ACCOUNTING_WEBHOOK_URL ?? 'https://accounting.invalid/hooks/receipts';

/** Email the customer a receipt and sync it to the external accounting system. */
export async function sendReceipt(invoice: Invoice): Promise<void> {
  await notifyCustomer(invoice.customerId, 'receipt', { invoiceId: invoice.id, total: invoice.total });
  await postToAccountingWebhook(invoice);
}

export async function postToAccountingWebhook(invoice: Invoice): Promise<void> {
  await fetch(ACCOUNTING_WEBHOOK, { method: 'POST', body: JSON.stringify({ id: invoice.id, total: invoice.total }) });
}

export function renderReceiptFooter(invoice: Invoice): string {
  return invoice.footerText ?? 'Thank you for your business.';
}

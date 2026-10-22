import { describe, expect, it } from 'vitest';
import { getCreditBalance } from '../credits';
import { saveInvoice } from '../invoices';
import { refundInvoice } from '../refunds';

describe('refundInvoice', () => {
  it('issues store credit for the invoice total', async () => {
    await saveInvoice({ id: 'i1', customerId: 'c1', total: 40, status: 'paid' });
    await refundInvoice('i1', { id: 'agent', team: 'support' });
    expect(await getCreditBalance('c1')).toBe(40);
  });
});

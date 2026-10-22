export async function notifyCustomer(customerId: string, template: string, data: Record<string, unknown> = {}): Promise<void> {
  console.info('notify', customerId, template, data);
}

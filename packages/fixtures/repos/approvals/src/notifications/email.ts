import { mailer } from './mailer';

export async function sendApprovalEmail(to: string, applicationId: string): Promise<void> {
  await mailer.send({
    to,
    template: 'application-approved',
    data: { applicationId },
  });
}

export async function sendRejectionEmail(to: string, reason: string): Promise<void> {
  await mailer.send({ to, template: 'application-rejected', data: { reason } });
}

export interface MailMessage {
  to: string;
  template: string;
  data: Record<string, unknown>;
}

export const mailer = {
  sent: [] as MailMessage[],
  async send(message: MailMessage) {
    this.sent.push(message);
  },
};

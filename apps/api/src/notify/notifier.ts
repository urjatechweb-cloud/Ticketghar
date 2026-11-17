import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';

/** Sends a plain-text message to a customer or operator phone (WhatsApp ID). */
export interface Notifier {
  sendText(to: string, body: string): Promise<void>;
}
export const NOTIFIER = Symbol('NOTIFIER');

/**
 * WhatsApp Cloud API sender. Free-form text only reaches people who messaged
 * within the last 24 hours; anything else must use an approved template
 * (sendTemplate). Without credentials it logs instead of sending.
 */
@Injectable()
export class WhatsAppClient implements Notifier {
  private readonly log = new Logger('WhatsApp');
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private get ready() {
    return Boolean(this.config.whatsapp.accessToken && this.config.whatsapp.phoneNumberId);
  }

  private async send(payload: Record<string, unknown>) {
    if (!this.ready) {
      this.log.log(`[dry-run] ${JSON.stringify(payload)}`);
      return;
    }
    const { graphUrl, phoneNumberId, accessToken } = this.config.whatsapp;
    const res = await fetch(`${graphUrl}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    if (!res.ok) this.log.error(`send failed ${res.status}: ${await res.text()}`);
  }

  async sendText(to: string, body: string) {
    await this.send({ to, type: 'text', text: { body, preview_url: true } });
  }

  async sendTemplate(to: string, name: string, language: string, params: string[]) {
    await this.send({
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
      },
    });
  }
}

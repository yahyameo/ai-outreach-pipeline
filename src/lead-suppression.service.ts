import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { isOutreachEmail } from './email-filter';
import { Lead, LeadDocument } from './schemas/lead.schema';

export interface SendGridEvent {
  event?: string;
  email?: string;
  /** For `bounce` events: "bounce" or "blocked". */
  type?: string;
  reason?: string;
}

/**
 * Applies opt-outs and provider outcomes to leads.
 *
 * An unsubscribe is stored even for an address that is not a lead yet, as a
 * suppressed stub: a later Apify import of that address only $sets profile
 * fields, so the opt-out survives and the address is never selected.
 */
@Injectable()
export class LeadSuppressionService {
  private readonly logger = new Logger(LeadSuppressionService.name);

  constructor(@InjectModel(Lead.name) private readonly leads: Model<LeadDocument>) {}

  async unsubscribe(email: string, source: string) {
    const normalizedEmail = email?.trim().toLowerCase() ?? '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error('A valid email is required.');
    }
    const result = await this.leads.updateOne(
      { normalizedEmail },
      {
        $set: { unsubscribed: true, unsubscribedAt: new Date(), unsubscribeSource: source },
        $setOnInsert: {
          email: normalizedEmail,
          normalizedEmail,
          companyName: 'Unknown',
          source: { provider: 'suppression' },
          verification: { status: 'pending', provider: 'mails.so' },
          delivery: { status: 'not_queued', attempts: 0 },
        },
      },
      { upsert: true },
    );
    return { email: normalizedEmail, unsubscribed: true, existingLead: result.upsertedCount === 0 };
  }

  async applySendGridEvents(events: SendGridEvent[]) {
    let applied = 0;
    for (const item of events) {
      const email = item.email?.trim().toLowerCase() ?? '';
      if (!email || !isOutreachEmail(email)) continue;
      switch (item.event) {
        case 'unsubscribe':
        case 'group_unsubscribe':
        case 'spamreport':
          await this.unsubscribe(email, `sendgrid:${item.event}`);
          applied += 1;
          break;
        case 'bounce':
          applied += await this.setDelivery(email, item.type === 'blocked' ? 'blocked' : 'bounced', item.reason);
          break;
        case 'dropped':
          applied += await this.setDelivery(email, 'blocked', item.reason);
          break;
        case 'delivered':
          applied += await this.setDelivery(email, 'delivered');
          break;
        default:
          // processed, deferred, open, click, …: not lead state.
          break;
      }
    }
    this.logger.log(`Applied ${applied} of ${events.length} SendGrid event(s).`);
    return { received: events.length, applied };
  }

  private async setDelivery(email: string, status: 'delivered' | 'bounced' | 'blocked', reason?: string) {
    // Only an email we actually handed to SendGrid can move; a late
    // `delivered` must not overwrite an earlier bounce.
    const from = status === 'delivered' ? ['sent'] : ['sent', 'delivered'];
    const result = await this.leads.updateOne(
      { normalizedEmail: email, 'delivery.status': { $in: from } },
      { $set: { 'delivery.status': status, ...(reason ? { 'delivery.lastError': reason } : {}) } },
    );
    return result.modifiedCount;
  }
}

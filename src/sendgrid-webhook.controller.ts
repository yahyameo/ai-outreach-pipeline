import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { createPublicKey, verify } from 'node:crypto';

import { LeadSuppressionService, SendGridEvent } from './lead-suppression.service';

const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

/**
 * Verifies a SendGrid Signed Event Webhook request: an ECDSA signature over
 * timestamp + raw body, checked against the public key shown in SendGrid's
 * Mail Settings → Event Webhook → Signature Verification.
 */
export function isValidSendGridSignature(
  publicKeyBase64: string,
  rawBody: Buffer,
  signature: string,
  timestamp: string,
): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    return verify('sha256', Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Not behind the API key: SendGrid authenticates with its signature instead. */
@Controller('webhooks')
export class SendGridWebhookController {
  constructor(private readonly suppression: LeadSuppressionService) {}

  @Post('sendgrid')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: { rawBody?: Buffer; body: unknown; header(name: string): string | undefined },
  ) {
    const publicKey = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY?.trim();
    // Fail closed: an unverified endpoint would let anyone mark leads as
    // bounced or unsubscribed.
    if (!publicKey) throw new ForbiddenException('SendGrid webhook verification is not configured.');
    const signature = request.header(SIGNATURE_HEADER) ?? '';
    const timestamp = request.header(TIMESTAMP_HEADER) ?? '';
    if (!request.rawBody || !isValidSendGridSignature(publicKey, request.rawBody, signature, timestamp)) {
      throw new ForbiddenException('Invalid SendGrid webhook signature.');
    }
    if (!Array.isArray(request.body)) throw new BadRequestException('Expected an array of events.');
    return this.suppression.applySendGridEvents(request.body as SendGridEvent[]);
  }
}

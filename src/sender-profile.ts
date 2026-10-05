import { OutreachLocale } from './outreach.constants';

/**
 * Who the outreach is from. Read from the environment so the same code can
 * send for any company; nothing about the sender is hardcoded.
 *
 * The postal address and reply-to are required: CAN-SPAM and most EU/UK rules
 * expect a physical address, and the opt-out instruction tells recipients to
 * reply, so replies must reach a monitored inbox.
 */
export interface SenderProfile {
  name: string;
  /** Job title, already resolved for the requested locale. */
  title: string;
  company: string;
  /** One-line description used in the AI prompt, e.g. "an AI solutions company serving SMEs". */
  description: string;
  replyTo: string;
  website?: string;
  bookingUrl?: string;
  addressLines: string[];
}

export function senderProfile(locale?: OutreachLocale): SenderProfile {
  const read = (name: string) => process.env[name]?.trim() ?? '';
  const profile = {
    name: read('OUTREACH_SENDER_NAME'),
    title: (locale && read(localeTitleVariable(locale))) || read('OUTREACH_SENDER_TITLE'),
    company: read('OUTREACH_COMPANY_NAME'),
    description: read('OUTREACH_COMPANY_DESCRIPTION'),
    replyTo: read('OUTREACH_REPLY_TO'),
    website: read('OUTREACH_COMPANY_WEBSITE') || undefined,
    bookingUrl: read('OUTREACH_BOOKING_URL') || undefined,
    // "|" separates lines so the address fits on one .env line.
    addressLines: read('OUTREACH_COMPANY_ADDRESS')
      .split('|')
      .map((line) => line.trim())
      .filter(Boolean),
  };
  const missing = [
    ['OUTREACH_SENDER_NAME', profile.name],
    ['OUTREACH_COMPANY_NAME', profile.company],
    ['OUTREACH_REPLY_TO', profile.replyTo],
    ['OUTREACH_COMPANY_ADDRESS', profile.addressLines.length ? 'set' : ''],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Missing sender configuration: ${missing.join(', ')}`);
  }
  return profile;
}

/** e.g. es-MX → OUTREACH_SENDER_TITLE_ES_MX, for a translated job title. */
export function localeTitleVariable(locale: OutreachLocale) {
  return `OUTREACH_SENDER_TITLE_${locale.replace('-', '_').toUpperCase()}`;
}

/** Single source for the values the API, schemas, and prompts must agree on. */
export const OUTREACH_TYPES = [
  'general_ai',
  'conversational_agent',
  'engineering_partner',
  'restaurant_digital',
  'sme_digital',
] as const;

export const OUTREACH_LOCALES = [
  'en-SG', 'en-MY', 'en-AU', 'en-TH', 'en-US', 'en-GB', 'en-CA', 'en-PH',
  'en-ID', 'en-VN', 'en-AE', 'en-SA', 'en-EG',
  'es-MX', 'vi-VN', 'th-TH', 'fr-FR', 'de-DE',
] as const;

export type OutreachType = (typeof OUTREACH_TYPES)[number];
export type OutreachLocale = (typeof OUTREACH_LOCALES)[number];

export function isOutreachType(value: string): value is OutreachType {
  return (OUTREACH_TYPES as readonly string[]).includes(value);
}

export function isOutreachLocale(value: string): value is OutreachLocale {
  return (OUTREACH_LOCALES as readonly string[]).includes(value);
}

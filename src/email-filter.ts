import * as cheerio from 'cheerio';

const EMAIL_PATTERN =
  /[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;

const PLACEHOLDER_LOCAL_PARTS = new Set([
  'example',
  'user',
  'test',
  'testing',
  'sample',
  'demo',
]);

const PLACEHOLDER_DOMAINS = new Set(['example.com', 'domain.com']);

/**
 * Conservative validator for addresses used in cold outreach. It deliberately
 * rejects uncommon-but-RFC-valid local parts containing percent/quotes so
 * malformed HTML fragments can never become leads.
 */
export function isOutreachEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return false;
  if (email.includes('%') || email.includes("'") || email.includes('"')) {
    return false;
  }
  if (!/^[a-z0-9][a-z0-9._+-]*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(email)) {
    return false;
  }

  const [local, domain] = email.split('@');
  if (!local || !domain || local.length > 64) return false;
  if (local.endsWith('.') || local.includes('..')) return false;
  if (PLACEHOLDER_LOCAL_PARTS.has(local)) return false;
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  return true;
}

/** Extract only explicit mailto links and visible text—not arbitrary HTML. */
export function extractPublicEmails(html: string): string[] {
  const $ = cheerio.load(html);
  const candidates = new Set<string>();

  $('a[href^="mailto:" i]').each((_, element) => {
    const raw = ($(element).attr('href') ?? '').slice('mailto:'.length);
    // Encoded prefixes such as `%20info@…` are ambiguous/malformed. Skip the
    // source instead of silently repairing it into a potentially wrong lead.
    if (raw.includes('%')) return;
    const email = raw.split('?')[0].trim().toLowerCase();
    if (isOutreachEmail(email)) candidates.add(email);
  });

  const visibleText = $.root().text();
  for (const match of visibleText.matchAll(EMAIL_PATTERN)) {
    const email = match[0].toLowerCase().replace(/[),.;:]+$/, '');
    const prefix = visibleText.slice(Math.max(0, (match.index ?? 0) - 10), match.index);
    if (/value\s*=\s*['"]?$/i.test(prefix)) continue;
    if (isOutreachEmail(email)) candidates.add(email);
  }

  return [...candidates];
}

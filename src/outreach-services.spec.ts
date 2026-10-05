import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAiOutreachService } from './openai-outreach.service';
import { LeadOutreachService } from './lead-outreach.service';
import { LeadReadService } from './lead-read.service';
import { EmailLogReadService } from './email-log-read.service';
import { WebsiteResearchService } from './website-research.service';

// A fictional sender: the footer and links are built from this profile.
Object.assign(process.env, {
  OUTREACH_SENDER_NAME: 'Jane Doe',
  OUTREACH_SENDER_TITLE: 'Sales Consultant',
  OUTREACH_SENDER_TITLE_ES_MX: 'Consultor de Ventas',
  OUTREACH_SENDER_TITLE_VI_VN: 'Tư vấn Kinh doanh',
  OUTREACH_SENDER_TITLE_TH_TH: 'ที่ปรึกษาฝ่ายขาย',
  OUTREACH_SENDER_TITLE_FR_FR: 'Consultant commercial',
  OUTREACH_COMPANY_NAME: 'Example Co',
  OUTREACH_COMPANY_DESCRIPTION: 'a software consultancy',
  OUTREACH_REPLY_TO: 'jane@example.org',
  OUTREACH_COMPANY_WEBSITE: 'https://example.org',
  OUTREACH_BOOKING_URL: 'https://cal.example.org/jane',
  OUTREACH_COMPANY_ADDRESS: '1 Example Street|Singapore 000000',
});

test('website research rejects local and private targets before fetching', async () => {
  const service = new WebsiteResearchService();
  await assert.rejects(() => service.research('http://localhost:3000'), /public HTTP/);
  await assert.rejects(() => service.research('http://127.0.0.1'), /public HTTP/);
  await assert.rejects(() => service.research('http://192.168.1.1'), /public HTTP/);
});

test('lead listing rejects unsafe page sizes before querying MongoDB', async () => {
  const service = new LeadReadService(undefined as never);
  await assert.rejects(() => service.list({ limit: '201' }), /between 1 and 200/);
});

test('email log listing rejects unsafe page sizes before querying MongoDB', async () => {
  const service = new EmailLogReadService(undefined as never);
  await assert.rejects(() => service.list({ limit: '201' }), /between 1 and 200/);
});

test('safe outreach test delivery validates its controlled recipient first', async () => {
  const service = new LeadOutreachService(undefined as never, undefined as never, undefined as never, undefined as never);
  await assert.rejects(
    () => service.sendTest('6a6b1250fa27d0764c472e50', { to: 'not-an-email' }),
    /valid test recipient email/,
  );
});

test('outreach HTML renders the booking URL as a safe clickable link', () => {
  const service = new LeadOutreachService(undefined as never, undefined as never, undefined as never, undefined as never);
  const html = (service as unknown as { bodyHtml(body: string): string }).bodyHtml(
    'Book here:\nhttps://cal.example.org/jane',
  );
  assert.match(html, /href="https:\/\/cal\.example\.org\/jane"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('generated outreach receives the fixed sender, address, and unsubscribe footer', () => {
  const service = new OpenAiOutreachService();
  const body = (service as unknown as { withContactSignature(body: string): string })
    .withContactSignature('A tailored message.');
  assert.match(body, /Jane Doe/);
  assert.match(body, /https:\/\/example\.org/);
  assert.match(body, /1 Example Street/);
  assert.match(body, /Singapore 000000/);
  assert.match(body, /Reply “unsubscribe”/);
});

test('Mexican Spanish outreach receives a localized fixed footer', () => {
  const service = new OpenAiOutreachService();
  const body = (service as unknown as { withContactSignature(body: string, locale: 'es-MX'): string })
    .withContactSignature('Un mensaje personalizado.', 'es-MX');
  assert.match(body, /¿Estaría abierto a una breve reunión/);
  assert.match(body, /Consultor de Ventas/);
  assert.match(body, /cancelar suscripción/);
  assert.match(body, /1 Example Street/);
});

test('Mexican Spanish outreach HTML localizes link labels', () => {
  const service = new LeadOutreachService(undefined as never, undefined as never, undefined as never, undefined as never);
  const html = (service as unknown as { bodyHtml(body: string, locale: 'es-MX'): string }).bodyHtml(
    'Reunión:\nhttps://cal.example.org/jane\n\nSitio:\nhttps://example.org',
    'es-MX',
  );
  assert.match(html, />Reservar una reunión por Google Meet<\/a>/);
  assert.match(html, />Visitar Example Co<\/a>/);
});

test('Vietnamese partner outreach receives a localized fixed footer', () => {
  const service = new OpenAiOutreachService();
  const body = (service as unknown as { withContactSignature(body: string, locale: 'vi-VN'): string })
    .withContactSignature('Nội dung hợp tác được cá nhân hóa.', 'vi-VN');
  assert.match(body, /Tư vấn Kinh doanh/);
  assert.match(body, /hủy đăng ký/);
  assert.match(body, /Quý công ty có thể chọn thời gian phù hợp/);
});

test('Vietnamese outreach HTML localizes link labels', () => {
  const service = new LeadOutreachService(undefined as never, undefined as never, undefined as never, undefined as never);
  const html = (service as unknown as { bodyHtml(body: string, locale: 'vi-VN'): string }).bodyHtml(
    'Lịch:\nhttps://cal.example.org/jane\n\nTrang web:\nhttps://example.org',
    'vi-VN',
  );
  assert.match(html, />Đặt lịch Google Meet<\/a>/);
  assert.match(html, />Truy cập Example Co<\/a>/);
});

test('Thailand English locale retains the English outreach footer', () => {
  const service = new OpenAiOutreachService();
  const body = (service as unknown as { withContactSignature(body: string, locale: 'en-TH'): string })
    .withContactSignature('A tailored partnership message.', 'en-TH');
  assert.match(body, /Would you be open to a quick Google Meet/);
  assert.match(body, /Sales Consultant/);
  assert.match(body, /Reply “unsubscribe”/);
  assert.doesNotMatch(body, /ยกเลิกการรับข่าวสาร/);
});

test('USA, UK, and Canada locales retain the English outreach footer', () => {
  const service = new OpenAiOutreachService();
  for (const locale of ['en-US', 'en-GB', 'en-CA'] as const) {
    const body = (service as unknown as { withContactSignature(body: string, locale: 'en-US' | 'en-GB' | 'en-CA'): string })
      .withContactSignature('A tailored partnership message.', locale);
    assert.match(body, /Would you be open to a quick Google Meet/);
    assert.match(body, /Jane Doe/);
    assert.match(body, /Reply “unsubscribe”/);
  }
});

test('SEA and MENA pilot locales retain the English outreach footer', () => {
  const service = new OpenAiOutreachService();
  type PilotLocale = 'en-PH' | 'en-ID' | 'en-VN' | 'en-AE' | 'en-SA' | 'en-EG';
  for (const locale of ['en-PH', 'en-ID', 'en-VN', 'en-AE', 'en-SA', 'en-EG'] as const) {
    const body = (service as unknown as { withContactSignature(body: string, locale: PilotLocale): string })
      .withContactSignature('A tailored restaurant operations message.', locale);
    assert.match(body, /Would you be open to a quick Google Meet/);
    assert.match(body, /Sales Consultant/);
    assert.match(body, /Reply “unsubscribe”/);
  }
});

test('Thai partner outreach receives a localized fixed footer', () => {
  const service = new OpenAiOutreachService();
  const body = (service as unknown as { withContactSignature(body: string, locale: 'th-TH'): string })
    .withContactSignature('ข้อความความร่วมมือที่ปรับให้เหมาะกับบริษัท', 'th-TH');
  assert.match(body, /ที่ปรึกษาฝ่ายขาย/);
  assert.match(body, /ยกเลิกการรับข่าวสาร/);
  assert.match(body, /Google Meet/);
});

test('Thai outreach HTML localizes link labels', () => {
  const service = new LeadOutreachService(undefined as never, undefined as never, undefined as never, undefined as never);
  const html = (service as unknown as { bodyHtml(body: string, locale: 'th-TH'): string }).bodyHtml(
    'นัดหมาย:\nhttps://cal.example.org/jane\n\nเว็บไซต์:\nhttps://example.org',
    'th-TH',
  );
  assert.match(html, />จองเวลา Google Meet<\/a>/);
  assert.match(html, />เยี่ยมชม Example Co<\/a>/);
});

test('French outreach includes localized transparency and opt-out wording', () => {
  const service = new OpenAiOutreachService();
  const body = (service as unknown as { withContactSignature(body: string, locale: 'fr-FR'): string })
    .withContactSignature('Un message personnalisé.', 'fr-FR');
  assert.match(body, /Consultant commercial/);
  assert.match(body, /site public de votre entreprise/);
  assert.match(body, /désinscription/);
});

test('French and German outreach HTML localizes link labels', () => {
  const service = new LeadOutreachService(undefined as never, undefined as never, undefined as never, undefined as never);
  const french = (service as unknown as { bodyHtml(body: string, locale: 'fr-FR'): string }).bodyHtml(
    'Rendez-vous :\nhttps://cal.example.org/jane\n\nSite :\nhttps://example.org',
    'fr-FR',
  );
  assert.match(french, />Planifier un échange sur Google Meet<\/a>/);
  assert.match(french, />Découvrir Example Co<\/a>/);
  const german = (service as unknown as { bodyHtml(body: string, locale: 'de-DE'): string }).bodyHtml(
    'Termin:\nhttps://cal.example.org/jane\n\nWebsite:\nhttps://example.org',
    'de-DE',
  );
  assert.match(german, />Google-Meet-Termin vereinbaren<\/a>/);
  assert.match(german, />Example Co besuchen<\/a>/);
});

test('outreach HTML renders the Example Co website as a safe clickable link', () => {
  const service = new LeadOutreachService(undefined as never, undefined as never, undefined as never, undefined as never);
  const html = (service as unknown as { bodyHtml(body: string): string }).bodyHtml(
    'Website:\nhttps://example.org',
  );
  assert.match(html, /href="https:\/\/example\.org"/);
  assert.match(html, />Visit Example Co<\/a>/);
});

test('production subjects receive one ADV prefix', () => {
  const service = new LeadOutreachService(undefined as never, undefined as never, undefined as never, undefined as never);
  const subject = (service as unknown as { advertisingSubject(subject: string): string })
    .advertisingSubject('<ADV> A useful idea');
  assert.equal(subject, '<ADV> A useful idea');
});

test('outreach allows valid and unknown verification statuses only', () => {
  const service = new LeadOutreachService(undefined as never, undefined as never, undefined as never, undefined as never);
  const statuses = (service as unknown as { allowedVerificationStatuses(): string[] })
    .allowedVerificationStatuses();
  assert.deepEqual(statuses, ['valid', 'unknown']);
  assert.equal(statuses.includes('risky'), false);
  assert.equal(statuses.includes('invalid'), false);
});

test('OpenAI generation requires an API key before making a request', async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const service = new OpenAiOutreachService();
    await assert.rejects(
      () => service.generate({ companyName: 'Example SME' }, []),
      /OPENAI_API_KEY is required/,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

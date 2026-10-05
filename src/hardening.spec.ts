import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import axios from 'axios';

import { ApiKeyGuard } from './api-key.guard';
import { CampaignService } from './campaign.service';
import { EmailVerificationService } from './email-verification.service';
import { LeadSuppressionService } from './lead-suppression.service';
import { isPrivateHostname, isPublicAddress } from './network-guard';
import { OpenAiOutreachService } from './openai-outreach.service';
import { senderProfile } from './sender-profile';
import { isValidSendGridSignature } from './sendgrid-webhook.controller';
import { WebsiteResearchService } from './website-research.service';

const SENDER = {
  OUTREACH_SENDER_NAME: 'Jane Doe',
  OUTREACH_SENDER_TITLE: 'Sales Consultant',
  OUTREACH_COMPANY_NAME: 'Example Co',
  OUTREACH_REPLY_TO: 'jane@example.org',
  OUTREACH_COMPANY_ADDRESS: '1 Example Street|Singapore 000000',
};

function withEnv(values: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  return Promise.resolve(run()).finally(() => apply(previous));
}

// ── Sender profile ────────────────────────────────────────────────────────────

test('sending without a configured sender fails instead of using a default identity', () =>
  withEnv({ ...SENDER, OUTREACH_SENDER_NAME: undefined, OUTREACH_COMPANY_ADDRESS: undefined }, () => {
    assert.throws(() => senderProfile(), /OUTREACH_SENDER_NAME, OUTREACH_COMPANY_ADDRESS/);
  }));

test('a locale-specific title overrides the default one', () =>
  withEnv({ ...SENDER, OUTREACH_SENDER_TITLE_DE_DE: 'Vertriebsberater' }, () => {
    assert.equal(senderProfile('de-DE').title, 'Vertriebsberater');
    assert.equal(senderProfile('en-GB').title, 'Sales Consultant');
  }));

test('without a booking URL the footer asks for a call but links nothing', () =>
  withEnv({ ...SENDER, OUTREACH_BOOKING_URL: undefined, OUTREACH_COMPANY_WEBSITE: undefined }, () => {
    const body = (new OpenAiOutreachService() as unknown as { withContactSignature(body: string): string })
      .withContactSignature('A tailored message.');
    assert.match(body, /Would you be open to a quick Google Meet to discuss this\?\n\nBest,/);
    assert.doesNotMatch(body, /book a suitable time/);
    assert.match(body, /Example Co\n1 Example Street\nSingapore 000000/);
  }));

test('OpenAI generation requires a model name rather than guessing one', () =>
  withEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_OUTREACH_MODEL: undefined }, async () => {
    await assert.rejects(
      () => new OpenAiOutreachService().generate({ companyName: 'Example SME' }, []),
      /OPENAI_OUTREACH_MODEL is required/,
    );
  }));

// ── Network guard ─────────────────────────────────────────────────────────────

test('non-public addresses are rejected, including mapped and NAT ranges', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1',
    '::ffff:169.254.169.254', 'not-an-ip',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('private hostnames are rejected before any request', async () => {
  for (const host of ['localhost', 'printer.local', '[::1]', '[::ffff:127.0.0.1]', '0.0.0.0', 'metadata.google.internal']) {
    assert.equal(isPrivateHostname(host), true, host);
  }
  assert.equal(isPrivateHostname('example.org'), false);
  const research = new WebsiteResearchService();
  for (const url of ['http://169.254.169.254/latest/meta-data', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0:3000']) {
    await assert.rejects(() => research.research(url), /public HTTP/, url);
  }
});

// ── API key ───────────────────────────────────────────────────────────────────

test('the API key guard accepts only the exact key', () =>
  withEnv({ OUTREACH_API_KEY: 'correct-key' }, () => {
    const guard = new ApiKeyGuard();
    const context = (key?: string) => ({
      switchToHttp: () => ({ getRequest: () => ({ header: () => key }) }),
    }) as never;
    assert.equal(guard.canActivate(context('correct-key')), true);
    for (const key of ['wrong-key', 'correct-ke', 'correct-key ', undefined]) {
      assert.throws(() => guard.canActivate(context(key)), /Invalid API key/);
    }
  }));

// ── Verification outage ───────────────────────────────────────────────────────

test('a Mails.so outage marks leads failed, which is never sendable', () =>
  withEnv({ MAILS_API_KEY: 'test' }, async () => {
    const updates: Array<Record<string, unknown>> = [];
    let served = false;
    const leads = {
      find: () => ({
        sort: () => ({ limit: () => ({ select: () => ({
          lean: async () => (served ? [] : ((served = true), [{ normalizedEmail: 'info@shop.org' }])),
        }) }) }),
      }),
      updateMany: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
        updates.push(update.$set);
      },
    };
    const originalPost = axios.post;
    axios.post = (async () => { throw new Error('ECONNRESET'); }) as typeof axios.post;
    try {
      await new EmailVerificationService(leads as never).verifyPending(['info@shop.org']);
    } finally {
      axios.post = originalPost;
    }
    assert.equal(updates[0]['verification.status'], 'failed');
  }));

// ── Unsubscribes and SendGrid events ──────────────────────────────────────────

function recordingLeads() {
  const calls: Array<{ filter: Record<string, unknown>; update: Record<string, any>; options?: unknown }> = [];
  return {
    calls,
    model: {
      updateOne: async (filter: Record<string, unknown>, update: Record<string, any>, options?: unknown) => {
        calls.push({ filter, update, options });
        return { upsertedCount: 0, modifiedCount: 1 };
      },
    },
  };
}

test('an unsubscribe is stored even when the address is not a lead yet', async () => {
  const { calls, model } = recordingLeads();
  await new LeadSuppressionService(model as never).unsubscribe(' Info@Shop.org ', 'api');
  assert.deepEqual(calls[0].filter, { normalizedEmail: 'info@shop.org' });
  assert.equal(calls[0].update.$set.unsubscribed, true);
  assert.equal(calls[0].update.$set.unsubscribeSource, 'api');
  assert.deepEqual(calls[0].options, { upsert: true });
});

test('SendGrid events update opt-outs and delivery outcomes', async () => {
  const { calls, model } = recordingLeads();
  const result = await new LeadSuppressionService(model as never).applySendGridEvents([
    { event: 'spamreport', email: 'a@shop.org' },
    { event: 'group_unsubscribe', email: 'b@shop.org' },
    { event: 'bounce', type: 'blocked', email: 'c@shop.org', reason: '550 blocked' },
    { event: 'bounce', type: 'bounce', email: 'd@shop.org' },
    { event: 'delivered', email: 'e@shop.org' },
    { event: 'open', email: 'f@shop.org' },
  ]);
  assert.equal(result.applied, 5);
  assert.equal(calls[0].update.$set.unsubscribeSource, 'sendgrid:spamreport');
  assert.equal(calls[1].update.$set.unsubscribeSource, 'sendgrid:group_unsubscribe');
  assert.equal(calls[2].update.$set['delivery.status'], 'blocked');
  assert.equal(calls[3].update.$set['delivery.status'], 'bounced');
  assert.deepEqual(calls[4].filter['delivery.status'], { $in: ['sent'] });
});

test('only correctly signed SendGrid webhook payloads are accepted', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const body = Buffer.from('[{"event":"unsubscribe","email":"a@shop.org"}]');
  const timestamp = '1760000000';
  const signature = sign('sha256', Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('base64');

  assert.equal(isValidSendGridSignature(publicKeyBase64, body, signature, timestamp), true);
  assert.equal(isValidSendGridSignature(publicKeyBase64, Buffer.from('[]'), signature, timestamp), false);
  assert.equal(isValidSendGridSignature(publicKeyBase64, body, signature, '1760000001'), false);
  assert.equal(isValidSendGridSignature(publicKeyBase64, body, 'not-a-signature', timestamp), false);
});

// ── Restart recovery ──────────────────────────────────────────────────────────

test('restart releases unsent leads but never re-queues a possibly sent one', async () => {
  const leadUpdates: Array<{ filter: any; update: any }> = [];
  const record = (target: Array<{ filter: any; update: any }>) => ({
    updateMany: async (filter: any, update: any) => {
      target.push({ filter, update });
      return { modifiedCount: 1 };
    },
  });
  const other: Array<{ filter: any; update: any }> = [];
  const service = new CampaignService(record(leadUpdates) as never, record(other) as never, record(other) as never);
  await service.recoverInterrupted();

  const queued = leadUpdates.find(({ filter }) => filter['delivery.status'] === 'queued')!;
  const sending = leadUpdates.find(({ filter }) => filter['delivery.status'] === 'sending')!;
  assert.equal(queued.update.$set['delivery.status'], 'not_queued');
  assert.equal(sending.update.$set['delivery.status'], 'failed');
});

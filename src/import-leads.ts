import 'reflect-metadata';
import 'dotenv/config';

import { getModelToken } from '@nestjs/mongoose';
import { NestFactory } from '@nestjs/core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Model } from 'mongoose';

import { ApiModule } from './api.module';
import { isOutreachEmail } from './email-filter';
import { EmailVerificationService } from './email-verification.service';
import { Lead, LeadDocument } from './schemas/lead.schema';

interface ImportedLead {
  email?: unknown;
  companyName?: unknown;
  personName?: unknown;
  category?: unknown;
  phone?: unknown;
  address?: unknown;
  country?: unknown;
  website?: unknown;
  emailSource?: unknown;
  googleMapsUrl?: unknown;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error('Usage: npm run import:leads -- <leads.json>');
  }
  const rows = JSON.parse(await readFile(resolve(input), 'utf8')) as unknown;
  if (!Array.isArray(rows)) throw new Error('Lead file must contain a JSON array.');

  const unique = new Map<string, ImportedLead>();
  for (const candidate of rows) {
    if (!isRecord(candidate)) continue;
    const row = candidate as ImportedLead;
    const email = text(row.email).toLowerCase();
    if (!isOutreachEmail(email)) continue;
    if (!unique.has(email)) unique.set(email, row);
  }
  if (unique.size === 0) throw new Error('No valid email addresses were found.');

  const app = await NestFactory.createApplicationContext(ApiModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const leads = app.get<Model<LeadDocument>>(getModelToken(Lead.name));
    const operations = [...unique].map(([normalizedEmail, row]) => ({
      updateOne: {
        filter: { normalizedEmail },
        update: {
          $set: {
            email: normalizedEmail,
            companyName: text(row.companyName) || 'Business',
            personName: text(row.personName),
            category: text(row.category),
            phone: text(row.phone),
            address: text(row.address),
            country: text(row.country),
            source: {
              provider: 'apify',
              website: text(row.website) || text(row.emailSource),
              googleMapsUrl: text(row.googleMapsUrl),
            },
          },
          $setOnInsert: {
            normalizedEmail,
            verification: { status: 'pending', provider: 'mails.so' },
            delivery: { status: 'not_queued', attempts: 0 },
            unsubscribed: false,
          },
        },
        upsert: true,
      },
    }));
    const write = await leads.bulkWrite(operations);
    const emails = [...unique.keys()];

    await app.get(EmailVerificationService).verifyPending(emails);

    const statuses = await leads.aggregate<{ _id: string; count: number }>([
      { $match: { normalizedEmail: { $in: emails } } },
      { $group: { _id: '$verification.status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    console.log(
      JSON.stringify(
        {
          fileRows: rows.length,
          uniqueValidEmails: emails.length,
          inserted: write.upsertedCount,
          updated: write.modifiedCount,
          verification: Object.fromEntries(
            statuses.map(({ _id, count }) => [_id, count]),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import 'reflect-metadata';
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AppModule } from './app.module';
import { EmailCampaignService } from './email-campaign.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const spreadsheetArg = args.find((arg) => !arg.startsWith('--'));

  if (!spreadsheetArg) {
    throw new Error(
      'Usage: npm run mail -- <recipients.xlsx|recipients.csv> [--send]',
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const service = app.get(EmailCampaignService);
    const results = await service.run({
      spreadsheetPath: resolve(spreadsheetArg),
      send,
    });

    const reportPath = resolve(`email-results-${Date.now()}.json`);
    await writeFile(reportPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

    const failed = results.filter((result) => result.status === 'failed').length;
    console.log(`Finished. Report: ${reportPath}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Campaign failed: ${message}`);
  process.exitCode = 1;
});

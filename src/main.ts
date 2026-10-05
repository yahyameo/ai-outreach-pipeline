import 'reflect-metadata';
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';

import { ApiModule } from './api.module';
import { CampaignService } from './campaign.service';

async function bootstrap() {
  // rawBody: the SendGrid webhook signature covers the exact bytes received.
  const app = await NestFactory.create(ApiModule, { rawBody: true });
  app.enableShutdownHooks();
  // Server only, not the CLIs that share ApiModule: a CLI starting up must
  // not touch work an already-running server is doing.
  await app.get(CampaignService).recoverInterrupted();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(Number.isInteger(port) && port > 0 ? port : 3000);
}

void bootstrap();

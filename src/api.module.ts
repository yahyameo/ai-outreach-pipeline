import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ApiKeyGuard } from './api-key.guard';
import { ApifyScraperService } from './apify-scraper.service';
import { CampaignService } from './campaign.service';
import { EmailVerificationService } from './email-verification.service';
import { EmailLogReadService } from './email-log-read.service';
import { LeadImportService } from './lead-import.service';
import { LeadOutreachService } from './lead-outreach.service';
import { LeadReadService } from './lead-read.service';
import { OpenAiOutreachService } from './openai-outreach.service';
import { WebsiteResearchService } from './website-research.service';
import { LeadSuppressionService } from './lead-suppression.service';
import { OutreachController } from './outreach.controller';
import { SendGridWebhookController } from './sendgrid-webhook.controller';
import {
  Campaign,
  CampaignSchema,
} from './schemas/campaign.schema';
import {
  ImportJob,
  ImportJobSchema,
} from './schemas/import-job.schema';
import { Lead, LeadSchema } from './schemas/lead.schema';
import { EmailLog, EmailLogSchema } from './schemas/email-log.schema';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => {
        const uri = process.env.MONGODB_URI?.trim();
        if (!uri) throw new Error('MONGODB_URI is required.');
        return { uri };
      },
    }),
    MongooseModule.forFeature([
      { name: Lead.name, schema: LeadSchema },
      { name: ImportJob.name, schema: ImportJobSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: EmailLog.name, schema: EmailLogSchema },
    ]),
  ],
  controllers: [OutreachController, SendGridWebhookController],
  providers: [
    ApiKeyGuard,
    ApifyScraperService,
    EmailVerificationService,
    LeadImportService,
    CampaignService,
    WebsiteResearchService,
    OpenAiOutreachService,
    LeadOutreachService,
    LeadReadService,
    EmailLogReadService,
    LeadSuppressionService,
  ],
})
export class ApiModule {}

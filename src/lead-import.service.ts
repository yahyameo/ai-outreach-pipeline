import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { isValidObjectId } from 'mongoose';

import { ApifyScraperService } from './apify-scraper.service';
import { isOutreachEmail } from './email-filter';
import { EmailVerificationService } from './email-verification.service';
import { ApifyImportRequest } from './outreach.types';
import {
  ImportJob,
  ImportJobDocument,
} from './schemas/import-job.schema';
import { Lead, LeadDocument } from './schemas/lead.schema';

@Injectable()
export class LeadImportService {
  private readonly logger = new Logger(LeadImportService.name);

  constructor(
    @InjectModel(Lead.name) private readonly leads: Model<LeadDocument>,
    @InjectModel(ImportJob.name)
    private readonly jobs: Model<ImportJobDocument>,
    private readonly scraper: ApifyScraperService,
    private readonly verifier: EmailVerificationService,
  ) {}

  async create(request: ApifyImportRequest) {
    this.validate(request);
    const job = await this.jobs.create({ status: 'queued', request });
    void this.run(job._id.toString(), request);
    return { jobId: job._id.toString(), status: job.status };
  }

  async get(jobId: string) {
    if (!isValidObjectId(jobId)) throw new Error('jobId is invalid.');
    const job = await this.jobs.findById(jobId).lean();
    if (!job) throw new Error('Import job not found.');
    return job;
  }

  private async run(jobId: string, request: ApifyImportRequest) {
    await this.jobs.updateOne({ _id: jobId }, { $set: { status: 'running' } });
    try {
      const result = await this.scraper.scrape(request);
      let upserted = 0;
      const importedEmails: string[] = [];
      for (const lead of result.leads) {
        const normalizedEmail = lead.email.trim().toLowerCase();
        if (!isOutreachEmail(normalizedEmail)) continue;
        importedEmails.push(normalizedEmail);
        const update = await this.leads.updateOne(
          { normalizedEmail },
          {
            $set: {
              email: normalizedEmail,
              companyName: lead.companyName || 'Business',
              personName: lead.personName ?? '',
              category: lead.category,
              phone: lead.phone,
              address: lead.address,
              country: lead.country,
              source: {
                provider: 'apify',
                runId: lead.runId,
                website: lead.website,
                googleMapsUrl: lead.googleMapsUrl,
              },
            },
            $setOnInsert: {
              normalizedEmail,
              verification: {
                status: 'pending',
                provider: 'mails.so',
              },
              delivery: { status: 'not_queued', attempts: 0 },
              research: { status: 'pending', businessSummary: '', services: [], evidence: [] },
              analysis: { status: 'pending', relevantProcess: '', proposedSolution: '', expectedBenefits: [], confidence: 0 },
              emailDraft: { status: 'not_generated', subject: '', bodyText: '' },
              unsubscribed: false,
            },
          },
          { upsert: true },
        );
        if (update.upsertedCount > 0 || update.modifiedCount > 0) upserted += 1;
      }

      await this.jobs.updateOne(
        { _id: jobId },
        {
          $set: {
            apifyRunId: result.runIds.join(','),
            businessesFound: result.places,
            leadsFound: result.leads.length,
            leadsUpserted: upserted,
          },
        },
      );
      await this.verifier.verifyPending([...new Set(importedEmails)]);
      await this.jobs.updateOne(
        { _id: jobId },
        { $set: { status: 'completed' } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Import ${jobId} failed: ${message}`);
      await this.jobs.updateOne(
        { _id: jobId },
        { $set: { status: 'failed', error: message } },
      );
    }
  }

  private validate(request: ApifyImportRequest) {
    const usingRuns = Array.isArray(request.runIds) && request.runIds.length > 0;
    if (!usingRuns) {
      if (!Array.isArray(request.searchTerms) || request.searchTerms.length === 0) {
        throw new Error('searchTerms must contain at least one search term.');
      }
      if (!Array.isArray(request.locations) || request.locations.length === 0) {
        throw new Error('locations must contain at least one location.');
      }
    }
    const maximum = request.maxPlacesPerSearch ?? 100;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 300) {
      throw new Error('maxPlacesPerSearch must be between 1 and 300.');
    }
  }
}

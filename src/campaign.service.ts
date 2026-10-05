import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import sgMail from '@sendgrid/mail';
import { Model } from 'mongoose';

import { ImportJob, ImportJobDocument } from './schemas/import-job.schema';

import { CampaignRequest, TestEmailRequest } from './outreach.types';
import {
  Campaign,
  CampaignDocument,
} from './schemas/campaign.schema';
import { Lead, LeadDocument } from './schemas/lead.schema';

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    @InjectModel(Lead.name) private readonly leads: Model<LeadDocument>,
    @InjectModel(Campaign.name)
    private readonly campaigns: Model<CampaignDocument>,
    @InjectModel(ImportJob.name)
    private readonly importJobs: Model<ImportJobDocument>,
  ) { }

  /**
   * Jobs run in-process, so a restart abandons whatever was in flight. Run at
   * server startup (single instance — see README) to release that work:
   *  - `queued` leads were claimed but never attempted → back to not_queued.
   *  - `sending` leads may or may not have reached SendGrid → failed, never
   *    resent automatically, so nobody gets the same email twice.
   */
  async recoverInterrupted() {
    const reason = 'Interrupted by a server restart.';
    const released = await this.leads.updateMany(
      { 'delivery.status': 'queued' },
      { $set: { 'delivery.status': 'not_queued' }, $unset: { 'delivery.campaignId': 1, 'delivery.queuedAt': 1 } },
    );
    const uncertain = await this.leads.updateMany(
      { 'delivery.status': 'sending' },
      { $set: { 'delivery.status': 'failed', 'delivery.lastError': `${reason} Delivery is unknown; check SendGrid activity before resending.` } },
    );
    const campaigns = await this.campaigns.updateMany(
      { status: { $in: ['queued', 'running'] } },
      { $set: { status: 'failed', error: reason } },
    );
    const imports = await this.importJobs.updateMany(
      { status: { $in: ['queued', 'running'] } },
      { $set: { status: 'failed', error: reason } },
    );
    const total = released.modifiedCount + uncertain.modifiedCount + campaigns.modifiedCount + imports.modifiedCount;
    if (total) {
      this.logger.warn(
        `Recovered after restart: ${released.modifiedCount} lead(s) released, ${uncertain.modifiedCount} marked failed, ` +
        `${campaigns.modifiedCount} campaign(s) and ${imports.modifiedCount} import(s) marked failed.`,
      );
    }
  }

  async create(request: CampaignRequest) {
    const templateId = request.templateId?.trim();
    if (!templateId) throw new Error('templateId is required.');
    const limit = request.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('limit must be between 1 and 10000.');
    }

    if (request.idempotencyKey) {
      const existing = await this.campaigns.findOne({
        idempotencyKey: request.idempotencyKey,
      });
      if (existing) {
        return { campaignId: existing._id.toString(), status: existing.status };
      }
    }

    const campaign = await this.campaigns.create({
      status: 'queued',
      templateId,
      limit,
      idempotencyKey: request.idempotencyKey,
    });
    void this.run(campaign._id.toString(), templateId, limit);
    return { campaignId: campaign._id.toString(), status: campaign.status };
  }

  async sendTest(request: TestEmailRequest) {
    const to = request.to?.trim().toLowerCase();
    const templateId = request.templateId?.trim();
    if (!to || !this.isEmail(to)) {
      throw new Error('A valid recipient email is required.');
    }
    if (!templateId) throw new Error('templateId is required.');
    if (
      request.templateData !== undefined &&
      (typeof request.templateData !== 'object' ||
        request.templateData === null ||
        Array.isArray(request.templateData))
    ) {
      throw new Error('templateData must be an object.');
    }

    const config = this.config();
    const companyName = request.companyName?.trim() || 'Test Clinic';
    const personName = request.personName?.trim() || 'there';
    sgMail.setApiKey(config.apiKey);

    try {
      const [response] = await sgMail.send({
        to: { email: to, name: request.personName?.trim() || companyName },
        from: { email: config.fromEmail, name: config.fromName },
        templateId,
        dynamicTemplateData: {
          ...this.templateData(personName, companyName),
          ...request.templateData,
        },
        ...(config.asmGroupId
          ? { asm: { groupId: config.asmGroupId } }
          : {}),
      });
      return {
        status: 'sent',
        to,
        templateId,
        messageId: String(response.headers['x-message-id'] ?? ''),
      };
    } catch (error) {
      throw new Error(`SendGrid test send failed: ${this.sendGridError(error)}`);
    }
  }

  private async run(campaignId: string, templateId: string, limit: number) {
    try {
      const config = this.config();
      sgMail.setApiKey(config.apiKey);
      await this.campaigns.updateOne(
        { _id: campaignId },
        { $set: { status: 'running' } },
      );

      // Claim each lead with one atomic conditional update. If two campaign
      // requests run concurrently, only one can transition a given recipient
      // from not_queued → queued; every later campaign skips that address.
      const ids: LeadDocument['_id'][] = [];
      for (let index = 0; index < limit; index += 1) {
        const claimed = await this.leads.findOneAndUpdate(
          {
            'verification.status': { $in: ['valid', 'unknown'] },
            'delivery.status': 'not_queued',
            unsubscribed: false,
          },
          {
            $set: {
              'delivery.status': 'queued',
              'delivery.campaignId': campaignId,
              'delivery.templateId': templateId,
              'delivery.queuedAt': new Date(),
            },
          },
          {
            new: true,
            sort: { createdAt: -1 },
            projection: { _id: 1 },
          },
        );
        if (!claimed) break;
        ids.push(claimed._id);
      }
      await this.campaigns.updateOne(
        { _id: campaignId },
        { $set: { queued: ids.length } },
      );

      let sent = 0;
      let failed = 0;
      while (sent + failed < ids.length) {
        const lead = await this.leads.findOneAndUpdate(
          {
            _id: { $in: ids },
            'delivery.status': 'queued',
            'delivery.campaignId': campaignId,
          },
          {
            $set: {
              'delivery.status': 'sending',
              'delivery.lastAttemptAt': new Date(),
            },
            $inc: { 'delivery.attempts': 1 },
          },
          { new: true },
        );
        if (!lead) break;

        try {
          const [response] = await sgMail.send({
            to: {
              email: lead.normalizedEmail,
              name: lead.personName || lead.companyName,
            },
            from: { email: config.fromEmail, name: config.fromName },
            templateId,
            dynamicTemplateData: this.templateData(
              lead.personName || 'there',
              lead.companyName,
            ),
            ...(config.asmGroupId
              ? { asm: { groupId: config.asmGroupId } }
              : {}),
          });
          const messageId = String(response.headers['x-message-id'] ?? '');
          await this.leads.updateOne(
            { _id: lead._id },
            {
              $set: {
                'delivery.status': 'sent',
                'delivery.sentAt': new Date(),
                'delivery.sendGridMessageId': messageId,
              },
              $unset: { 'delivery.lastError': 1 },
            },
          );
          sent += 1;
        } catch (error) {
          const message = this.sendGridError(error);
          await this.leads.updateOne(
            { _id: lead._id },
            {
              $set: {
                'delivery.status': 'failed',
                'delivery.lastError': message,
              },
            },
          );
          failed += 1;
        }

        await this.campaigns.updateOne(
          { _id: campaignId },
          { $set: { sent, failed } },
        );
        if (config.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, config.delayMs));
        }
      }
      await this.campaigns.updateOne(
        { _id: campaignId },
        { $set: { status: 'completed', sent, failed } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Campaign ${campaignId} failed: ${message}`);
      await this.campaigns.updateOne(
        { _id: campaignId },
        { $set: { status: 'failed', error: message } },
      );
      await this.leads.updateMany(
        {
          'delivery.campaignId': campaignId,
          'delivery.status': { $in: ['queued', 'sending'] },
        },
        {
          $set: {
            'delivery.status': 'failed',
            'delivery.lastError': message,
          },
        },
      );
    }
  }

  private config() {
    const config = {
      apiKey: process.env.SENDGRID_API_KEY?.trim() ?? '',
      fromEmail: process.env.SENDGRID_FROM_EMAIL?.trim() ?? '',
      fromName: process.env.SENDGRID_FROM_NAME?.trim() ?? '',
      asmGroupId: this.optionalPositiveInteger('SENDGRID_ASM_GROUP_ID'),
      delayMs: Number(process.env.SEND_DELAY_MS ?? 250),
    };
    const missing = Object.entries(config)
      .filter(
        ([key, value]) =>
          key !== 'delayMs' && key !== 'asmGroupId' && !value,
      )
      .map(([key]) => key);
    if (missing.length) {
      throw new Error(`Missing SendGrid configuration: ${missing.join(', ')}`);
    }
    if (!Number.isFinite(config.delayMs) || config.delayMs < 0) {
      config.delayMs = 250;
    }
    return config;
  }

  private templateData(personName: string, companyName: string) {
    return {
      personName,
      person_name: personName,
      surname: personName,
      companyName,
      company_name: companyName,
      clinic_name: companyName.replace(/\s*&\s*/g, ' and '),
    };
  }

  private optionalPositiveInteger(name: string): number | undefined {
    const raw = process.env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return value;
  }

  private isEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  private sendGridError(error: unknown): string {
    if (typeof error !== 'object' || error === null) return String(error);
    const candidate = error as {
      message?: string;
      response?: { body?: unknown };
    };
    return candidate.response?.body
      ? JSON.stringify(candidate.response.body)
      : candidate.message ?? 'Unknown SendGrid error';
  }
}

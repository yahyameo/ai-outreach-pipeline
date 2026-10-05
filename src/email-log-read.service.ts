import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';

import { EmailLog, EmailLogDocument } from './schemas/email-log.schema';

export interface EmailLogListQuery {
  leadId?: string;
  recipientEmail?: string;
  status?: string;
  kind?: string;
  outreachType?: string;
  locale?: string;
  limit?: string;
}

@Injectable()
export class EmailLogReadService {
  constructor(@InjectModel(EmailLog.name) private readonly logs: Model<EmailLogDocument>) {}

  async get(logId: string) {
    if (!isValidObjectId(logId)) throw new Error('logId is invalid.');
    const log = await this.logs.findById(logId).lean();
    if (!log) throw new Error('Email log not found.');
    return log;
  }

  async list(query: EmailLogListQuery) {
    const limit = Number(query.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('limit must be between 1 and 200.');
    }
    const filter: Record<string, unknown> = {};
    if (query.leadId) {
      if (!isValidObjectId(query.leadId)) throw new Error('leadId is invalid.');
      filter.leadId = query.leadId;
    }
    if (query.recipientEmail) filter.recipientEmail = query.recipientEmail.trim().toLowerCase();
    if (query.status) filter.status = query.status;
    if (query.kind) filter.kind = query.kind;
    if (query.outreachType) filter.outreachType = query.outreachType;
    if (query.locale) filter.locale = query.locale;
    const logs = await this.logs.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return { count: logs.length, limit, logs };
  }
}

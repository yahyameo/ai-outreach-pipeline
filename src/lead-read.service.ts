import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';

import { LeadListQuery } from './outreach.types';
import { Lead, LeadDocument } from './schemas/lead.schema';

@Injectable()
export class LeadReadService {
  constructor(@InjectModel(Lead.name) private readonly leads: Model<LeadDocument>) {}

  async get(leadId: string) {
    if (!isValidObjectId(leadId)) throw new Error('leadId is invalid.');
    const lead = await this.leads.findById(leadId).select('-verification.rawResult').lean();
    if (!lead) throw new Error('Lead not found.');
    return lead;
  }

  async list(query: LeadListQuery) {
    const limit = Number(query.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('limit must be between 1 and 200.');
    }
    const filter: Record<string, unknown> = {};
    if (query.runId) filter['source.runId'] = query.runId;
    if (query.verificationStatus) filter['verification.status'] = query.verificationStatus;
    if (query.deliveryStatus) filter['delivery.status'] = query.deliveryStatus;
    if (query.analysisStatus) filter['analysis.status'] = query.analysisStatus;
    if (query.country) filter.country = query.country;
    const leads = await this.leads
      .find(filter)
      .select('email normalizedEmail personName companyName category country source verification.status delivery analysis.status emailDraft.status unsubscribed createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return { count: leads.length, limit, leads };
  }
}

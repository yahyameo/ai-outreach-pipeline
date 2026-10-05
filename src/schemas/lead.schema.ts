import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { OUTREACH_LOCALES, OUTREACH_TYPES } from '../outreach.constants';

export type LeadDocument = HydratedDocument<Lead>;

@Schema({ _id: false })
export class LeadSource {
  @Prop({ required: true, default: 'apify' })
  provider!: string;

  @Prop()
  runId?: string;

  @Prop()
  website?: string;

  @Prop()
  googleMapsUrl?: string;
}

@Schema({ _id: false })
export class Verification {
  @Prop({
    required: true,
    enum: ['pending', 'valid', 'invalid', 'risky', 'unknown', 'failed'],
    default: 'pending',
  })
  status!: string;

  @Prop({ default: 'mails.so' })
  provider!: string;

  @Prop()
  checkedAt?: Date;

  @Prop({ type: Object })
  rawResult?: Record<string, unknown>;

  @Prop()
  error?: string;
}

@Schema({ _id: false })
export class Delivery {
  @Prop({
    required: true,
    enum: [
      'not_queued',
      'queued',
      'sending',
      'sent',
      'delivered',
      'failed',
      'bounced',
      'blocked',
      'unsubscribed',
    ],
    default: 'not_queued',
  })
  status!: string;

  @Prop()
  campaignId?: string;

  @Prop()
  templateId?: string;

  @Prop({ default: 0 })
  attempts!: number;

  @Prop()
  queuedAt?: Date;

  @Prop()
  lastAttemptAt?: Date;

  @Prop()
  sentAt?: Date;

  @Prop()
  lastError?: string;

  @Prop()
  sendGridMessageId?: string;
}

@Schema({ _id: false })
export class ResearchEvidence {
  @Prop({ required: true })
  url!: string;

  @Prop({ required: true })
  observation!: string;
}

@Schema({ _id: false })
export class LeadResearch {
  @Prop({ enum: ['pending', 'completed', 'failed'], default: 'pending' })
  status!: string;

  @Prop({ default: '' })
  businessSummary!: string;

  @Prop({ type: [String], default: [] })
  services!: string[];

  @Prop({ type: [ResearchEvidence], default: [] })
  evidence!: ResearchEvidence[];

  @Prop()
  researchedAt?: Date;

  @Prop()
  error?: string;
}

@Schema({ _id: false })
export class LeadAnalysis {
  @Prop({ enum: ['pending', 'qualified', 'rejected', 'failed'], default: 'pending' })
  status!: string;

  @Prop({ default: '' })
  relevantProcess!: string;

  @Prop({ default: '' })
  proposedSolution!: string;

  @Prop({ type: [String], default: [] })
  expectedBenefits!: string[];

  @Prop({ default: 0, min: 0, max: 1 })
  confidence!: number;

  @Prop()
  rejectionReason?: string;

  @Prop()
  model?: string;

  @Prop()
  generatedAt?: Date;

  @Prop({ enum: [...OUTREACH_TYPES], default: 'general_ai' })
  outreachType!: string;

  @Prop({ default: 0, min: 0, max: 100 })
  fitScore!: number;

  @Prop({ type: [String], default: [] })
  observedSignals!: string[];
}

@Schema({ _id: false })
export class EmailDraft {
  @Prop({ enum: ['not_generated', 'generated', 'approved'], default: 'not_generated' })
  status!: string;

  @Prop({ default: '' })
  subject!: string;

  @Prop({ default: '' })
  bodyText!: string;

  @Prop()
  generatedAt?: Date;

  @Prop()
  approvedAt?: Date;

  @Prop()
  lastTestSentAt?: Date;

  @Prop()
  lastTestMessageId?: string;

  @Prop()
  lastTestRecipient?: string;

  @Prop({ enum: [...OUTREACH_LOCALES], default: 'en-SG' })
  locale!: string;
}

@Schema({ timestamps: true, collection: 'outreach_leads' })
export class Lead {
  @Prop({ required: true, trim: true })
  email!: string;

  @Prop({ required: true, unique: true, index: true, lowercase: true })
  normalizedEmail!: string;

  @Prop({ default: '' })
  personName!: string;

  @Prop({ required: true, default: 'Business' })
  companyName!: string;

  @Prop()
  category?: string;

  @Prop()
  phone?: string;

  @Prop()
  address?: string;

  @Prop({ index: true })
  country?: string;

  @Prop({ type: LeadSource, required: true })
  source!: LeadSource;

  @Prop({ type: Verification, required: true, default: () => ({}) })
  verification!: Verification;

  @Prop({ type: Delivery, required: true, default: () => ({}) })
  delivery!: Delivery;

  @Prop({ type: LeadResearch, required: true, default: () => ({}) })
  research!: LeadResearch;

  @Prop({ type: LeadAnalysis, required: true, default: () => ({}) })
  analysis!: LeadAnalysis;

  @Prop({ type: EmailDraft, required: true, default: () => ({}) })
  emailDraft!: EmailDraft;

  @Prop({ default: false, index: true })
  unsubscribed!: boolean;

  @Prop()
  unsubscribedAt?: Date;

  /** "api", or "sendgrid:<event>" when it came from the Event Webhook. */
  @Prop()
  unsubscribeSource?: string;
}

export const LeadSchema = SchemaFactory.createForClass(Lead);
LeadSchema.index({ 'verification.status': 1, 'delivery.status': 1, unsubscribed: 1 });
LeadSchema.index({ 'analysis.status': 1, 'emailDraft.status': 1 });

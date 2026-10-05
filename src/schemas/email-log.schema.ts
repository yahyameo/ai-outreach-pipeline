import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { OUTREACH_LOCALES, OUTREACH_TYPES } from '../outreach.constants';

export type EmailLogDocument = HydratedDocument<EmailLog>;

@Schema({ timestamps: true, collection: 'outreach_email_logs' })
export class EmailLog {
  @Prop({ type: Types.ObjectId, ref: 'Lead', required: true, index: true })
  leadId!: Types.ObjectId;

  @Prop({ required: true })
  companyName!: string;

  @Prop({ required: true, lowercase: true, index: true })
  recipientEmail!: string;

  @Prop({ enum: ['production', 'test'], required: true, index: true })
  kind!: string;

  @Prop({ enum: [...OUTREACH_TYPES], required: true, index: true })
  outreachType!: string;

  @Prop({ enum: [...OUTREACH_LOCALES], required: true, index: true })
  locale!: string;

  @Prop({ enum: ['pending', 'sent', 'failed'], required: true, default: 'pending', index: true })
  status!: string;

  @Prop({ required: true })
  fromEmail!: string;

  @Prop({ required: true })
  fromName!: string;

  @Prop({ required: true })
  replyToEmail!: string;

  @Prop({ required: true })
  subject!: string;

  @Prop({ required: true })
  bodyText!: string;

  @Prop({ required: true })
  bodyHtml!: string;

  @Prop({ required: true })
  attemptedAt!: Date;

  @Prop()
  sentAt?: Date;

  @Prop()
  sendGridMessageId?: string;

  @Prop()
  error?: string;
}

export const EmailLogSchema = SchemaFactory.createForClass(EmailLog);
EmailLogSchema.index({ createdAt: -1 });
EmailLogSchema.index({ leadId: 1, createdAt: -1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CampaignDocument = HydratedDocument<Campaign>;

@Schema({ timestamps: true, collection: 'outreach_campaigns' })
export class Campaign {
  @Prop({ required: true, enum: ['queued', 'running', 'completed', 'failed'] })
  status!: string;

  @Prop({ required: true })
  templateId!: string;

  @Prop({ required: true })
  limit!: number;

  @Prop()
  idempotencyKey?: string;

  @Prop({ default: 0 })
  queued!: number;

  @Prop({ default: 0 })
  sent!: number;

  @Prop({ default: 0 })
  failed!: number;

  @Prop()
  error?: string;
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);
CampaignSchema.index(
  { idempotencyKey: 1 },
  { unique: true, sparse: true },
);

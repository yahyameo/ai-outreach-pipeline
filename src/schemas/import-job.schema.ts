import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ImportJobDocument = HydratedDocument<ImportJob>;

@Schema({ timestamps: true, collection: 'outreach_import_jobs' })
export class ImportJob {
  @Prop({ required: true, enum: ['queued', 'running', 'completed', 'failed'] })
  status!: string;

  @Prop({ type: Object, required: true })
  request!: Record<string, unknown>;

  @Prop()
  apifyRunId?: string;

  @Prop({ default: 0 })
  businessesFound!: number;

  @Prop({ default: 0 })
  leadsFound!: number;

  @Prop({ default: 0 })
  leadsUpserted!: number;

  @Prop()
  error?: string;
}

export const ImportJobSchema = SchemaFactory.createForClass(ImportJob);

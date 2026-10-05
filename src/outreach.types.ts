import { OutreachLocale, OutreachType } from './outreach.constants';

export interface ApifyImportRequest {
  searchTerms: string[];
  locations: string[];
  maxPlacesPerSearch?: number;
  language?: string;
  actorId?: string;
  runIds?: string[];
}

export interface ScrapedLead {
  email: string;
  companyName: string;
  personName?: string;
  country?: string;
  category?: string;
  phone?: string;
  address?: string;
  website?: string;
  googleMapsUrl?: string;
  runId?: string;
}

export interface CampaignRequest {
  templateId: string;
  limit?: number;
  idempotencyKey?: string;
}

export interface LeadOutreachRequest {
  mode?: 'preview' | 'send';
  refreshResearch?: boolean;
  outreachType?: OutreachType;
  locale?: OutreachLocale;
}

export interface LeadOutreachTestRequest {
  to: string;
  refreshResearch?: boolean;
  outreachType?: OutreachType;
  locale?: OutreachLocale;
}

export interface LeadListQuery {
  runId?: string;
  verificationStatus?: string;
  deliveryStatus?: string;
  analysisStatus?: string;
  country?: string;
  limit?: string;
}

export interface TestEmailRequest {
  to: string;
  templateId: string;
  companyName?: string;
  personName?: string;
  templateData?: Record<string, unknown>;
}

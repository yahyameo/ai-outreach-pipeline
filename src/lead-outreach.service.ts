import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import sgMail from '@sendgrid/mail';
import { isValidObjectId, Model } from 'mongoose';

import { OpenAiOutreachService } from './openai-outreach.service';
import { isOutreachLocale, isOutreachType, OutreachLocale, OutreachType } from './outreach.constants';
import { LeadOutreachRequest, LeadOutreachTestRequest } from './outreach.types';
import { Lead, LeadDocument } from './schemas/lead.schema';
import { EmailLog, EmailLogDocument } from './schemas/email-log.schema';
import { senderProfile } from './sender-profile';
import { ResearchedPage, WebsiteResearchService } from './website-research.service';

const LINK_LABELS: Record<'en' | 'es-MX' | 'vi-VN' | 'th-TH' | 'fr-FR' | 'de-DE', { booking: string; website(company: string): string }> = {
  en: { booking: 'Book a Google Meet', website: (company) => `Visit ${company}` },
  'es-MX': { booking: 'Reservar una reunión por Google Meet', website: (company) => `Visitar ${company}` },
  'vi-VN': { booking: 'Đặt lịch Google Meet', website: (company) => `Truy cập ${company}` },
  'th-TH': { booking: 'จองเวลา Google Meet', website: (company) => `เยี่ยมชม ${company}` },
  'fr-FR': { booking: 'Planifier un échange sur Google Meet', website: (company) => `Découvrir ${company}` },
  'de-DE': { booking: 'Google-Meet-Termin vereinbaren', website: (company) => `${company} besuchen` },
};

@Injectable()
export class LeadOutreachService {
  constructor(
    @InjectModel(Lead.name) private readonly leads: Model<LeadDocument>,
    private readonly websites: WebsiteResearchService,
    private readonly openai: OpenAiOutreachService,
    @InjectModel(EmailLog.name) private readonly emailLogs: Model<EmailLogDocument>,
  ) {}

  async run(leadId: string, request: LeadOutreachRequest) {
    if (!isValidObjectId(leadId)) throw new Error('leadId is invalid.');
    const mode = request.mode ?? 'preview';
    const outreachType = request.outreachType ?? 'general_ai';
    const locale = request.locale ?? 'en-SG';
    if (!['preview', 'send'].includes(mode)) throw new Error('mode must be preview or send.');
    if (!isOutreachType(outreachType)) throw new Error('outreachType is invalid.');
    if (!isOutreachLocale(locale)) throw new Error('locale is invalid.');
    let lead = await this.leads.findById(leadId);
    if (!lead) throw new Error('Lead not found.');
    this.assertPreviewEligibility(lead);
    if (mode === 'send' && lead.delivery.status !== 'not_queued') {
      throw new Error(`Lead delivery status is ${lead.delivery.status}.`);
    }
    let generatedNow = false;
    if (request.refreshResearch || lead.analysis?.outreachType !== outreachType || lead.emailDraft?.locale !== locale || lead.emailDraft?.status === 'not_generated' || !lead.emailDraft?.bodyText) {
      generatedNow = true;
      lead = await this.researchAndGenerate(lead, outreachType, locale);
    }
    if (mode === 'preview') return this.response(lead, 'not_sent', generatedNow);
    if (lead.analysis.status !== 'qualified' || !lead.emailDraft.bodyText || !lead.emailDraft.subject) {
      throw new Error(lead.analysis.rejectionReason || 'This lead did not qualify for outreach.');
    }
    return this.send(lead, generatedNow);
  }

  async sendTest(leadId: string, request: LeadOutreachTestRequest) {
    const to = request.to?.trim().toLowerCase();
    if (!to || !this.isEmail(to)) throw new Error('A valid test recipient email is required.');
    const preview = await this.run(leadId, {
      mode: 'preview',
      refreshResearch: request.refreshResearch,
      outreachType: request.outreachType,
      locale: request.locale,
    });
    const lead = await this.leads.findById(leadId);
    if (!lead) throw new Error('Lead not found.');
    if (lead.analysis.status !== 'qualified' || !lead.emailDraft.subject || !lead.emailDraft.bodyText) {
      throw new Error(lead.analysis.rejectionReason || 'This lead did not qualify for outreach.');
    }
    const { apiKey, fromEmail, fromName } = this.sendGridConfig();
    const sender = senderProfile();
    sgMail.setApiKey(apiKey);
    const testNotice = `TEST OUTREACH — intended company: ${lead.companyName}\n\n`;
    const subject = `[TEST] ${this.advertisingSubject(lead.emailDraft.subject)}`;
    const bodyText = `${testNotice}${lead.emailDraft.bodyText}`;
    const bodyHtml = `<p><strong>TEST OUTREACH</strong> — intended company: ${this.escapeHtml(lead.companyName)}</p>${this.bodyHtml(lead.emailDraft.bodyText, lead.emailDraft.locale as OutreachLocale)}`;
    let emailLog: EmailLogDocument | undefined;
    try {
      emailLog = await this.emailLogs.create({
        leadId: lead._id,
        companyName: lead.companyName,
        recipientEmail: to,
        kind: 'test',
        outreachType: lead.analysis.outreachType || 'general_ai',
        locale: lead.emailDraft.locale || 'en-SG',
        status: 'pending',
        fromEmail,
        fromName,
        replyToEmail: sender.replyTo,
        subject,
        bodyText,
        bodyHtml,
        attemptedAt: new Date(),
      });
      const [sent] = await sgMail.send({
        to: { email: to, name: `${sender.company} outreach test` },
        from: { email: fromEmail, name: fromName },
        replyTo: { email: sender.replyTo, name: sender.name },
        subject,
        text: bodyText,
        html: bodyHtml,
      });
      const messageId = String(sent.headers['x-message-id'] ?? '');
      const sentAt = new Date();
      await this.emailLogs.updateOne(
        { _id: emailLog._id },
        { $set: { status: 'sent', sentAt, sendGridMessageId: messageId } },
      );
      await this.leads.updateOne(
        { _id: lead._id },
        { $set: {
          'emailDraft.lastTestSentAt': sentAt,
          'emailDraft.lastTestMessageId': messageId,
          'emailDraft.lastTestRecipient': to,
        } },
      );
      return {
        ...preview,
        testDelivery: { status: 'sent', to: this.maskEmail(to), sentAt, messageId },
        productionDeliveryStatus: lead.delivery.status,
      };
    } catch (error) {
      const message = this.message(error);
      if (emailLog) {
        await this.emailLogs.updateOne(
          { _id: emailLog._id },
          { $set: { status: 'failed', error: message } },
        );
      }
      throw new Error(`SendGrid test delivery failed: ${message}`);
    }
  }

  private async researchAndGenerate(lead: LeadDocument, outreachType: OutreachType, locale: OutreachLocale) {
    const website = lead.source?.website?.trim();
    if (!website) throw new Error('The lead has no website to research.');
    let pages: ResearchedPage[];
    try {
      pages = await this.websites.research(website);
    } catch (error) {
      const message = this.message(error);
      await this.leads.updateOne({ _id: lead._id }, { $set: { 'research.status': 'failed', 'research.error': message } });
      throw new Error(`Website research failed: ${message}`);
    }
    try {
      const { result, model } = await this.openai.generate(lead, pages, outreachType, locale);
      const now = new Date();
      const evidence = result.evidence.filter((item) => pages.some((page) => page.url === item.url));
      const minimumFit = ['conversational_agent', 'engineering_partner', 'restaurant_digital', 'sme_digital'].includes(outreachType) ? 65 : 0;
      const analysisStatus = result.qualified && result.confidence >= 0.6 && result.fitScore >= minimumFit && evidence.length ? 'qualified' : 'rejected';
      const updated = await this.leads.findByIdAndUpdate(lead._id, { $set: {
        research: { status: 'completed', businessSummary: result.businessSummary, services: result.services, evidence, researchedAt: now },
        analysis: { status: analysisStatus, relevantProcess: result.relevantProcess, proposedSolution: result.proposedSolution, expectedBenefits: result.expectedBenefits, confidence: result.confidence, rejectionReason: analysisStatus === 'rejected' ? (result.rejectionReason || 'Insufficient supported evidence.') : undefined, model, generatedAt: now, outreachType, fitScore: result.fitScore, observedSignals: result.observedSignals },
        emailDraft: { status: analysisStatus === 'qualified' ? 'generated' : 'not_generated', subject: analysisStatus === 'qualified' ? result.subject.trim() : '', bodyText: analysisStatus === 'qualified' ? result.bodyText.trim() : '', generatedAt: now, locale },
      } }, { new: true });
      if (!updated) throw new Error('Lead disappeared while generating outreach.');
      return updated;
    } catch (error) {
      const message = this.message(error);
      await this.leads.updateOne({ _id: lead._id }, { $set: { 'analysis.status': 'failed', 'analysis.rejectionReason': message } });
      throw new Error(`OpenAI generation failed: ${message}`);
    }
  }

  private async send(lead: LeadDocument, generatedNow = false) {
    const { apiKey, fromEmail, fromName } = this.sendGridConfig();
    const sender = senderProfile();
    const claimed = await this.leads.findOneAndUpdate(
      { _id: lead._id, 'verification.status': { $in: this.allowedVerificationStatuses() }, unsubscribed: false, 'delivery.status': 'not_queued', 'analysis.status': 'qualified', 'emailDraft.status': { $in: ['generated', 'approved'] } },
      { $set: { 'delivery.status': 'sending', 'delivery.lastAttemptAt': new Date() }, $unset: { 'delivery.templateId': 1 }, $inc: { 'delivery.attempts': 1 } },
      { new: true },
    );
    if (!claimed) throw new Error('Lead is no longer eligible or has already been queued/sent.');
    sgMail.setApiKey(apiKey);
    const subject = this.advertisingSubject(claimed.emailDraft.subject);
    const bodyText = claimed.emailDraft.bodyText;
    const bodyHtml = this.bodyHtml(bodyText, (claimed.emailDraft.locale || 'en-SG') as OutreachLocale);
    let emailLog: EmailLogDocument | undefined;
    try {
      emailLog = await this.emailLogs.create({
        leadId: claimed._id,
        companyName: claimed.companyName,
        recipientEmail: claimed.normalizedEmail,
        kind: 'production',
        outreachType: claimed.analysis.outreachType || 'general_ai',
        locale: claimed.emailDraft.locale || 'en-SG',
        status: 'pending',
        fromEmail,
        fromName,
        replyToEmail: sender.replyTo,
        subject,
        bodyText,
        bodyHtml,
        attemptedAt: new Date(),
      });
      const asmGroupId = this.asmGroupId();
      const [sent] = await sgMail.send({
        to: { email: claimed.normalizedEmail, name: claimed.personName || claimed.companyName },
        from: { email: fromEmail, name: fromName },
        replyTo: { email: sender.replyTo, name: sender.name },
        subject,
        text: bodyText,
        html: bodyHtml,
        ...(asmGroupId ? { asm: { groupId: asmGroupId } } : {}),
      });
      const messageId = String(sent.headers['x-message-id'] ?? '');
      const sentAt = new Date();
      await this.emailLogs.updateOne(
        { _id: emailLog._id },
        { $set: { status: 'sent', sentAt, sendGridMessageId: messageId } },
      );
      const updated = await this.leads.findByIdAndUpdate(claimed._id, { $set: { 'delivery.status': 'sent', 'delivery.sentAt': sentAt, 'delivery.sendGridMessageId': messageId }, $unset: { 'delivery.lastError': 1 } }, { new: true });
      return this.response(updated!, 'sent', generatedNow, messageId);
    } catch (error) {
      const message = this.message(error);
      if (emailLog) {
        await this.emailLogs.updateOne(
          { _id: emailLog._id },
          { $set: { status: 'failed', error: message } },
        );
      }
      await this.leads.updateOne({ _id: claimed._id }, { $set: { 'delivery.status': 'failed', 'delivery.lastError': message } });
      throw new Error(`SendGrid delivery failed: ${message}`);
    }
  }

  private assertPreviewEligibility(lead: LeadDocument) {
    if (!this.allowedVerificationStatuses().includes(lead.verification.status)) {
      throw new Error(`Lead verification status ${lead.verification.status} is not eligible.`);
    }
    if (lead.unsubscribed) throw new Error('Lead has unsubscribed.');
  }
  private response(lead: LeadDocument, deliveryStatus: string, generatedNow: boolean, messageId?: string) {
    return { leadId: lead._id.toString(), companyName: lead.companyName, generatedNow, research: lead.research, analysis: lead.analysis, email: { subject: lead.emailDraft.subject, bodyText: lead.emailDraft.bodyText }, deliveryStatus, ...(messageId ? { messageId } : {}) };
  }
  private asmGroupId() { const value = Number(process.env.SENDGRID_ASM_GROUP_ID ?? ''); return Number.isInteger(value) && value > 0 ? value : undefined; }
  private allowedVerificationStatuses() { return ['valid', 'unknown']; }
  private advertisingSubject(subject: string) {
    return `<ADV> ${subject.trim().replace(/^<ADV>\s*/i, '')}`;
  }
  private sendGridConfig() {
    const apiKey = process.env.SENDGRID_API_KEY?.trim();
    const fromEmail = process.env.SENDGRID_FROM_EMAIL?.trim();
    const fromName = process.env.SENDGRID_FROM_NAME?.trim();
    if (!apiKey || !fromEmail || !fromName) {
      throw new Error('SendGrid API key, sender email, and sender name are required.');
    }
    return { apiKey, fromEmail, fromName };
  }
  private bodyHtml(body: string, locale: OutreachLocale = 'en-SG') {
    const sender = senderProfile(locale);
    const labels = LINK_LABELS[locale as keyof typeof LINK_LABELS] ?? LINK_LABELS.en;
    let html = this.escapeHtml(body);
    // The footer is application-controlled, so these URLs are known exactly;
    // only their first occurrence (the footer) becomes a labelled link.
    if (sender.bookingUrl) html = html.replace(this.escapeHtml(sender.bookingUrl), this.link(sender.bookingUrl, labels.booking));
    if (sender.website) html = html.replace(this.escapeHtml(sender.website), this.link(sender.website, labels.website(sender.company)));
    return html.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join('');
  }
  private link(url: string, label: string) {
    return `<a href="${this.escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(label)}</a>`;
  }
  private escapeHtml(value: string) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  private isEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
  private maskEmail(value: string) {
    const [local, domain] = value.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
  private message(error: unknown) {
    if (typeof error === 'object' && error !== null) { const candidate = error as { message?: string; response?: { data?: unknown } }; if (candidate.response?.data) return JSON.stringify(candidate.response.data); if (candidate.message) return candidate.message; }
    return String(error);
  }
}

import { Injectable } from '@nestjs/common';
import sgMail from '@sendgrid/mail';
import { decode } from 'he';
import { readFile } from 'node:fs/promises';
import readXlsxFile from 'read-excel-file/node';

export interface Recipient {
  companyName: string;
  personName: string;
  email: string;
}

export interface SendResult extends Recipient {
  status: 'sent' | 'dry-run' | 'failed';
  error?: string;
}

interface CampaignOptions {
  spreadsheetPath: string;
  send: boolean;
}

@Injectable()
export class EmailCampaignService {
  async run(options: CampaignOptions): Promise<SendResult[]> {
    const recipients = await this.readRecipients(options.spreadsheetPath);

    if (recipients.length === 0) {
      throw new Error('The spreadsheet contains no valid recipients.');
    }

    const config = this.getConfig(options.send);
    const results: SendResult[] = [];

    console.log(
      `${options.send ? 'Sending' : 'Dry run for'} ${recipients.length} recipient(s).`,
    );

    for (const [index, recipient] of recipients.entries()) {
      const subjectCompanyName = this.subjectCompanyName(
        recipient.companyName,
      );
      if (!options.send) {
        console.log(
          `[${index + 1}/${recipients.length}] DRY RUN ${recipient.email} (person: ${recipient.personName}, company: ${subjectCompanyName})`,
        );
        results.push({ ...recipient, status: 'dry-run' });
        continue;
      }

      try {
        await sgMail.send({
          to: {
            email: recipient.email,
            name: recipient.personName,
          },
          from: {
            email: config.fromEmail,
            name: config.fromName,
          },
          templateId: config.templateId,
          dynamicTemplateData: {
            companyName: recipient.companyName,
            // SendGrid HTML-escapes Handlebars values even in the Subject
            // header, where mail clients display "&amp;" literally. This alias
            // is used by the existing subject template and avoids characters
            // that require HTML encoding. Keep companyName exact for the body.
            clinic_name: subjectCompanyName,
            personName: recipient.personName,
            person_name: recipient.personName,
          },
        });

        console.log(
          `[${index + 1}/${recipients.length}] SENT ${recipient.email}`,
        );
        results.push({ ...recipient, status: 'sent' });
      } catch (error) {
        const message = this.sendGridError(error);
        console.error(
          `[${index + 1}/${recipients.length}] FAILED ${recipient.email}: ${message}`,
        );
        results.push({ ...recipient, status: 'failed', error: message });
      }

      if (config.delayMs > 0 && index < recipients.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, config.delayMs));
      }
    }

    return results;
  }

  private async readRecipients(spreadsheetPath: string): Promise<Recipient[]> {
    const extension = spreadsheetPath.toLowerCase().split('.').pop();
    let rows: readonly (readonly unknown[])[];

    if (extension === 'xlsx') {
      const sheets = await readXlsxFile(spreadsheetPath);
      const worksheet = sheets[0]?.data;
      if (!worksheet) {
        throw new Error('The spreadsheet has no worksheets.');
      }
      rows = worksheet;
    } else if (extension === 'csv') {
      rows = this.parseCsv(await readFile(spreadsheetPath, 'utf8'));
    } else {
      throw new Error('The recipient file must be an .xlsx or .csv file.');
    }

    const headerRow = rows[0];
    if (!headerRow) {
      throw new Error('The spreadsheet is empty.');
    }

    const headers = new Map<number, string>();
    headerRow.forEach((cell, columnIndex) => {
      headers.set(columnIndex, this.normalizeHeader(String(cell ?? '')));
    });

    const seenEmails = new Set<string>();
    const recipients: Recipient[] = [];

    rows.slice(1).forEach((row, rowIndex) => {
      const rowNumber = rowIndex + 2;
      const normalized: Record<string, string> = {};
      headers.forEach((header, columnIndex) => {
        normalized[header] = String(row[columnIndex] ?? '').trim();
      });

      const recipient: Recipient = {
        companyName: this.cleanText(
          normalized.companyname || normalized.company || 'Business',
        ),
        personName: this.cleanText(
          normalized.firstname ||
            normalized.personname ||
            normalized.name ||
            normalized.fullname ||
            normalized.lastname ||
            '',
        ),
        email: (normalized.emailaddress ?? normalized.email ?? '').toLowerCase(),
      };

      const missing = Object.entries(recipient)
        .filter(([, value]) => !value)
        .map(([key]) => key);
      if (missing.length > 0) {
        console.warn(
          `Skipping spreadsheet row ${rowNumber}: missing ${missing.join(', ')}.`,
        );
        return;
      }
      if (!this.isEmail(recipient.email)) {
        console.warn(
          `Skipping spreadsheet row ${rowNumber}: invalid email "${recipient.email}".`,
        );
        return;
      }
      if (seenEmails.has(recipient.email)) {
        console.warn(
          `Skipping spreadsheet row ${rowNumber}: duplicate email "${recipient.email}".`,
        );
        return;
      }

      seenEmails.add(recipient.email);
      recipients.push(recipient);
    });

    return recipients;
  }

  private parseCsv(content: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;

    for (let index = 0; index < content.length; index += 1) {
      const character = content[index];

      if (quoted) {
        if (character === '"') {
          if (content[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            quoted = false;
          }
        } else {
          field += character;
        }
        continue;
      }

      if (character === '"' && field.length === 0) {
        quoted = true;
      } else if (character === ',') {
        row.push(field);
        field = '';
      } else if (character === '\n' || character === '\r') {
        if (character === '\r' && content[index + 1] === '\n') {
          index += 1;
        }
        row.push(field);
        if (row.some((value) => value.length > 0)) rows.push(row);
        row = [];
        field = '';
      } else {
        field += character;
      }
    }

    if (quoted) throw new Error('The CSV contains an unclosed quoted field.');
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);

    return rows;
  }

  private normalizeHeader(value: string): string {
    return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  }

  /**
   * Spreadsheet exports sometimes contain HTML entities such as `&amp;`.
   * Decode them before handing values to SendGrid, which performs its own
   * escaping. Otherwise `&amp;` becomes `&amp;amp;` in the delivered subject.
   */
  private cleanText(value: string): string {
    return decode(value).replace(/\s+/g, ' ').trim();
  }

  private subjectCompanyName(value: string): string {
    return value.replace(/\s*&\s*/g, ' and ');
  }

  private getConfig(requireApiKey: boolean) {
    const apiKey = process.env.SENDGRID_API_KEY ?? '';
    const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? '';
    const fromName = process.env.SENDGRID_FROM_NAME ?? '';
    const templateId = process.env.SENDGRID_TEMPLATE_ID ?? '';
    const delayMs = Number(process.env.SEND_DELAY_MS ?? '250');

    if (requireApiKey) {
      const missing = [
        ['SENDGRID_API_KEY', apiKey],
        ['SENDGRID_FROM_EMAIL', fromEmail],
        ['SENDGRID_FROM_NAME', fromName],
        ['SENDGRID_TEMPLATE_ID', templateId],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name);

      if (missing.length > 0) {
        throw new Error(`Missing environment variable(s): ${missing.join(', ')}`);
      }
      sgMail.setApiKey(apiKey);
    }

    return {
      fromEmail,
      fromName,
      templateId,
      delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 250,
    };
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
    if (candidate.response?.body) {
      return JSON.stringify(candidate.response.body);
    }
    return candidate.message ?? 'Unknown SendGrid error';
  }
}

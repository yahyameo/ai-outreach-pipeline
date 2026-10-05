import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Lead, LeadDocument } from './schemas/lead.schema';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    @InjectModel(Lead.name) private readonly leads: Model<LeadDocument>,
  ) {}

  async verifyPending(onlyEmails?: string[]): Promise<void> {
    const apiKey = process.env.MAILS_API_KEY?.trim();
    if (!apiKey) throw new Error('MAILS_API_KEY is required.');

    const batchSize = this.positiveInteger('MAILS_BATCH_SIZE', 50, 100);
    while (true) {
      const pending = await this.leads
        .find({
          'verification.status': 'pending',
          ...(onlyEmails?.length
            ? { normalizedEmail: { $in: onlyEmails } }
            : {}),
        })
        .sort({ createdAt: 1 })
        .limit(batchSize)
        .select({ normalizedEmail: 1 })
        .lean();
      if (pending.length === 0) return;

      const emails = pending.map((lead) => lead.normalizedEmail);
      try {
        const response = await axios.post(
          'https://api.mails.so/v1/batch',
          { emails },
          {
            timeout: 30_000,
            headers: {
              'x-mails-api-key': apiKey,
              'content-type': 'application/json',
            },
          },
        );
        const batchId = this.isRecord(response.data)
          ? String(response.data.id ?? '')
          : '';
        const completedPayload =
          this.resultList(response.data).length > 0
            ? response.data
            : await this.waitForBatch(batchId, apiKey);
        const results = this.resultList(completedPayload);
        const byEmail = new Map(
          results
            .map((result) => [this.resultEmail(result), result] as const)
            .filter(([email]) => email.length > 0),
        );

        await Promise.all(
          emails.map((email) => {
            const raw = byEmail.get(email);
            if (!raw) {
              // No row for this address is not a verdict on the mailbox.
              return this.leads.updateOne(
                { normalizedEmail: email },
                {
                  $set: {
                    'verification.status': 'failed',
                    'verification.provider': 'mails.so',
                    'verification.checkedAt': new Date(),
                    'verification.error': `Mails.so batch ${batchId} returned no result for this address.`,
                  },
                },
              );
            }
            return this.leads.updateOne(
              { normalizedEmail: email },
              {
                $set: {
                  'verification.status': this.mapStatus(raw),
                  'verification.provider': 'mails.so',
                  'verification.checkedAt': new Date(),
                  'verification.rawResult': raw,
                },
                $unset: { 'verification.error': 1 },
              },
            );
          }),
        );
      } catch (error) {
        const message = this.errorMessage(error);
        this.logger.error(`Mails.so verification failed: ${message}`);
        await this.leads.updateMany(
          { normalizedEmail: { $in: emails } },
          {
            $set: {
              // A provider/network failure is not a mailbox verdict, so these
              // leads must not become sendable. `failed` is never selected
              // for delivery; retryFailed() puts them back in the queue.
              'verification.status': 'failed',
              'verification.provider': 'mails.so',
              'verification.checkedAt': new Date(),
              'verification.error': message,
            },
          },
        );
        return;
      }
    }
  }

  /**
   * Re-run verification for leads whose check failed (provider outage or a
   * missing result). Returns how many were reset to pending.
   */
  async retryFailed(): Promise<number> {
    const failed = await this.leads
      .find({ 'verification.status': 'failed' })
      .select({ normalizedEmail: 1 })
      .lean();
    if (!failed.length) return 0;
    const emails = failed.map((lead) => lead.normalizedEmail);
    await this.leads.updateMany(
      { normalizedEmail: { $in: emails }, 'verification.status': 'failed' },
      { $set: { 'verification.status': 'pending' } },
    );
    // Only these addresses, so a retry cannot loop over a still-failing set.
    void this.verifyPending(emails).catch((error: unknown) =>
      this.logger.error(`Verification retry failed: ${this.errorMessage(error)}`),
    );
    return emails.length;
  }

  private async waitForBatch(batchId: string, apiKey: string): Promise<unknown> {
    if (!batchId) {
      throw new Error('Mails.so did not return a batch id.');
    }
    const pollMs = this.positiveInteger('MAILS_POLL_INTERVAL_MS', 2_000, 30_000);
    const timeoutMs = this.positiveInteger(
      'MAILS_POLL_TIMEOUT_MS',
      120_000,
      600_000,
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const response = await axios.get(
        `https://api.mails.so/v1/batch/${encodeURIComponent(batchId)}`,
        {
          timeout: 30_000,
          headers: { 'x-mails-api-key': apiKey },
        },
      );
      if (
        this.resultList(response.data).length > 0 &&
        this.isRecord(response.data) &&
        response.data.finished_at
      ) {
        return response.data;
      }
    }
    throw new Error(`Mails.so batch ${batchId} timed out.`);
  }

  private resultList(payload: unknown): Record<string, unknown>[] {
    if (Array.isArray(payload)) return payload.filter(this.isRecord);
    if (!this.isRecord(payload)) return [];
    for (const key of ['data', 'results', 'emails']) {
      const value = payload[key];
      if (Array.isArray(value)) return value.filter(this.isRecord);
    }
    return [];
  }

  private resultEmail(result: Record<string, unknown>): string {
    return String(
      result.email ?? result.address ?? result.email_address ?? '',
    )
      .trim()
      .toLowerCase();
  }

  private mapStatus(
    result: Record<string, unknown>,
  ): 'valid' | 'invalid' | 'risky' | 'unknown' {
    const value = String(
      result.status ??
        result.result ??
        result.verdict ??
        result.state ??
        '',
    ).toLowerCase();
    if (
      result.is_valid === true ||
      result.valid === true ||
      ['valid', 'deliverable', 'safe'].includes(value)
    ) {
      return 'valid';
    }
    if (
      result.is_valid === false ||
      result.valid === false ||
      ['invalid', 'undeliverable', 'do_not_send'].includes(value)
    ) {
      return 'invalid';
    }
    if (
      ['risky', 'catch_all', 'catch-all', 'accept_all', 'accept-all'].includes(
        value,
      )
    ) {
      return 'risky';
    }
    return 'unknown';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private positiveInteger(name: string, fallback: number, maximum: number) {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 && value <= maximum
      ? value
      : fallback;
  }

  private errorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return JSON.stringify(error.response?.data ?? error.message);
    }
    return error instanceof Error ? error.message : String(error);
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ApiKeyGuard } from './api-key.guard';
import { CampaignService } from './campaign.service';
import { LeadImportService } from './lead-import.service';
import { LeadOutreachService } from './lead-outreach.service';
import { LeadReadService } from './lead-read.service';
import { EmailLogReadService, EmailLogListQuery } from './email-log-read.service';
import { EmailVerificationService } from './email-verification.service';
import { LeadSuppressionService } from './lead-suppression.service';
import {
  ApifyImportRequest,
  CampaignRequest,
  TestEmailRequest,
  LeadOutreachRequest,
  LeadOutreachTestRequest,
  LeadListQuery,
} from './outreach.types';

@Controller()
@UseGuards(ApiKeyGuard)
export class OutreachController {
  constructor(
    private readonly imports: LeadImportService,
    private readonly campaigns: CampaignService,
    private readonly leadOutreach: LeadOutreachService,
    private readonly leadRead: LeadReadService,
    private readonly emailLogs: EmailLogReadService,
    private readonly verification: EmailVerificationService,
    private readonly suppression: LeadSuppressionService,
  ) {}

  /** Record an opt-out, e.g. someone who replied "unsubscribe". */
  @Post('unsubscribes')
  @HttpCode(HttpStatus.OK)
  async unsubscribe(@Body() request: { email: string }) {
    try {
      return await this.suppression.unsubscribe(request?.email, 'api');
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  /** Re-verify leads whose mailbox check failed (provider outage). */
  @Post('lead-verifications/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retryVerification() {
    try {
      return { reset: await this.verification.retryFailed() };
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Post('lead-imports/apify')
  @HttpCode(HttpStatus.ACCEPTED)
  async importFromApify(@Body() request: ApifyImportRequest) {
    try {
      return await this.imports.create(request);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Get('lead-imports/:jobId')
  async getImport(@Param('jobId') jobId: string) {
    try {
      return await this.imports.get(jobId);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Get('leads')
  async listLeads(@Query() query: LeadListQuery) {
    try {
      return await this.leadRead.list(query);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Get('leads/:leadId')
  async getLead(@Param('leadId') leadId: string) {
    try {
      return await this.leadRead.get(leadId);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Get('email-logs')
  async listEmailLogs(@Query() query: EmailLogListQuery) {
    try {
      return await this.emailLogs.list(query);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Get('email-logs/:logId')
  async getEmailLog(@Param('logId') logId: string) {
    try {
      return await this.emailLogs.get(logId);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Post('leads/:leadId/outreach')
  @HttpCode(HttpStatus.OK)
  async outreachLead(
    @Param('leadId') leadId: string,
    @Body() request: LeadOutreachRequest,
  ) {
    try {
      return await this.leadOutreach.run(leadId, request ?? {});
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Post('leads/:leadId/outreach/test')
  @HttpCode(HttpStatus.OK)
  async testOutreachLead(
    @Param('leadId') leadId: string,
    @Body() request: LeadOutreachTestRequest,
  ) {
    try {
      return await this.leadOutreach.sendTest(leadId, request);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Post('email-campaigns')
  @HttpCode(HttpStatus.ACCEPTED)
  async createCampaign(@Body() request: CampaignRequest) {
    try {
      return await this.campaigns.create(request);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  @Post('email-campaigns/test')
  @HttpCode(HttpStatus.OK)
  async sendTestEmail(@Body() request: TestEmailRequest) {
    try {
      return await this.campaigns.sendTest(request);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }

  private message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

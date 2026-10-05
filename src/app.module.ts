import { Module } from '@nestjs/common';

import { EmailCampaignService } from './email-campaign.service';

@Module({
  providers: [EmailCampaignService],
})
export class AppModule {}

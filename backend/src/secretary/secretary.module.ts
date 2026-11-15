import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { OverviewModule } from '../overview/overview.module.js';
import { StatementService } from './statement.service.js';
import { NotesService } from './notes.service.js';
import { SecretaryController } from './secretary.controller.js';
import { SecretaryService } from './secretary.service.js';

@Module({
  imports: [OverviewModule, BillingModule],
  controllers: [SecretaryController],
  providers: [SecretaryService, NotesService, StatementService],
  exports: [SecretaryService],
})
export class SecretaryModule {}

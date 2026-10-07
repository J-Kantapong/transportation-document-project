import { Module } from '@nestjs/common';
import { OverviewModule } from '../overview/overview.module.js';
import { NotesService } from './notes.service.js';
import { SecretaryController } from './secretary.controller.js';
import { SecretaryService } from './secretary.service.js';

@Module({
  imports: [OverviewModule],
  controllers: [SecretaryController],
  providers: [SecretaryService, NotesService],
  exports: [SecretaryService],
})
export class SecretaryModule {}

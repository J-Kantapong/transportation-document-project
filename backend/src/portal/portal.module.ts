import { Module } from '@nestjs/common';
import { PortalController } from './portal.controller.js';
import { PortalService } from './portal.service.js';

@Module({
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}

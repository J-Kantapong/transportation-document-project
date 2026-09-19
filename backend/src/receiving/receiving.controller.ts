import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ReceivingService } from './receiving.service.js';

@Controller('api/vehicles')
export class ReceivingController {
  constructor(private readonly receivingService: ReceivingService) {}

  @Get('receiving/:step/pending')
  async listPending(@Param('step') step: string) {
    return { vehicles: await this.receivingService.listPending(step) };
  }

  @Get('receiving/:step/completed')
  async listCompleted(@Param('step') step: string) {
    return { vehicles: await this.receivingService.listCompleted(step) };
  }

  @Patch(':id/receiving/:step')
  async markDone(@Param('id') id: string, @Param('step') step: string, @Body() body: { date?: unknown; recipient?: unknown; note?: unknown }) {
    return { vehicle: await this.receivingService.markDone(id, step, body) };
  }
}

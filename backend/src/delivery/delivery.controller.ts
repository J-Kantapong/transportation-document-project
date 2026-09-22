import { Body, Controller, Get, Post } from '@nestjs/common';
import { DeliveryService } from './delivery.service.js';

@Controller('api/delivery')
export class DeliveryController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @Get('queue')
  async queue() {
    return { vehicles: await this.deliveryService.queue() };
  }

  @Get('recent')
  async recent() {
    return { vehicles: await this.deliveryService.recent() };
  }

  @Post()
  submit(@Body() body: { vehicleIds?: unknown; date?: unknown; recipient?: unknown; note?: unknown }) {
    return this.deliveryService.submit(body);
  }
}

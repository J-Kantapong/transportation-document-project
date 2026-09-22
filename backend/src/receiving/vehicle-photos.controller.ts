import { Controller, Get, Query } from '@nestjs/common';
import { VehiclePhotosService } from './vehicle-photos.service.js';

// GET /api/vehicles/receiving/photos?chassis=... - อยู่ใต้ receiving/ เพื่อใช้กฎสิทธิ์เดียวกับคิวรับของ (SUBMIT_READ ใน access-policy.ts)
@Controller('api/vehicles/receiving')
export class VehiclePhotosController {
  constructor(private readonly service: VehiclePhotosService) {}

  @Get('photos')
  async search(@Query('chassis') chassis = '') {
    return { vehicles: await this.service.searchByChassis(chassis) };
  }
}

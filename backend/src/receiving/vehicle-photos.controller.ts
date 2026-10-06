import { Controller, Get, Query } from '@nestjs/common';
import { VehiclePhotosService } from './vehicle-photos.service.js';

// GET /api/vehicles/receiving/photos?chassis=... - อยู่ใต้ receiving/ เพื่อใช้กฎสิทธิ์เดียวกับคิวรับของ (SUBMIT_READ ใน access-policy.ts)
@Controller('api/vehicles/receiving')
export class VehiclePhotosController {
  constructor(private readonly service: VehiclePhotosService) {}

  // ?vehicleId= = รถคันเดียว (ปุ่ม "รูป" ในหน้าค้นหารถ) / ?chassis= = ค้นด้วยเลขตัวถัง
  @Get('photos')
  async search(@Query('chassis') chassis = '', @Query('vehicleId') vehicleId = '') {
    if (vehicleId) return { vehicles: [await this.service.findByVehicleId(vehicleId)] };
    return { vehicles: await this.service.searchByChassis(chassis) };
  }
}

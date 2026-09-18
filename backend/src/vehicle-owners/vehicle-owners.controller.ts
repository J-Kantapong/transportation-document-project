import { Body, Controller, Get, Post } from '@nestjs/common';
import type { CreateVehicleOwnerDto } from './dto/create-vehicle-owner.dto.js';
import { VehicleOwnersService } from './vehicle-owners.service.js';

@Controller('api/vehicle-owners')
export class VehicleOwnersController {
  constructor(private readonly vehicleOwnersService: VehicleOwnersService) {}

  @Get()
  async findAll() {
    return { owners: await this.vehicleOwnersService.findAll() };
  }

  @Post()
  create(@Body() body: CreateVehicleOwnerDto) {
    return this.vehicleOwnersService.create(body);
  }
}

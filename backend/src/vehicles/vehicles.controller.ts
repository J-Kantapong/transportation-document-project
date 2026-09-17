import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { CreateVehiclesDto } from './dto/create-vehicles.dto.js';
import type { UpdateTransferNoticeDto } from './dto/update-transfer-notice.dto.js';
import type { UpdateInspectionDto } from './dto/update-inspection.dto.js';
import { VehiclesService } from './vehicles.service.js';

@Controller('api/vehicles')
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get()
  async findAll() {
    return { vehicles: await this.vehiclesService.findAll() };
  }

  @Post()
  create(@Body() body: CreateVehiclesDto) {
    return this.vehiclesService.createBatch(body);
  }

  @Get('transfer-notice')
  async findForTransferNotice(@Query('date') date: string) {
    return { vehicles: await this.vehiclesService.findForTransferNotice(date) };
  }

  @Patch(':id/transfer-notice')
  async updateTransferNotice(@Param('id') id: string, @Body() body: UpdateTransferNoticeDto) {
    return { vehicle: await this.vehiclesService.updateTransferNotice(id, body) };
  }

  @Get('inspection')
  async findForInspection(@Query('date') date: string) {
    return { vehicles: await this.vehiclesService.findForInspection(date) };
  }

  @Patch(':id/inspection')
  async updateInspection(@Param('id') id: string, @Body() body: UpdateInspectionDto) {
    return { vehicle: await this.vehiclesService.updateInspection(id, body) };
  }
}

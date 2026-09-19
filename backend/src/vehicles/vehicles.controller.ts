import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { CreateVehiclesDto } from './dto/create-vehicles.dto.js';
import type { UpdateTransferNoticeDto } from './dto/update-transfer-notice.dto.js';
import type { UpdateInspectionSentDto } from './dto/update-inspection-sent.dto.js';
import type { UpdateInspectionResultDto } from './dto/update-inspection-result.dto.js';
import type { UpdateVehicleDto } from './dto/update-vehicle.dto.js';
import type { UpdateTaxInputDto } from '../tax/dto/update-tax-input.dto.js';
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

  // ยื่นเอกสารจดทะเบียน (Step 4): คิวรถที่ยื่นได้ ณ วันที่ยื่น (submitDate ค.ศ. YYYY-MM-DD, ไม่ส่ง = วันนี้)
  @Get('submission-queue')
  async submissionQueue(@Query('submitDate') submitDate?: string) {
    return { vehicles: await this.vehiclesService.findSubmissionQueue(submitDate) };
  }

  // ยื่นเอกสารจดทะเบียน (Step 4): ค้นหาด้วยเลขตัวถังเพื่อดูว่าทำไมรถคันนั้นไม่อยู่ในคิว (submitBlockReason)
  @Get('search')
  async search(@Query('chassis') chassis = '', @Query('submitDate') submitDate?: string) {
    return { vehicles: await this.vehiclesService.searchByChassis(chassis, submitDate) };
  }

  @Post('lookup-by-chassis')
  lookupByChassis(@Body() body: { chassisList?: unknown; submitDate?: unknown }) {
    const chassisList = Array.isArray(body?.chassisList) ? body.chassisList.filter((c): c is string => typeof c === 'string') : [];
    return this.vehiclesService.lookupByChassis(chassisList, typeof body?.submitDate === 'string' ? body.submitDate : undefined);
  }

  @Patch(':id')
  updateVehicle(@Param('id') id: string, @Body() body: UpdateVehicleDto) {
    return this.vehiclesService.updateVehicle(id, body);
  }

  @Get('transfer-notice/pending')
  async findPendingTransferNotice() {
    return { vehicles: await this.vehiclesService.findPendingTransferNotice() };
  }

  @Get('transfer-notice/completed')
  async findRecentlyCompletedTransferNotice() {
    return { vehicles: await this.vehiclesService.findRecentlyCompletedTransferNotice() };
  }

  @Patch(':id/transfer-notice')
  async updateTransferNotice(@Param('id') id: string, @Body() body: UpdateTransferNoticeDto) {
    return { vehicle: await this.vehiclesService.updateTransferNotice(id, body) };
  }

  @Get('inspection/pending-send')
  async findPendingInspectionSend() {
    return { vehicles: await this.vehiclesService.findPendingInspectionSend() };
  }

  @Get('inspection/pending-result')
  async findPendingInspectionResult() {
    return { vehicles: await this.vehiclesService.findPendingInspectionResult() };
  }

  @Get('inspection/completed')
  async findRecentlyCompletedInspection() {
    return { vehicles: await this.vehiclesService.findRecentlyCompletedInspection() };
  }

  @Patch(':id/inspection-sent')
  async updateInspectionSent(@Param('id') id: string, @Body() body: UpdateInspectionSentDto) {
    return { vehicle: await this.vehiclesService.updateInspectionSent(id, body) };
  }

  @Patch(':id/inspection-result')
  async updateInspectionResult(@Param('id') id: string, @Body() body: UpdateInspectionResultDto) {
    return { vehicle: await this.vehiclesService.updateInspectionResult(id, body) };
  }

  @Patch(':id/tax-input')
  async updateTaxInput(@Param('id') id: string, @Body() body: UpdateTaxInputDto) {
    return { taxCalculation: await this.vehiclesService.updateTaxInput(id, body) };
  }
}

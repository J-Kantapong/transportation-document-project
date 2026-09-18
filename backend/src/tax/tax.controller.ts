import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { TaxPreviewDto } from './dto/tax-preview.dto.js';
import { TaxService } from './tax.service.js';

@Controller('api')
export class TaxController {
  constructor(private readonly taxService: TaxService) {}

  @Post('tax-calculations/preview')
  preview(@Body() body: TaxPreviewDto) {
    return this.taxService.preview(body);
  }

  @Get('vehicles/:id/tax-calculations')
  async listForVehicle(@Param('id') id: string) {
    return { taxCalculations: await this.taxService.listForVehicle(id) };
  }
}

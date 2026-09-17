import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { CreateYamahaRelocationEntryDto } from './dto/create-yamaha-relocation-entry.dto.js';
import { YamahaRelocationService } from './yamaha-relocation.service.js';

@Controller('api/yamaha-relocation')
export class YamahaRelocationController {
  constructor(private readonly yamahaRelocationService: YamahaRelocationService) {}

  @Get()
  findForMonth(@Query('size') size: string, @Query('month') month: string) {
    return this.yamahaRelocationService.findForMonth(size, month);
  }

  @Post()
  create(@Body() body: CreateYamahaRelocationEntryDto) {
    return this.yamahaRelocationService.create(body);
  }
}

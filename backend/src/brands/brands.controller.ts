import { Body, Controller, Get, Post } from '@nestjs/common';
import { BrandsService } from './brands.service.js';
import type { CreateBrandDto } from './dto/create-brand.dto.js';

@Controller('api/brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Get()
  async findAll() {
    return { brands: await this.brandsService.findAll() };
  }

  @Post()
  create(@Body() body: CreateBrandDto) {
    return this.brandsService.create(body);
  }
}

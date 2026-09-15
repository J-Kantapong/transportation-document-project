import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateBrandDto } from './dto/create-brand.dto.js';

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.brand.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  async create(body: CreateBrandDto): Promise<{ brand: { id: string; name: string } }> {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) {
      throw new BadRequestException({ error: 'กรุณากรอกชื่อยี่ห้อไม่เกิน 100 ตัวอักษร' });
    }

    const brand = await this.prisma.brand.upsert({
      where: { name },
      create: { name },
      update: {},
      select: { id: true, name: true },
    });

    return { brand };
  }
}

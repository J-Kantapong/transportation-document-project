import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateBrandDto } from './dto/create-brand.dto.js';

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.brand.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true },
    });
  }

  async create(body: CreateBrandDto): Promise<{ brand: { id: string; name: string } }> {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) {
      throw new BadRequestException({ error: 'กรุณากรอกชื่อยี่ห้อไม่เกิน 100 ตัวอักษร' });
    }

    // ชื่อซ้ำต่างตัวพิมพ์ (เช่น "BENZ" กับ "Benz") = ยี่ห้อเดิม คืนแถวที่มีอยู่แล้วแทนการสร้างใหม่ (พบ 2026-09-27: เคยได้ยี่ห้อซ้ำ
    // ที่ลบไม่ได้ ตารางราคาไม่เจอจึงตกไปใช้ราคา "อื่นๆ" และนำเข้าไฟล์ด้วยชื่อแล้วขึ้น "ชื่อยี่ห้อซ้ำ")
    const existing = await this.prisma.brand.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true },
    });
    if (existing) return { brand: existing };

    const brand = await this.prisma.brand.upsert({
      where: { name },
      create: { name },
      update: {},
      select: { id: true, name: true },
    });

    return { brand };
  }
}

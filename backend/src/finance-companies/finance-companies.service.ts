// บริษัทไฟแนนซ์ - รายชื่อที่ผู้ใช้กำหนดเอง (เพิ่มจากหน้าเพิ่มข้อมูลรถจดใหม่เหมือน "+ เพิ่มยี่ห้อ") ไม่มี seed
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateFinanceCompanyDto } from './dto/create-finance-company.dto.js';

@Injectable()
export class FinanceCompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.financeCompany.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true },
    });
  }

  async create(body: CreateFinanceCompanyDto): Promise<{ financeCompany: { id: string; name: string } }> {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) {
      throw new BadRequestException({ error: 'กรุณากรอกชื่อไฟแนนซ์ไม่เกิน 100 ตัวอักษร' });
    }

    const financeCompany = await this.prisma.financeCompany.upsert({
      where: { name },
      create: { name },
      update: {},
      select: { id: true, name: true },
    });

    return { financeCompany };
  }
}

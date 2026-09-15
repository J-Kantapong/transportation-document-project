import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateCustomerDto } from './dto/create-customer.dto.js';

const CUSTOMER_FIELDS = ['name', 'company', 'branch', 'address', 'taxId', 'phone', 'email'] as const;
type CustomerField = (typeof CUSTOMER_FIELDS)[number];

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.customer.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async create(body: CreateCustomerDto): Promise<{ id: string }> {
    if (!body || typeof body !== 'object' || !CUSTOMER_FIELDS.every((key) => typeof body[key] === 'string')) {
      throw new BadRequestException({ error: 'กรุณาตรวจสอบข้อมูลลูกค้า' });
    }

    const values = Object.fromEntries(
      CUSTOMER_FIELDS.map((key) => [key, (body[key] as string).trim()]),
    ) as Record<CustomerField, string>;

    if (!values.name || CUSTOMER_FIELDS.some((key) => values[key].length > (key === 'address' ? 2000 : 250))) {
      throw new BadRequestException({ error: 'กรุณากรอกชื่อลูกค้าและตรวจสอบความยาวข้อมูล' });
    }
    if (values.taxId && !/^\d{13}$/.test(values.taxId)) {
      throw new BadRequestException({ error: 'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' });
    }
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
      throw new BadRequestException({ error: 'กรุณาตรวจสอบอีเมล' });
    }

    const customer = await this.prisma.customer.create({
      data: {
        name: values.name,
        company: values.company || null,
        branch: values.branch || null,
        address: values.address || null,
        taxId: values.taxId || null,
        phone: values.phone || null,
        email: values.email || null,
      },
      select: { id: true },
    });

    return { id: customer.id };
  }
}

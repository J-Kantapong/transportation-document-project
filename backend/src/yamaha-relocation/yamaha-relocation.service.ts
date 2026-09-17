import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { YamahaRelocationSize } from '../generated/prisma/enums.js';
import { calculateYamahaRelocationFees } from './yamaha-relocation-fee.js';
import { CreateYamahaRelocationEntryDto } from './dto/create-yamaha-relocation-entry.dto.js';

function isValidDateParam(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
}

function isValidMonthParam(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}-01`));
}

function isSize(value: unknown): value is YamahaRelocationSize {
  return value === YamahaRelocationSize.SMALL || value === YamahaRelocationSize.LARGE;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function serializeEntry(entry: {
  id: string;
  date: Date;
  size: YamahaRelocationSize;
  count: number;
  billFee: unknown;
  noBillFee: unknown;
  createdAt: Date;
}) {
  return {
    id: entry.id,
    date: entry.date.toISOString().slice(0, 10),
    size: entry.size,
    count: entry.count,
    billFee: String(entry.billFee),
    noBillFee: String(entry.noBillFee),
    createdAt: entry.createdAt.toISOString(),
  };
}

@Injectable()
export class YamahaRelocationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateYamahaRelocationEntryDto) {
    const dateRaw = typeof dto?.date === 'string' ? dto.date.trim() : '';

    if (!isValidDateParam(dateRaw)) {
      throw new BadRequestException({ error: 'กรุณาระบุวันที่ให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    }
    if (!isSize(dto?.size)) {
      throw new BadRequestException({ error: 'กรุณาระบุขนาดรถ (รถเล็ก/รถใหญ่)' });
    }
    if (!isPositiveInt(dto?.count)) {
      throw new BadRequestException({ error: 'กรุณาระบุจำนวนคันเป็นจำนวนเต็มตั้งแต่ 1' });
    }

    const { billFee, noBillFee } = calculateYamahaRelocationFees(dto.size, dto.count);

    const entry = await this.prisma.yamahaRelocationEntry.create({
      data: {
        date: new Date(`${dateRaw}T00:00:00.000Z`),
        size: dto.size,
        count: dto.count,
        billFee,
        noBillFee,
      },
    });

    return { entry: serializeEntry(entry) };
  }

  async findForMonth(sizeParam: string, monthParam: string) {
    if (!isSize(sizeParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ size ต้องเป็น SMALL หรือ LARGE' });
    }
    if (!isValidMonthParam(monthParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ month ต้องเป็น ค.ศ. YYYY-MM ที่ถูกต้อง' });
    }

    const monthStart = new Date(`${monthParam}-01T00:00:00.000Z`);
    const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));

    const entries = await this.prisma.yamahaRelocationEntry.findMany({
      where: { size: sizeParam, date: { gte: monthStart, lt: monthEnd } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    const summary = entries.reduce(
      (acc, entry) => {
        acc.totalCount += entry.count;
        acc.billFee += Number(entry.billFee);
        acc.noBillFee += Number(entry.noBillFee);
        return acc;
      },
      { totalCount: 0, billFee: 0, noBillFee: 0 },
    );

    return {
      entries: entries.map(serializeEntry),
      summary: {
        ...summary,
        totalFee: summary.billFee + summary.noBillFee,
      },
    };
  }
}

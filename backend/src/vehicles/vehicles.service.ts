import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateVehiclesDto } from './dto/create-vehicles.dto.js';
import { getVehicleRowErrors, normalizeVehicleRow, NormalizedVehicleRow } from './vehicle-validation.js';

interface VehicleRowError {
  row: number;
  errors: string[];
}

const MAX_BATCH_SIZE = 100;

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: {
        customer: { select: { name: true } },
        brand: { select: { name: true } },
      },
    });

    return vehicles.map((vehicle) => ({
      id: vehicle.id,
      date: vehicle.date.toISOString().slice(0, 10),
      customerId: vehicle.customerId,
      chassis: vehicle.chassis,
      engine: vehicle.engine,
      brandId: vehicle.brandId,
      fuel: vehicle.fuel,
      cc: vehicle.cc,
      weight: vehicle.weight,
      color: vehicle.color,
      body: vehicle.body,
      registrationProvince: vehicle.registrationProvince,
      ownerProvince: vehicle.ownerProvince,
      createdAt: vehicle.createdAt,
      customerName: vehicle.customer.name,
      brandName: vehicle.brand.name,
    }));
  }

  async createBatch(body: CreateVehiclesDto): Promise<{ count: number }> {
    const input = Array.isArray(body?.vehicles) ? (body.vehicles as Record<string, unknown>[]) : null;
    if (!input || input.length < 1 || input.length > MAX_BATCH_SIZE) {
      throw new BadRequestException({ error: 'รองรับ 1–100 รายการต่อครั้ง' });
    }

    const [customers, brands] = await Promise.all([
      this.prisma.customer.findMany({ select: { id: true } }),
      this.prisma.brand.findMany({ select: { id: true } }),
    ]);
    const customerIds = new Set(customers.map((c) => c.id));
    const brandIds = new Set(brands.map((b) => b.id));

    const rowErrors: VehicleRowError[] = [];
    const seenChassis = new Set<string>();
    const rows: NormalizedVehicleRow[] = [];

    input.forEach((raw, index) => {
      const normalized = normalizeVehicleRow(raw);
      const errors = getVehicleRowErrors(normalized);

      if (!customerIds.has(normalized.customerId)) errors.push('ไม่พบลูกค้าในฐานข้อมูล');
      if (!brandIds.has(normalized.brandId)) errors.push('ไม่พบยี่ห้อในฐานข้อมูล');
      if (seenChassis.has(normalized.chassis)) errors.push('เลขตัวถังซ้ำในชุดข้อมูล');
      seenChassis.add(normalized.chassis);

      if (errors.length) rowErrors.push({ row: index + 1, errors });
      rows.push(normalized);
    });

    if (rowErrors.length) {
      throw new BadRequestException({ error: 'กรุณาแก้ไขข้อมูลก่อนบันทึก', errors: rowErrors });
    }

    const existing = await this.prisma.vehicle.findMany({
      where: { chassis: { in: rows.map((row) => row.chassis) } },
      select: { chassis: true },
    });
    if (existing.length) {
      const existingChassis = new Set(existing.map((v) => v.chassis));
      const conflicts = rows
        .map((row, index) => ({ row: index + 1, chassis: row.chassis }))
        .filter((entry) => existingChassis.has(entry.chassis));
      throw new ConflictException({
        error: `เลขตัวถัง ${conflicts[0].chassis} มีอยู่แล้ว`,
        errors: conflicts.map((entry) => ({ row: entry.row, errors: ['เลขตัวถังมีอยู่แล้ว'] })),
      });
    }

    await this.prisma.$transaction(rows.map((row) => this.prisma.vehicle.create({ data: this.toCreateData(row) })));

    return { count: rows.length };
  }

  private toCreateData(row: NormalizedVehicleRow) {
    return {
      date: new Date(`${row.date}T00:00:00.000Z`),
      customerId: row.customerId,
      chassis: row.chassis,
      engine: row.engine || null,
      brandId: row.brandId,
      fuel: row.fuel || null,
      cc: row.cc === '' ? null : row.cc,
      weight: row.weight === '' ? null : row.weight,
      color: row.color || null,
      body: row.body || null,
      registrationProvince: row.registrationProvince || null,
      ownerProvince: row.ownerProvince || null,
    };
  }
}

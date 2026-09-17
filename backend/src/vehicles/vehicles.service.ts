import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateVehiclesDto } from './dto/create-vehicles.dto.js';
import { UpdateTransferNoticeDto } from './dto/update-transfer-notice.dto.js';
import { UpdateInspectionDto } from './dto/update-inspection.dto.js';
import { getVehicleRowErrors, normalizeVehicleRow, NormalizedVehicleRow } from './vehicle-validation.js';

interface VehicleRowError {
  row: number;
  errors: string[];
}

const MAX_BATCH_SIZE = 100;

type TransferStatus = 'ตัดบัญชี' | 'แจ้งย้าย';

// Status is derived from จังหวัดที่จดทะเบียน, not stored — Bangkok registrations
// go through ตัดบัญชี, every other province goes through แจ้งย้าย. Mirrors
// frontend/src/lib/vehicle-reference-data.ts#getVehicleStatus.
function getTransferStatus(registrationProvince: string | null): TransferStatus | null {
  if (!registrationProvince) return null;
  return registrationProvince === 'กรุงเทพมหานคร' ? 'ตัดบัญชี' : 'แจ้งย้าย';
}

function isValidDateParam(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
}

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

  async findForTransferNotice(dateParam: string) {
    if (!isValidDateParam(dateParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ date ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }

    const [vehicles, deregistrationFees, relocateFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { date: new Date(`${dateParam}T00:00:00.000Z`) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.feeDeregistration.findMany(),
      this.prisma.feeRelocate.findMany(),
    ]);

    return vehicles.map((vehicle) => {
      const status = getTransferStatus(vehicle.registrationProvince);
      const suggestedCost = this.suggestTransferCost(status, vehicle.body, vehicle.brand.name, deregistrationFees, relocateFees);

      return {
        id: vehicle.id,
        date: vehicle.date.toISOString().slice(0, 10),
        customerName: vehicle.customer.name,
        chassis: vehicle.chassis,
        brandName: vehicle.brand.name,
        body: vehicle.body,
        registrationProvince: vehicle.registrationProvince,
        status,
        suggestedCost,
        transferDone: vehicle.transferDone,
        transferCompletedDate: vehicle.transferCompletedDate?.toISOString().slice(0, 10) ?? null,
        transferCost: vehicle.transferCost,
      };
    });
  }

  private suggestTransferCost(
    status: TransferStatus | null,
    body: string | null,
    brandName: string,
    deregistrationFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    relocateFees: Array<{ vehicleType: string; brand: string; noBillAmount: unknown; billAmount: unknown }>,
  ): string | null {
    if (!status || !body) return null;

    if (status === 'ตัดบัญชี') {
      const row = deregistrationFees.find((f) => f.vehicleType === body && f.brand === brandName)
        ?? deregistrationFees.find((f) => f.vehicleType === body && f.brand === 'อื่นๆ');
      return row ? String(row.amount) : null;
    }

    const row = relocateFees.find((f) => f.vehicleType === body && f.brand === brandName)
      ?? relocateFees.find((f) => f.vehicleType === body && f.brand === 'อื่นๆ');
    return row ? String(Number(row.noBillAmount) + Number(row.billAmount)) : null;
  }

  async updateTransferNotice(id: string, dto: UpdateTransferNoticeDto) {
    const done = Boolean(dto?.done);
    const completedDateRaw = typeof dto?.completedDate === 'string' ? dto.completedDate.trim() : '';
    const costRaw = typeof dto?.cost === 'string' ? dto.cost.trim() : '';

    if (completedDateRaw && !isValidDateParam(completedDateRaw)) {
      throw new BadRequestException({ error: 'วันที่เสร็จต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    if (costRaw && !/^\d+(\.\d+)?$/.test(costRaw)) {
      throw new BadRequestException({ error: 'ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0' });
    }

    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

    const updated = await this.prisma.vehicle.update({
      where: { id },
      data: {
        transferDone: done,
        transferCompletedDate: completedDateRaw ? new Date(`${completedDateRaw}T00:00:00.000Z`) : null,
        transferCost: costRaw ? costRaw : null,
      },
    });

    return {
      id: updated.id,
      transferDone: updated.transferDone,
      transferCompletedDate: updated.transferCompletedDate?.toISOString().slice(0, 10) ?? null,
      transferCost: updated.transferCost,
    };
  }

  async findForInspection(dateParam: string) {
    if (!isValidDateParam(dateParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ date ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }

    const [vehicles, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { date: new Date(`${dateParam}T00:00:00.000Z`), transferDone: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);

    return vehicles.map((vehicle) => {
      const suggestedCost = this.suggestInspectionCost(
        vehicle.registrationProvince,
        vehicle.body,
        vehicle.brand.name,
        bangkokFees,
        provinceFees,
      );

      return {
        id: vehicle.id,
        date: vehicle.date.toISOString().slice(0, 10),
        customerName: vehicle.customer.name,
        chassis: vehicle.chassis,
        brandName: vehicle.brand.name,
        body: vehicle.body,
        registrationProvince: vehicle.registrationProvince,
        suggestedCost,
        inspectionDone: vehicle.inspectionDone,
        inspectionCompletedDate: vehicle.inspectionCompletedDate?.toISOString().slice(0, 10) ?? null,
        inspectionCost: vehicle.inspectionCost,
      };
    });
  }

  private suggestInspectionCost(
    registrationProvince: string | null,
    body: string | null,
    brandName: string,
    bangkokFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    provinceFees: Array<{ province: string; vehicleType: string; amount: unknown }>,
  ): string | null {
    if (!registrationProvince || !body) return null;

    if (registrationProvince === 'กรุงเทพมหานคร') {
      const row = bangkokFees.find((f) => f.vehicleType === body && f.brand === brandName)
        ?? bangkokFees.find((f) => f.vehicleType === body && f.brand === 'อื่นๆ');
      return row ? String(row.amount) : null;
    }

    const row = provinceFees.find((f) => f.province === registrationProvince && f.vehicleType === body);
    return row?.amount != null ? String(row.amount) : null;
  }

  async updateInspection(id: string, dto: UpdateInspectionDto) {
    const done = Boolean(dto?.done);
    const completedDateRaw = typeof dto?.completedDate === 'string' ? dto.completedDate.trim() : '';
    const costRaw = typeof dto?.cost === 'string' ? dto.cost.trim() : '';

    if (completedDateRaw && !isValidDateParam(completedDateRaw)) {
      throw new BadRequestException({ error: 'วันที่เสร็จต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    if (costRaw && !/^\d+(\.\d+)?$/.test(costRaw)) {
      throw new BadRequestException({ error: 'ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0' });
    }

    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

    const updated = await this.prisma.vehicle.update({
      where: { id },
      data: {
        inspectionDone: done,
        inspectionCompletedDate: completedDateRaw ? new Date(`${completedDateRaw}T00:00:00.000Z`) : null,
        inspectionCost: costRaw ? costRaw : null,
      },
    });

    return {
      id: updated.id,
      inspectionDone: updated.inspectionDone,
      inspectionCompletedDate: updated.inspectionCompletedDate?.toISOString().slice(0, 10) ?? null,
      inspectionCost: updated.inspectionCost,
    };
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

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateVehiclesDto } from './dto/create-vehicles.dto.js';
import { UpdateTransferNoticeDto } from './dto/update-transfer-notice.dto.js';
import { UpdateInspectionSentDto } from './dto/update-inspection-sent.dto.js';
import { UpdateInspectionResultDto } from './dto/update-inspection-result.dto.js';
import { UpdateVehicleDto } from './dto/update-vehicle.dto.js';
import { getVehicleRowErrors, normalizeVehicleRow, NormalizedVehicleRow } from './vehicle-validation.js';
import { TaxService } from '../tax/tax.service.js';
import { UpdateTaxInputDto } from '../tax/dto/update-tax-input.dto.js';
import { parseTaxDate } from '../tax/tax-validation.js';

const EDITABLE_VEHICLE_FIELDS = [
  ['date', 'วันที่'],
  ['customerId', 'ลูกค้า'],
  ['chassis', 'เลขตัวถัง'],
  ['engine', 'เลขเครื่อง'],
  ['brandId', 'ยี่ห้อ'],
  ['fuel', 'ประเภทเชื้อเพลิง'],
  ['cc', 'ขนาด CC'],
  ['weight', 'น้ำหนักรถ'],
  ['color', 'สี'],
  ['body', 'ประเภทรถ'],
  ['registrationProvince', 'จังหวัดที่จดทะเบียน'],
  ['ownerProvince', 'จังหวัดเจ้าของรถ'],
] as const;

// ตรวจรอบ 1 ผ่านวันนี้หรือก่อนหน้านี้ = ครบกำหนดตรวจรอบ 2 แล้ว
function round2Threshold(): Date {
  const threshold = new Date();
  threshold.setUTCDate(threshold.getUTCDate() - INSPECTION_ROUND2_WAIT_DAYS);
  return threshold;
}

function isRound2Due(vehicle: { inspectionRound: number; inspectionResult: string | null; inspectionResultDate: Date | null }) {
  return (
    vehicle.inspectionRound === 1 &&
    vehicle.inspectionResult === 'ผ่าน' &&
    vehicle.inspectionResultDate != null &&
    vehicle.inspectionResultDate <= round2Threshold()
  );
}

function diffField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

interface VehicleRowError {
  row: number;
  errors: string[];
}

const MAX_BATCH_SIZE = 1000;

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

const INSPECTION_SENT_TYPES = ['ส่งตรวจนอก', 'เอารถมาตรวจเอง'] as const;
const INSPECTION_RESULTS = ['ผ่าน', 'ไม่ผ่าน'] as const;

// ตรวจรถรอบ 2: รอบ 1 ผ่านครบ 90 วันแล้วรถกลับเข้าคิวส่งตรวจเอง - ค่าใช้จ่ายแยก 2 ส่วน คือราคาตรวจรถ (No bill)
// ตามตารางเดิม และค่าตรวจรถ (Bill) 50 บาท
const INSPECTION_ROUND2_WAIT_DAYS = 90;
const INSPECTION_ROUND2_BILL_FEE = 50;

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxService: TaxService,
  ) {}

  private readonly vehicleFullInclude = {
    customer: { select: { name: true } },
    brand: { select: { name: true } },
    owner: { select: { id: true, name: true, ownerType: true } },
    // แค่แถวล่าสุด 1 แถวพอ - ใช้เช็คว่ารถคันนี้ยื่นเอกสารซ้ำได้ไหม (ดู DocumentSubmission.status
    // ใน schema.prisma - ยื่นซ้ำไม่ได้ตราบใดที่แถวล่าสุดยังค้าง PENDING)
    documentSubmissions: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { status: true } },
  } as const;

  private mapVehicleFull(vehicle: {
    id: string;
    date: Date;
    customerId: string;
    chassis: string;
    engine: string | null;
    brandId: string;
    fuel: string | null;
    cc: unknown;
    weight: unknown;
    color: string | null;
    body: string | null;
    registrationProvince: string | null;
    ownerProvince: string | null;
    createdAt: Date;
    customer: { name: string };
    brand: { name: string };
    firstRegistrationDate: Date | null;
    isFactoryNew: boolean | null;
    ownerId: string | null;
    owner: { name: string | null; ownerType: string } | null;
    plateCategory: string | null;
    plateNumber: string | null;
    documentSubmissions: Array<{ status: string }>;
  }) {
    return {
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
      // Step 4: ยื่นเอกสารจดทะเบียน - ดู tax.controller.ts (preview/tax-input) สำหรับการคำนวณจริง
      firstRegistrationDate: vehicle.firstRegistrationDate?.toISOString().slice(0, 10) ?? null,
      isFactoryNew: vehicle.isFactoryNew,
      ownerId: vehicle.ownerId,
      ownerName: vehicle.owner?.name ?? null,
      ownerType: vehicle.owner?.ownerType ?? null,
      plateCategory: vehicle.plateCategory,
      plateNumber: vehicle.plateNumber,
      pendingDocumentSubmission: vehicle.documentSubmissions[0]?.status === 'PENDING',
    };
  }

  async findAll() {
    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: this.vehicleFullInclude,
    });
    return vehicles.map((vehicle) => this.mapVehicleFull(vehicle));
  }

  // ค้นหารถด้วยเลขตัวถัง (บางส่วนก็ได้) สำหรับหน้ายื่นเอกสารจดทะเบียน (Step 4) - แยกจาก findAll() เพราะ
  // findAll() จำกัดแค่ 100 คันล่าสุด รถเก่ากว่านั้นต้องค้นด้วย endpoint นี้ถึงจะเจอ
  async searchByChassis(query: string) {
    const trimmed = query.trim();
    if (!trimmed) throw new BadRequestException({ error: 'กรุณาระบุเลขตัวถัง' });
    const vehicles = await this.prisma.vehicle.findMany({
      where: { chassis: { contains: trimmed, mode: 'insensitive' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      include: this.vehicleFullInclude,
    });
    return vehicles.map((vehicle) => this.mapVehicleFull(vehicle));
  }

  // นำเข้าหลายคันพร้อมกัน (bulk paste เลขตัวถัง สูงสุด 1,000 คัน) - จับคู่แบบ exact match
  // (case-insensitive) กับรถที่มีอยู่แล้วในระบบ ไม่ใช่การสร้างรถใหม่ - รถที่ไม่พบคืนแยกไว้ให้ผู้ใช้แก้ไข
  async lookupByChassis(chassisList: string[]) {
    const trimmed = Array.from(new Set(chassisList.map((c) => c.trim()).filter(Boolean)));
    if (trimmed.length === 0) throw new BadRequestException({ error: 'กรุณาระบุเลขตัวถังอย่างน้อย 1 รายการ' });
    if (trimmed.length > MAX_BATCH_SIZE) throw new BadRequestException({ error: `รองรับไม่เกิน ${MAX_BATCH_SIZE} คันต่อครั้ง` });

    const vehicles = await this.prisma.vehicle.findMany({
      where: { chassis: { in: trimmed, mode: 'insensitive' } },
      include: this.vehicleFullInclude,
    });
    const mapped = vehicles.map((vehicle) => this.mapVehicleFull(vehicle));
    // คันที่ยังรอใบเสร็จ (ยื่นซ้ำไม่ได้) แยกออกจาก found กันไม่ให้ bulk import พยายามยื่นซ้ำโดยไม่ตั้งใจ
    // - submit() ก็ปฏิเสธอยู่แล้วเช่นกัน (defense in depth) แต่แยกไว้ตั้งแต่ต้นทางให้ผู้ใช้เห็นชัดกว่า
    const found = mapped.filter((v) => !v.pendingDocumentSubmission);
    const pendingBlocked = mapped.filter((v) => v.pendingDocumentSubmission).map((v) => v.chassis);
    const foundChassisLower = new Set(mapped.map((v) => v.chassis.toLowerCase()));
    const notFound = trimmed.filter((c) => !foundChassisLower.has(c.toLowerCase()));
    return { found, notFound, pendingBlocked };
  }

  async createBatch(body: CreateVehiclesDto): Promise<{ count: number }> {
    const input = Array.isArray(body?.vehicles) ? (body.vehicles as Record<string, unknown>[]) : null;
    if (!input || input.length < 1 || input.length > MAX_BATCH_SIZE) {
      throw new BadRequestException({ error: 'รองรับ 1–1,000 รายการต่อครั้ง' });
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

    // createMany is one SQL statement instead of one round trip per row - a $transaction of up
    // to MAX_BATCH_SIZE individual .create() calls was blowing past Prisma's 5s default
    // transaction timeout on batches above ~80 rows against the remote DB.
    await this.prisma.vehicle.createMany({ data: rows.map((row) => this.toCreateData(row)) });

    return { count: rows.length };
  }

  // แก้ไขรถที่บันทึกแล้ว - ต้องมี remark ทุกครั้ง ไม่งั้นห้ามแก้ไข บันทึกทุกครั้งลง VehicleEditLog
  async updateVehicle(id: string, body: UpdateVehicleDto) {
    const remark = typeof body?.remark === 'string' ? body.remark.trim() : '';
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่แก้ไข (Remark)' });

    const existing = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

    const row = normalizeVehicleRow(body as unknown as Record<string, unknown>);
    const errors = getVehicleRowErrors(row);
    if (errors.length) {
      throw new BadRequestException({ error: 'กรุณาแก้ไขข้อมูลก่อนบันทึก', errors: [{ row: 1, errors }] });
    }

    const [customer, brand] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: row.customerId } }),
      this.prisma.brand.findUnique({ where: { id: row.brandId } }),
    ]);
    if (!customer) throw new BadRequestException({ error: 'ไม่พบลูกค้าในฐานข้อมูล' });
    if (!brand) throw new BadRequestException({ error: 'ไม่พบยี่ห้อในฐานข้อมูล' });

    if (row.chassis !== existing.chassis) {
      const duplicate = await this.prisma.vehicle.findUnique({ where: { chassis: row.chassis } });
      if (duplicate) throw new ConflictException({ error: 'เลขตัวถังนี้มีอยู่แล้ว' });
    }

    const data = this.toCreateData(row);
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const [key] of EDITABLE_VEHICLE_FIELDS) {
      const from = diffField((existing as Record<string, unknown>)[key]);
      const to = diffField((data as Record<string, unknown>)[key]);
      if (from !== to) changes[key] = { from, to };
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.vehicle.update({ where: { id }, data }),
      this.prisma.vehicleEditLog.create({ data: { vehicleId: id, remark, changes: JSON.stringify(changes) } }),
    ]);

    return { id: updated.id };
  }

  // ทุกคันที่ transferDone = false ไม่จำกัดวันที่รับงาน - ใช้แสดงคิวงานที่ต้องดำเนินการทั้งหมด
  async findPendingTransferNotice() {
    const [vehicles, deregistrationFees, relocateFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { transferDone: false },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.feeDeregistration.findMany(),
      this.prisma.feeRelocate.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapTransferNoticeVehicle(vehicle, deregistrationFees, relocateFees));
  }

  // ทุกคันที่ transferDone = true เรียงจากทำเสร็จล่าสุด ไม่กรองตามวันที่รับงาน
  async findRecentlyCompletedTransferNotice() {
    const [vehicles, deregistrationFees, relocateFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { transferDone: true },
        orderBy: [{ transferCompletedDate: 'desc' }, { updatedAt: 'desc' }],
        take: 100,
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.feeDeregistration.findMany(),
      this.prisma.feeRelocate.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapTransferNoticeVehicle(vehicle, deregistrationFees, relocateFees));
  }

  private mapTransferNoticeVehicle(
    vehicle: {
      id: string;
      date: Date;
      chassis: string;
      body: string | null;
      registrationProvince: string | null;
      transferDone: boolean;
      transferCompletedDate: Date | null;
      transferCost: unknown;
      customer: { name: string };
      brand: { name: string };
    },
    deregistrationFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    relocateFees: Array<{ vehicleType: string; brand: string; noBillAmount: unknown; billAmount: unknown }>,
  ) {
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

  // ผ่าน Step 2 แล้ว (transferDone = true) และ: ยังไม่ได้ส่งตรวจ, ตรวจไม่ผ่าน (ส่งตรวจใหม่), หรือตรวจรอบ 1
  // ผ่านครบ 90 วันแล้ว (ถึงกำหนดตรวจรอบ 2) - ไม่จำกัดวันที่รับงาน
  async findPendingInspectionSend() {
    const [vehicles, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: {
          transferDone: true,
          OR: [
            { inspectionSentDate: null },
            { inspectionResult: 'ไม่ผ่าน' },
            { inspectionRound: 1, inspectionResult: 'ผ่าน', inspectionResultDate: { lte: round2Threshold() } },
          ],
        },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapInspectionVehicle(vehicle, bangkokFees, provinceFees));
  }

  // ส่งตรวจแล้ว (inspectionSentDate มีค่า) แต่ยังไม่ทราบผล (inspectionResultDate ยังไม่มี)
  async findPendingInspectionResult() {
    const [vehicles, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { inspectionSentDate: { not: null }, inspectionResultDate: null },
        orderBy: [{ inspectionSentDate: 'desc' }, { id: 'desc' }],
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapInspectionVehicle(vehicle, bangkokFees, provinceFees));
  }

  // ทราบผลตรวจแล้ว (ผ่าน/ไม่ผ่าน) เรียงจากทำเสร็จล่าสุด
  async findRecentlyCompletedInspection() {
    const [vehicles, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { inspectionResultDate: { not: null } },
        orderBy: [{ inspectionResultDate: 'desc' }, { updatedAt: 'desc' }],
        take: 100,
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapInspectionVehicle(vehicle, bangkokFees, provinceFees));
  }

  private mapInspectionVehicle(
    vehicle: {
      id: string;
      date: Date;
      chassis: string;
      engine: string | null;
      color: string | null;
      body: string | null;
      registrationProvince: string | null;
      customer: { name: string };
      brand: { name: string };
      inspectionRound: number;
      inspectionSentType: string | null;
      inspectionSentDate: Date | null;
      inspectionSentCost: unknown;
      inspectionSentBillCost: unknown;
      inspectionResult: string | null;
      inspectionResultDate: Date | null;
      inspectionResultCost: unknown;
      inspectionFailRemark: string | null;
    },
    bangkokFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    provinceFees: Array<{ province: string; vehicleType: string; amount: unknown }>,
  ) {
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
      // เลขเครื่อง/สี ใช้ในใบพิมพ์รายการส่งตรวจรถ (PDF) หน้าตรวจรถ
      engine: vehicle.engine,
      color: vehicle.color,
      brandName: vehicle.brand.name,
      body: vehicle.body,
      registrationProvince: vehicle.registrationProvince,
      suggestedCost,
      inspectionRound: vehicle.inspectionRound,
      // ถึงกำหนดตรวจรอบ 2 (ยังไม่ได้ส่ง) - หน้าจอใช้แสดงหมายเหตุในคิวส่งตรวจ
      round2Due: isRound2Due(vehicle),
      // ค่าตรวจรถ (Bill) มีเฉพาะรอบ 2 (ทั้งตอนถึงกำหนดและตอนส่งตรวจรอบ 2 ซ้ำหลังไม่ผ่าน)
      suggestedBillCost: isRound2Due(vehicle) || vehicle.inspectionRound === 2 ? String(INSPECTION_ROUND2_BILL_FEE) : null,
      inspectionSentType: vehicle.inspectionSentType,
      inspectionSentDate: vehicle.inspectionSentDate?.toISOString().slice(0, 10) ?? null,
      inspectionSentCost: vehicle.inspectionSentCost,
      inspectionSentBillCost: vehicle.inspectionSentBillCost,
      inspectionResult: vehicle.inspectionResult,
      inspectionResultDate: vehicle.inspectionResultDate?.toISOString().slice(0, 10) ?? null,
      inspectionResultCost: vehicle.inspectionResultCost,
      inspectionFailRemark: vehicle.inspectionFailRemark,
    };
  }

  // ค่าใช้จ่ายส่งตรวจคงที่ (หน้าจอแก้ไม่ได้): ราคาตรวจรถ (No bill) ตามตาราง - เอารถมาตรวจเองเป็น 0 - และค่าตรวจรถ
  // (Bill) 50 บาทเฉพาะรอบ 2 ยังไม่เลือกประเภทการตรวจ = ยังไม่มีค่าใช้จ่าย
  private fixedSentCosts(
    sentType: string,
    round: number,
    vehicle: { registrationProvince: string | null; body: string | null; brand: { name: string } },
    bangkokFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    provinceFees: Array<{ province: string; vehicleType: string; amount: unknown }>,
  ): { inspectionSentCost: string | null; inspectionSentBillCost: string | null } {
    if (!sentType) return { inspectionSentCost: null, inspectionSentBillCost: null };
    return {
      inspectionSentCost:
        sentType === 'เอารถมาตรวจเอง'
          ? '0'
          : this.suggestInspectionCost(vehicle.registrationProvince, vehicle.body, vehicle.brand.name, bangkokFees, provinceFees),
      inspectionSentBillCost: round === 2 ? String(INSPECTION_ROUND2_BILL_FEE) : null,
    };
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

  // Step 3a: บันทึกว่าส่งตรวจแบบไหน (ส่งตรวจนอก/เอารถมาตรวจเอง) วันที่ส่ง และค่าใช้จ่าย
  async updateInspectionSent(id: string, dto: UpdateInspectionSentDto) {
    const sentType = typeof dto?.sentType === 'string' ? dto.sentType.trim() : '';
    const sentDateRaw = typeof dto?.sentDate === 'string' ? dto.sentDate.trim() : '';

    if (sentType && !INSPECTION_SENT_TYPES.includes(sentType as (typeof INSPECTION_SENT_TYPES)[number])) {
      throw new BadRequestException({ error: 'ประเภทการตรวจไม่ถูกต้อง' });
    }
    if (sentDateRaw && !isValidDateParam(sentDateRaw)) {
      throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }

    const [vehicle, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findUnique({ where: { id }, include: { brand: { select: { name: true } } } }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

    // เริ่มรอบตรวจใหม่เมื่อ: ตรวจไม่ผ่าน (ส่งตรวจซ้ำรอบเดิม) หรือรอบ 1 ผ่านครบ 90 วัน (ขึ้นรอบ 2) - ล้างผลตรวจเดิม
    // ให้รถเข้าคิวรอผลตรวจอีกครั้ง และเก็บข้อมูลรอบก่อนไว้ใน VehicleEditLog เพราะช่องบน Vehicle เก็บได้แค่ชุดล่าสุด
    const isResend = vehicle.inspectionResult === 'ไม่ผ่าน';
    const startsRound2 = isRound2Due(vehicle);
    if (vehicle.inspectionResult === 'ผ่าน' && !startsRound2) {
      throw new BadRequestException({
        error: vehicle.inspectionRound === 2 ? 'รถคันนี้ตรวจรอบ 2 ผ่านแล้ว' : 'รถคันนี้ตรวจผ่านแล้ว ยังไม่ครบ 90 วันสำหรับตรวจรอบ 2',
      });
    }
    const startsNewCycle = isResend || startsRound2;
    const round = startsRound2 ? 2 : vehicle.inspectionRound;
    const data = {
      inspectionSentType: sentType || null,
      inspectionSentDate: sentDateRaw ? new Date(`${sentDateRaw}T00:00:00.000Z`) : null,
      ...this.fixedSentCosts(sentType, round, vehicle, bangkokFees, provinceFees),
      ...(startsNewCycle
        ? { inspectionResult: null, inspectionResultDate: null, inspectionResultCost: null, inspectionFailRemark: null }
        : {}),
      ...(startsRound2 ? { inspectionRound: 2 } : {}),
    };
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const [key, value] of Object.entries(data)) {
      const from = diffField((vehicle as Record<string, unknown>)[key]);
      const to = diffField(value);
      if (from !== to) changes[key] = { from, to };
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.vehicle.update({ where: { id }, data }),
      ...(startsNewCycle
        ? [
            this.prisma.vehicleEditLog.create({
              data: {
                vehicleId: id,
                remark: startsRound2
                  ? `เริ่มตรวจรอบ 2 (ครบ 90 วันหลังผ่านตรวจรอบ 1 วันที่ ${diffField(vehicle.inspectionResultDate)})`
                  : `ส่งตรวจใหม่หลังตรวจไม่ผ่าน (เหตุผลเดิม: ${vehicle.inspectionFailRemark ?? '—'})`,
                changes: JSON.stringify(changes),
              },
            }),
          ]
        : []),
    ]);

    return {
      id: updated.id,
      inspectionRound: updated.inspectionRound,
      inspectionSentType: updated.inspectionSentType,
      inspectionSentDate: updated.inspectionSentDate?.toISOString().slice(0, 10) ?? null,
      inspectionSentCost: updated.inspectionSentCost,
      inspectionSentBillCost: updated.inspectionSentBillCost,
    };
  }

  // Step 3b: บันทึกผลตรวจ (ผ่าน/ไม่ผ่าน) - ตรวจไม่ผ่านต้องมี remark ทุกครั้ง
  async updateInspectionResult(id: string, dto: UpdateInspectionResultDto) {
    const result = typeof dto?.result === 'string' ? dto.result.trim() : '';
    const resultDateRaw = typeof dto?.resultDate === 'string' ? dto.resultDate.trim() : '';
    const remark = typeof dto?.remark === 'string' ? dto.remark.trim() : '';

    if (result && !INSPECTION_RESULTS.includes(result as (typeof INSPECTION_RESULTS)[number])) {
      throw new BadRequestException({ error: 'ผลตรวจไม่ถูกต้อง' });
    }
    if (resultDateRaw && !isValidDateParam(resultDateRaw)) {
      throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    if (result === 'ไม่ผ่าน' && !remark) {
      throw new BadRequestException({ error: 'กรุณาระบุ Remark เมื่อตรวจไม่ผ่าน' });
    }

    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

    const updated = await this.prisma.vehicle.update({
      where: { id },
      data: {
        inspectionResult: result || null,
        inspectionResultDate: resultDateRaw ? new Date(`${resultDateRaw}T00:00:00.000Z`) : null,
        // ค่าใช้จ่ายคงที่ แก้จากหน้าจอไม่ได้: ผ่าน = ราคาตอนส่งตรวจ, ไม่ผ่าน = 0 (ได้เงินคืน)
        inspectionResultCost: result === 'ไม่ผ่าน' ? '0' : result === 'ผ่าน' ? vehicle.inspectionSentCost : null,
        inspectionFailRemark: result === 'ไม่ผ่าน' ? remark : null,
      },
    });

    return {
      id: updated.id,
      inspectionResult: updated.inspectionResult,
      inspectionResultDate: updated.inspectionResultDate?.toISOString().slice(0, 10) ?? null,
      inspectionResultCost: updated.inspectionResultCost,
      inspectionFailRemark: updated.inspectionFailRemark,
    };
  }

  // Step 4: ผูกเจ้าของรถ + วันจดทะเบียนครั้งแรก + รถใหม่จากโรงงานหรือไม่ แล้วคำนวณและบันทึก
  // TaxCalculation snapshot ใหม่ทันที (immutable - ไม่ update ผลเดิม)
  async updateTaxInput(id: string, dto: UpdateTaxInputDto) {
    const ownerIdRaw = dto?.ownerId;
    if (ownerIdRaw !== null && ownerIdRaw !== undefined && typeof ownerIdRaw !== 'string') {
      throw new BadRequestException({ error: 'ownerId ต้องเป็นข้อความหรือ null' });
    }
    const isFactoryNewRaw = dto?.isFactoryNew;
    if (isFactoryNewRaw !== null && isFactoryNewRaw !== undefined && typeof isFactoryNewRaw !== 'boolean') {
      throw new BadRequestException({ error: 'isFactoryNew ต้องเป็น true/false หรือ null' });
    }
    const firstRegistrationDate = parseTaxDate(dto?.firstRegistrationDate, 'firstRegistrationDate');

    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

    if (ownerIdRaw) {
      const owner = await this.prisma.vehicleOwner.findUnique({ where: { id: ownerIdRaw } });
      if (!owner) throw new BadRequestException({ error: 'ไม่พบเจ้าของรถในฐานข้อมูล' });
    }

    await this.prisma.vehicle.update({
      where: { id },
      data: {
        ownerId: ownerIdRaw || null,
        isFactoryNew: isFactoryNewRaw ?? null,
        firstRegistrationDate,
      },
    });

    return this.taxService.calculateAndSave(id);
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

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerType } from '../generated/prisma/enums.js';
import { TaxService } from '../tax/tax.service.js';
import { computeDocumentFees, isMotorcycle, type DocumentFeeRuleSet, type FeeParamRow } from './document-fee-calculator.js';
import type { DocumentSubmissionOptionsDto } from './dto/document-submission-options.dto.js';
import type { CreateDocumentSubmissionDto } from './dto/create-document-submission.dto.js';
import type { BulkCreateDocumentSubmissionDto, BulkDocumentSubmissionEntryDto } from './dto/bulk-create-document-submission.dto.js';
import {
  assertPlateFormat,
  assertPlateNumberProvided,
  parseDocumentSubmissionOptions,
  parsePlateFields,
  parseReceiptAmount,
  parseSubmitDate,
} from './document-submission-validation.js';

const BULK_CHUNK_SIZE = 50;

function toRows(rows: Array<{ key: string; amount: unknown }>): FeeParamRow[] {
  return rows.map((r) => ({ key: r.key, amount: r.amount === null ? null : Number(r.amount) }));
}

@Injectable()
export class DocumentSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxService: TaxService,
  ) {}

  private async loadRuleSet(): Promise<DocumentFeeRuleSet> {
    const [carBill, carNoBill, motoBill, motoNoBill] = await Promise.all([
      this.prisma.feeCarBillParam.findMany(),
      this.prisma.feeCarNoBillParam.findMany(),
      this.prisma.feeMotorcycleBillParam.findMany(),
      this.prisma.feeMotorcycleNoBillParam.findMany(),
    ]);
    return { carBill: toRows(carBill), carNoBill: toRows(carNoBill), motoBill: toRows(motoBill), motoNoBill: toRows(motoNoBill) };
  }

  private async loadVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    return vehicle;
  }

  // รถคันหนึ่งยื่นเอกสารซ้ำไม่ได้ตราบใดที่ยื่นครั้งล่าสุดยังค้างสถานะ PENDING (รอใบเสร็จจากกรมขนส่ง) อยู่ -
  // ต้องได้รับใบเสร็จ (RECEIPT_RECEIVED) หรือยื่นไม่สำเร็จ (FAILED) ก่อนถึงจะยื่นใหม่ได้ ดู
  // DocumentSubmission.status ใน schema.prisma
  private async assertNotPending(vehicleId: string) {
    const latest = await this.prisma.documentSubmission.findFirst({ where: { vehicleId }, orderBy: { createdAt: 'desc' } });
    if (latest && latest.status === 'PENDING') {
      throw new BadRequestException({ error: 'รถคันนี้ยื่นเอกสารไปแล้วและยังรอใบเสร็จอยู่ - ยื่นซ้ำไม่ได้จนกว่าจะได้รับใบเสร็จหรือยื่นไม่สำเร็จ' });
    }
  }

  async preview(vehicleId: string, dto: DocumentSubmissionOptionsDto) {
    const vehicle = await this.loadVehicle(vehicleId);
    const isMoto = isMotorcycle(vehicle.body);
    const options = parseDocumentSubmissionOptions(dto, isMoto);
    const rules = await this.loadRuleSet();
    return computeDocumentFees(
      { body: vehicle.body, registrationProvince: vehicle.registrationProvince, ownerProvince: vehicle.ownerProvince },
      options,
      rules,
    );
  }

  // บันทึก DocumentSubmission (snapshot ค่าธรรมเนียม) + เรียก TaxService.calculateAndSave ซ้ำในตัว
  // (ให้ "บันทึกรายการนี้" 1 ครั้งได้ทั้งค่าธรรมเนียมและภาษี ตามที่ mockup คาดหวังไว้) แล้ว update
  // plateCategory/plateNumber บน Vehicle ถ้าส่งมา (mutable, ไม่ใช่ส่วนหนึ่งของ snapshot)
  async submit(vehicleId: string, dto: CreateDocumentSubmissionDto) {
    const vehicle = await this.loadVehicle(vehicleId);
    await this.assertNotPending(vehicleId);
    const isMoto = isMotorcycle(vehicle.body);
    const options = parseDocumentSubmissionOptions(dto, isMoto);
    const submitDate = parseSubmitDate(dto.submitDate);
    const plateCategory = parsePlateFields(dto.plateCategory, 'plateCategory');
    const plateNumber = parsePlateFields(dto.plateNumber, 'plateNumber');
    assertPlateNumberProvided(options.plateNumberOption, plateCategory, plateNumber);

    const rules = await this.loadRuleSet();
    const fees = computeDocumentFees(
      { body: vehicle.body, registrationProvince: vehicle.registrationProvince, ownerProvince: vehicle.ownerProvince },
      options,
      rules,
    );

    // อัปเดตเจ้าของรถ/เลขทะเบียนก่อนคำนวณภาษี - TaxService.calculateAndSave อ่าน Vehicle.ownerId จาก DB
    // ตรงๆ ไม่รับเป็น parameter จึงต้อง persist ก่อนเรียก ไม่งั้นภาษีจะคำนวณจากเจ้าของรถอันเก่า/ยังไม่มี
    const vehicleUpdateData: { ownerId?: string | null; plateCategory?: string | null; plateNumber?: string | null } = {};
    if (dto.ownerType !== undefined) {
      const ownerTypeRaw = dto.ownerType;
      if (ownerTypeRaw !== OwnerType.INDIVIDUAL && ownerTypeRaw !== OwnerType.JURISTIC) {
        throw new BadRequestException({ error: 'ownerType ต้องเป็น INDIVIDUAL หรือ JURISTIC' });
      }
      // ผู้ใช้เลือกแค่ประเภทเจ้าของรถ ไม่ได้จัดการ VehicleOwner รายชื่อเอง - ใช้ของเดิมซ้ำถ้าประเภทตรงกัน
      // อยู่แล้ว ไม่งั้นสร้างแถวใหม่แบบไม่ระบุชื่อ กันไม่ให้เพิ่มแถวขึ้นเรื่อยๆ ทุกครั้งที่บันทึกซ้ำคันเดิม
      const currentOwner = vehicle.ownerId ? await this.prisma.vehicleOwner.findUnique({ where: { id: vehicle.ownerId } }) : null;
      if (!currentOwner || currentOwner.ownerType !== ownerTypeRaw) {
        const newOwner = await this.prisma.vehicleOwner.create({
          data: { ownerType: ownerTypeRaw, isHirePurchaseBusiness: false, hirerType: null },
        });
        vehicleUpdateData.ownerId = newOwner.id;
      }
    }
    if (dto.plateCategory !== undefined) vehicleUpdateData.plateCategory = plateCategory;
    if (dto.plateNumber !== undefined) vehicleUpdateData.plateNumber = plateNumber;
    if (Object.keys(vehicleUpdateData).length > 0) {
      await this.prisma.vehicle.update({ where: { id: vehicleId }, data: vehicleUpdateData });
    }

    const taxCalculation = await this.taxService.calculateAndSave(vehicleId);

    const submission = await this.prisma.documentSubmission.create({
      data: {
        vehicleId,
        submitDate,
        plateNumberOption: options.plateNumberOption,
        includePlateFee: options.includePlateFee,
        newPlateOption: options.newPlateOption,
        relocateAddon: options.relocateAddon,
        stopUseRelocateOut: options.stopUseRelocateOut,
        urgent: options.urgent,
        billItems: JSON.parse(JSON.stringify(fees.billItems)),
        noBillItems: JSON.parse(JSON.stringify(fees.noBillItems)),
        billFeeTotal: fees.billTotal,
        noBillTotal: fees.noBillTotal,
        taxAmount: taxCalculation.finalAmount,
      },
    });

    return { submission, taxCalculation };
  }

  // best-effort: บันทึกเท่าที่ทำได้ แล้วคืนรายการที่พลาดพร้อมเหตุผล ไม่ throw ทั้งชุดเมื่อบางคันพัง
  // (ยืนยันกับผู้ใช้แล้วตอนวางแผน - ดู plan file) แบ่งเป็น chunk กัน connection pool ของ Neon ล้นตอนมี
  // เป็นพันคัน
  async submitBulk(dto: BulkCreateDocumentSubmissionDto) {
    if (!dto || !Array.isArray(dto.entries)) throw new BadRequestException({ error: 'entries ต้องเป็น array' });
    const entries = dto.entries as BulkDocumentSubmissionEntryDto[];

    const succeeded: Array<{ vehicleId: string; submission: unknown }> = [];
    const failed: Array<{ vehicleId: unknown; error: string }> = [];

    for (let i = 0; i < entries.length; i += BULK_CHUNK_SIZE) {
      const chunk = entries.slice(i, i + BULK_CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (entry) => {
          const vehicleId = entry?.vehicleId;
          if (typeof vehicleId !== 'string' || !vehicleId) {
            failed.push({ vehicleId, error: 'vehicleId ไม่ถูกต้อง' });
            return;
          }
          try {
            const result = await this.submit(vehicleId, entry);
            succeeded.push({ vehicleId, submission: result.submission });
          } catch (err) {
            const message = err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ';
            const responseMessage = (err as { response?: { error?: string } })?.response?.error;
            failed.push({ vehicleId, error: responseMessage ?? message });
          }
        }),
      );
    }

    return { succeeded, failed };
  }

  // status: กรองตามสถานะ (หน้ารับใบเสร็จใช้ PENDING = รอใบเสร็จ / RECEIPT_RECEIVED = รับแล้ว)
  async listByDate(dateIso?: string, status?: string) {
    if (dateIso !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
      throw new BadRequestException({ error: 'date ต้องเป็น ค.ศ. YYYY-MM-DD' });
    }
    if (status !== undefined && !['PENDING', 'RECEIPT_RECEIVED', 'FAILED'].includes(status)) {
      throw new BadRequestException({ error: 'status ต้องเป็น PENDING, RECEIPT_RECEIVED หรือ FAILED' });
    }
    const where = {
      ...(dateIso
        ? {
            submitDate: {
              gte: new Date(`${dateIso}T00:00:00.000Z`),
              lt: new Date(new Date(`${dateIso}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000),
            },
          }
        : {}),
      ...(status ? { status } : {}),
    };

    const submissions = await this.prisma.documentSubmission.findMany({
      where,
      orderBy: status === 'RECEIPT_RECEIVED' ? [{ receiptReceivedDate: 'desc' }, { updatedAt: 'desc' }] : [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      take: status === 'RECEIPT_RECEIVED' ? 100 : 2000,
      include: {
        vehicle: {
          select: {
            chassis: true,
            body: true,
            plateCategory: true,
            plateNumber: true,
            customer: { select: { name: true } },
            owner: { select: { name: true, ownerType: true } },
          },
        },
      },
    });
    return { submissions };
  }

  // เปลี่ยนสถานะได้ครั้งเดียวจาก PENDING -> RECEIPT_RECEIVED หรือ FAILED เท่านั้น (ห้ามย้อนกลับ/เปลี่ยนซ้ำ)
  // การอัปเดตนี้ปลด block การยื่นซ้ำของรถคันนั้นใน assertNotPending()
  // receivedDate (ค.ศ. YYYY-MM-DD) ใช้เฉพาะ RECEIPT_RECEIVED - ไม่ส่งมาจะใช้วันนี้
  // RECEIPT_RECEIVED ต้องมีเลขทะเบียน (หมวด+เลข) - ใช้ที่ส่งมา หรือที่รถคันนี้มีอยู่แล้วถ้าไม่ได้ส่ง ไม่มีทั้งคู่บันทึกไม่ได้
  // (FAILED ไม่ต้องมี) และบันทึกลง Vehicle.plateCategory/plateNumber; receiptAmount (ไม่บังคับ) = ยอดบนใบเสร็จจริง
  async updateStatus(
    submissionId: string,
    statusRaw: unknown,
    receivedDateRaw?: unknown,
    extras: { plateCategory?: unknown; plateNumber?: unknown; receiptAmount?: unknown } = {},
  ) {
    if (statusRaw !== 'RECEIPT_RECEIVED' && statusRaw !== 'FAILED') {
      throw new BadRequestException({ error: 'status ต้องเป็น RECEIPT_RECEIVED หรือ FAILED' });
    }
    let receiptReceivedDate: Date | null = null;
    if (statusRaw === 'RECEIPT_RECEIVED') {
      if (receivedDateRaw === undefined || receivedDateRaw === null || receivedDateRaw === '') {
        receiptReceivedDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      } else {
        receiptReceivedDate = parseSubmitDate(receivedDateRaw);
      }
    }
    const submission = await this.prisma.documentSubmission.findUnique({
      where: { id: submissionId },
      include: { vehicle: { select: { plateCategory: true, plateNumber: true } } },
    });
    if (!submission) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    if (submission.status !== 'PENDING') {
      throw new BadRequestException({ error: 'รายการนี้อัปเดตสถานะไปแล้ว' });
    }

    if (statusRaw === 'FAILED') {
      return this.prisma.documentSubmission.update({ where: { id: submissionId }, data: { status: 'FAILED', receiptReceivedDate: null } });
    }

    const plateCategory =
      extras.plateCategory !== undefined ? parsePlateFields(extras.plateCategory, 'plateCategory') : submission.vehicle.plateCategory;
    const plateNumber = extras.plateNumber !== undefined ? parsePlateFields(extras.plateNumber, 'plateNumber') : submission.vehicle.plateNumber;
    if (!plateCategory || !plateNumber) {
      throw new BadRequestException({ error: 'กรุณากรอกหมวดทะเบียนและเลขทะเบียนก่อนบันทึกการรับใบเสร็จ' });
    }
    assertPlateFormat(plateCategory, plateNumber);
    const receiptAmount = parseReceiptAmount(extras.receiptAmount);

    const [, updated] = await this.prisma.$transaction([
      this.prisma.vehicle.update({ where: { id: submission.vehicleId }, data: { plateCategory, plateNumber } }),
      this.prisma.documentSubmission.update({
        where: { id: submissionId },
        data: { status: 'RECEIPT_RECEIVED', receiptReceivedDate, receiptAmount },
      }),
    ]);
    return updated;
  }
}

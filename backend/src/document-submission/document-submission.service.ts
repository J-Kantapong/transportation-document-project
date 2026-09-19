import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerType } from '../generated/prisma/enums.js';
import { TaxService } from '../tax/tax.service.js';
import { computeDocumentFees, isMotorcycle, type DocumentFeeRuleSet, type FeeParamRow } from './document-fee-calculator.js';
import type { DocumentSubmissionOptionsDto } from './dto/document-submission-options.dto.js';
import type { CreateDocumentSubmissionDto } from './dto/create-document-submission.dto.js';
import type { BulkCreateDocumentSubmissionDto, BulkDocumentSubmissionEntryDto } from './dto/bulk-create-document-submission.dto.js';
import type { PreviewBulkDocumentSubmissionDto, PreviewBulkDocumentSubmissionEntryDto } from './dto/preview-bulk-document-submission.dto.js';
import type { GovernmentTaxOwnerInput } from '../tax/government-tax-calculator.js';
import { ACTIVE_SUBMISSION_STATUSES, getSubmitBlockReason } from './submission-eligibility.js';
import {
  assertPlateFormat,
  assertPlateNumberProvided,
  parseDocumentSubmissionOptions,
  parsePlateFields,
  parseReceiptAmount,
  parseSubmitDate,
} from './document-submission-validation.js';

const BULK_CHUNK_SIZE = 50;
const MAX_BULK_PREVIEW = 1000;

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

  // ต้องผ่าน Step 2 (แจ้งย้าย/ตัดบัญชี) + ตรวจรถผ่านภายใน 90 วัน และยังไม่เคยยื่นที่ค้างอยู่/ได้ใบเสร็จแล้ว -
  // ดูกฎทั้งหมดใน submission-eligibility.ts
  private async assertEligible(
    vehicle: {
      id: string;
      transferDone: boolean;
      inspectionSentDate: Date | null;
      inspectionResult: string | null;
      inspectionResultDate: Date | null;
    },
    submitDate: Date,
  ) {
    const active = await this.prisma.documentSubmission.findFirst({
      where: { vehicleId: vehicle.id, status: { in: ACTIVE_SUBMISSION_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    const reason = getSubmitBlockReason({ ...vehicle, activeSubmissionStatus: active?.status ?? null }, submitDate);
    if (reason) throw new BadRequestException({ error: reason });
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

  // preview ค่าธรรมเนียม + ภาษีหลายคันในคำขอเดียว (หน้ายื่นเอกสาร: เพิ่มจากคิว/แก้ตัวเลือกหลายคันพร้อมกัน)
  // - คำนวณแบบเดียวกับ submit(): ownerType ที่ส่งมาใช้แทนเจ้าของรถเดิม (ถ้าประเภทตรงกับเจ้าของเดิมก็ใช้ของเดิม)
  // ไม่ส่งมา = ใช้เจ้าของรถเดิม รายการที่พังคืน error รายคัน ไม่ throw ทั้งชุด
  async previewBulk(dto: PreviewBulkDocumentSubmissionDto) {
    if (!dto || !Array.isArray(dto.entries)) throw new BadRequestException({ error: 'entries ต้องเป็น array' });
    const entries = dto.entries as PreviewBulkDocumentSubmissionEntryDto[];
    if (entries.length > MAX_BULK_PREVIEW) {
      throw new BadRequestException({ error: `รองรับไม่เกิน ${MAX_BULK_PREVIEW.toLocaleString('en-US')} คันต่อครั้ง` });
    }
    const vehicleIds = Array.from(new Set(entries.map((e) => e?.vehicleId).filter((id): id is string => typeof id === 'string')));
    const [vehicles, rules] = await Promise.all([
      this.prisma.vehicle.findMany({ where: { id: { in: vehicleIds } }, include: { owner: true } }),
      this.loadRuleSet(),
    ]);
    const byId = new Map(vehicles.map((v) => [v.id, v]));

    type Computed =
      | { vehicleId: unknown; error: string }
      | { vehicleId: string; fee: ReturnType<typeof computeDocumentFees>; taxInput: Parameters<TaxService['previewMany']>[0][number] };
    const computed: Computed[] = entries.map((entry) => {
      const vehicle = typeof entry?.vehicleId === 'string' ? byId.get(entry.vehicleId) : undefined;
      if (!vehicle) return { vehicleId: entry?.vehicleId, error: 'ไม่พบข้อมูลรถ' };
      try {
        const options = parseDocumentSubmissionOptions(entry, isMotorcycle(vehicle.body));
        const fee = computeDocumentFees(
          { body: vehicle.body, registrationProvince: vehicle.registrationProvince, ownerProvince: vehicle.ownerProvince },
          options,
          rules,
        );
        let owner: GovernmentTaxOwnerInput | null = vehicle.owner
          ? { ownerType: vehicle.owner.ownerType, isHirePurchaseBusiness: vehicle.owner.isHirePurchaseBusiness, hirerType: vehicle.owner.hirerType }
          : null;
        if (entry.ownerType !== undefined) {
          if (entry.ownerType !== OwnerType.INDIVIDUAL && entry.ownerType !== OwnerType.JURISTIC) {
            return { vehicleId: vehicle.id, error: 'ownerType ต้องเป็น INDIVIDUAL หรือ JURISTIC' };
          }
          if (!owner || owner.ownerType !== entry.ownerType) {
            owner = { ownerType: entry.ownerType, isHirePurchaseBusiness: false, hirerType: null };
          }
        }
        return {
          vehicleId: vehicle.id,
          fee,
          taxInput: {
            vehicle: {
              body: vehicle.body,
              fuel: vehicle.fuel,
              cc: vehicle.cc?.toString() ?? null,
              weight: vehicle.weight?.toString() ?? null,
              firstRegistrationDate: vehicle.firstRegistrationDate,
            },
            owner,
          },
        };
      } catch (err) {
        const responseMessage = (err as { response?: { error?: string } })?.response?.error;
        return { vehicleId: vehicle.id, error: responseMessage ?? 'คำนวณค่าธรรมเนียมไม่สำเร็จ' };
      }
    });

    const ok = computed.filter((c): c is Extract<Computed, { fee: unknown }> => 'fee' in c);
    const taxes = await this.taxService.previewMany(ok.map((c) => c.taxInput));
    const taxByEntry = new Map(ok.map((c, i) => [c, taxes[i]]));
    return {
      results: computed.map((c) => ('fee' in c ? { vehicleId: c.vehicleId, fee: c.fee, tax: taxByEntry.get(c) } : c)),
    };
  }

  // บันทึก DocumentSubmission (snapshot ค่าธรรมเนียม) + เรียก TaxService.calculateAndSave ซ้ำในตัว
  // (ให้ "บันทึกรายการนี้" 1 ครั้งได้ทั้งค่าธรรมเนียมและภาษี ตามที่ mockup คาดหวังไว้) แล้ว update
  // plateCategory/plateNumber บน Vehicle ถ้าส่งมา (mutable, ไม่ใช่ส่วนหนึ่งของ snapshot)
  async submit(vehicleId: string, dto: CreateDocumentSubmissionDto) {
    const vehicle = await this.loadVehicle(vehicleId);
    const submitDate = parseSubmitDate(dto.submitDate);
    await this.assertEligible(vehicle, submitDate);
    const isMoto = isMotorcycle(vehicle.body);
    const options = parseDocumentSubmissionOptions(dto, isMoto);
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
    // ต้องรู้ประเภทเจ้าของรถก่อนยื่นเสมอ (ภาษี รย.1 นิติบุคคลคูณสอง) - ระบบไม่เดาให้ (ผู้ใช้เลือกเอง 2026-09-20)
    if (dto.ownerType === undefined && !vehicle.ownerId) {
      throw new BadRequestException({ error: 'กรุณาระบุประเภทเจ้าของรถ (บุคคลธรรมดา/นิติบุคคล) ก่อนยื่น' });
    }
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

    // รถคันเดียวกันซ้ำในชุดเดียวกัน - ถ้าปล่อยให้ submit() พร้อมกันใน chunk เดียวกัน ทั้งคู่จะผ่าน
    // assertEligible ก่อนที่อีกอันจะสร้างแถว จนได้ยื่นซ้ำ 2 แถว จึงรับแค่แถวแรก
    const seen = new Set<string>();
    const unique: BulkDocumentSubmissionEntryDto[] = [];
    for (const entry of entries) {
      const vehicleId = entry?.vehicleId;
      if (typeof vehicleId === 'string' && seen.has(vehicleId)) {
        failed.push({ vehicleId, error: 'รถคันนี้ซ้ำในรายการเดียวกัน' });
        continue;
      }
      if (typeof vehicleId === 'string') seen.add(vehicleId);
      unique.push(entry);
    }

    for (let i = 0; i < unique.length; i += BULK_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + BULK_CHUNK_SIZE);
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
            customer: { select: { name: true, company: true } },
            brand: { select: { name: true } },
            owner: { select: { name: true, ownerType: true } },
          },
        },
        // รูปใบเสร็จที่แนบแล้ว - ตัวรูปโหลดผ่าน GET /api/receipts/:id/image
        receipts: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, extractionSource: true, extraction: true, createdAt: true },
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
    extras: { plateCategory?: unknown; plateNumber?: unknown; receiptAmount?: unknown; failRemark?: unknown } = {},
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

    // ยื่นไม่สำเร็จ = รถกลับไปทำ Step 4 ใหม่ได้ (กฎของผู้ใช้) แต่ต้องมีเหตุผลทุกครั้ง - แสดงในคิวรอยื่นเอกสาร
    if (statusRaw === 'FAILED') {
      const failRemark = typeof extras.failRemark === 'string' ? extras.failRemark.trim() : '';
      if (!failRemark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่ยื่นไม่สำเร็จ' });
      return this.prisma.documentSubmission.update({
        where: { id: submissionId },
        data: { status: 'FAILED', receiptReceivedDate: null, failRemark },
      });
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

  // หน้ารับใบเสร็จ: บันทึกทั้งใบยื่นทีเดียว (best-effort - คันที่พลาดคืนเหตุผลกลับไป คันอื่นบันทึกต่อ)
  // RECEIVED = ได้ใบเสร็จ (ต้องแนบรูปใบเสร็จแล้วอย่างน้อย 1 รูป) / FAILED = ยื่นไม่สำเร็จ กลับไป Step 4
  // CARRY = ยังไม่ได้ใบเสร็จและยังไม่รู้สาเหตุ -> ย้ายไป "ค้างจากใบก่อน" (ยัง PENDING)
  async saveReceiptCheck(body: { receivedDate?: unknown; entries?: unknown }) {
    if (!body || !Array.isArray(body.entries)) throw new BadRequestException({ error: 'entries ต้องเป็น array' });
    if (body.entries.length > 500) throw new BadRequestException({ error: 'บันทึกได้ครั้งละไม่เกิน 500 คัน' });
    const entries = body.entries as Array<Record<string, unknown> | null>;

    const succeeded: string[] = [];
    const failed: Array<{ submissionId: unknown; error: string }> = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const submissionId = entry?.submissionId;
      if (typeof submissionId !== 'string' || !submissionId || seen.has(submissionId)) {
        failed.push({ submissionId, error: 'submissionId ไม่ถูกต้องหรือซ้ำ' });
        continue;
      }
      seen.add(submissionId);
      try {
        if (entry?.action === 'RECEIVED') {
          const photos = await this.prisma.receiptImage.count({ where: { submissionId } });
          if (photos === 0) throw new BadRequestException({ error: 'ต้องแนบรูปใบเสร็จก่อนบันทึกว่าได้รับใบเสร็จ' });
          await this.updateStatus(submissionId, 'RECEIPT_RECEIVED', body.receivedDate, {
            plateCategory: entry.plateCategory,
            plateNumber: entry.plateNumber,
            receiptAmount: entry.receiptAmount,
          });
        } else if (entry?.action === 'FAILED') {
          await this.updateStatus(submissionId, 'FAILED', undefined, { failRemark: entry.failRemark });
        } else if (entry?.action === 'CARRY') {
          const { count } = await this.prisma.documentSubmission.updateMany({
            where: { id: submissionId, status: 'PENDING' },
            data: { receiptCarriedAt: new Date() },
          });
          if (count === 0) throw new BadRequestException({ error: 'รายการนี้ไม่ได้รอใบเสร็จอยู่แล้ว' });
        } else {
          throw new BadRequestException({ error: 'action ต้องเป็น RECEIVED, FAILED หรือ CARRY' });
        }
        succeeded.push(submissionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ';
        const responseMessage = (err as { response?: { error?: string } })?.response?.error;
        failed.push({ submissionId, error: responseMessage ?? message });
      }
    }
    return { succeeded, failed };
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerType } from '../generated/prisma/enums.js';
import { TaxService } from '../tax/tax.service.js';
import { computeDocumentFees, isMotorcycle, type DocumentFeeRuleSet, type FeeParamRow } from './document-fee-calculator.js';
import type { DocumentSubmissionOptionsDto } from './dto/document-submission-options.dto.js';
import type { CreateDocumentSubmissionDto } from './dto/create-document-submission.dto.js';
import type { BulkCreateDocumentSubmissionDto, BulkDocumentSubmissionEntryDto } from './dto/bulk-create-document-submission.dto.js';
import { assertPlateNumberProvided, parseDocumentSubmissionOptions, parsePlateFields, parseSubmitDate } from './document-submission-validation.js';

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

  async listByDate(dateIso?: string) {
    if (dateIso !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
      throw new BadRequestException({ error: 'date ต้องเป็น ค.ศ. YYYY-MM-DD' });
    }
    const where = dateIso
      ? {
          submitDate: {
            gte: new Date(`${dateIso}T00:00:00.000Z`),
            lt: new Date(new Date(`${dateIso}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000),
          },
        }
      : {};

    const submissions = await this.prisma.documentSubmission.findMany({
      where,
      orderBy: [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      take: 2000,
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
}

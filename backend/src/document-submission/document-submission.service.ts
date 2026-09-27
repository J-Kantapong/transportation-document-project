import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { assertVehicleInScope, currentWriteScope, isVehicleInScope, scopeErrorMessage, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { OwnerType } from '../generated/prisma/enums.js';
import { currentUser } from '../auth/request-context.js';
import { TaxService } from '../tax/tax.service.js';
import { bangkokToday, isoOf, toDate } from '../overview/overview-calculator.js';
import { vehicleListWhere } from '../vehicles/vehicle-list-filter.js';
import { computeDocumentFees, isMotorcycle, type DocumentFeeRuleSet, type FeeParamRow } from './document-fee-calculator.js';
import type { CreateDocumentSubmissionDto } from './dto/create-document-submission.dto.js';
import type { BulkCreateDocumentSubmissionDto, BulkDocumentSubmissionEntryDto } from './dto/bulk-create-document-submission.dto.js';
import type { PreviewBulkDocumentSubmissionDto, PreviewBulkDocumentSubmissionEntryDto } from './dto/preview-bulk-document-submission.dto.js';
import type { GovernmentTaxOwnerInput, GovernmentTaxRuleSet } from '../tax/government-tax-calculator.js';
import { ACTIVE_SUBMISSION_STATUSES, getSubmitBlockReason, OPEN_PLATE_SWAP_WHERE } from './submission-eligibility.js';
import { lockSubmissions } from './submission-lock.js';
import {
  assertPlateFormat,
  assertPlateNumberProvided,
  parseDocumentSubmissionOptions,
  parsePlateFields,
  parseReceiptAmount,
  parseReceiptNo,
  parseSubmitDate,
} from './document-submission-validation.js';

// preview-bulk และ bulk รับไม่เกินครั้งละ 1,000 คัน (หน้าเว็บแบ่งส่งคำนวณทีละ 500 ยื่นทีละ 50)
const MAX_BULK_ENTRIES = 1000;
// ยื่นหลายคัน: บันทึกพร้อมกันไม่เกินครั้งละ 8 คัน (พบ 2026-09-27: ทีละคันช้าเกินไป คันละ ~12 round trip กับฐานข้อมูลที่อยู่ไกล)
// แต่ละคันยังมี transaction + ล็อกแถวรถของตัวเอง และต่ำกว่า connection pool (10) เหลือไว้ให้คำขออื่น
const BULK_CONCURRENCY = 8;

function toRows(rows: Array<{ key: string; amount: unknown }>): FeeParamRow[] {
  return rows.map((r) => ({ key: r.key, amount: r.amount === null ? null : Number(r.amount) }));
}

// ตารางอัตราที่โหลดไว้แล้ว + createdAt ของรายการ (ยื่นหลายคัน: เรียงตามลำดับที่ส่งมา) - ไม่ส่ง = submit() โหลด/ใช้ค่าเริ่มต้นเอง
interface SubmitContext {
  feeRules?: DocumentFeeRuleSet;
  taxRules?: GovernmentTaxRuleSet;
  createdAt?: Date;
}

const OWNER_TYPE_LABEL: Record<OwnerType, string> = { INDIVIDUAL: 'บุคคลธรรมดา', JURISTIC: 'นิติบุคคล' };
export const OWNER_CHANGED_ERROR = 'ข้อมูลเจ้าของรถถูกแก้ไขแล้ว กรุณาโหลดใหม่';

// ประเภทเจ้าของรถที่ส่งมา (ownerType) ใช้ได้เฉพาะรถที่ยังไม่มีเจ้าของ คืนประเภทที่ต้องสร้างเจ้าของใหม่ (null = ใช้เจ้าของเดิม)
// ห้ามแทนเจ้าของเดิม (พบ 2026-09-27: หน้ายื่นที่เปิดค้างไว้ส่งประเภทมาทับเจ้าของที่เพิ่งกรอกในหน้าเพิ่มข้อมูลรถ ชื่อผู้ถือกรรมสิทธิ์/
// ผู้ครอบครอง/ไฟแนนซ์หายไปจากรถ) - มีเจ้าของแล้วแต่ประเภทไม่ตรงกับที่ส่งมา = หน้าจอยังเป็นข้อมูลเก่า ให้โหลดใหม่
// ต้องรู้ประเภทเจ้าของรถก่อนยื่นเสมอ (ภาษี รย.1 นิติบุคคลคูณสอง) - ระบบไม่เดาให้ (ผู้ใช้เลือกเอง 2026-09-20)
function ownerTypeToCreate(owner: { ownerType: OwnerType } | null, raw: unknown): OwnerType | null {
  if (raw === undefined) {
    if (!owner) throw new BadRequestException({ error: 'กรุณาระบุประเภทเจ้าของรถ (บุคคลธรรมดา/นิติบุคคล) ก่อนยื่น' });
    return null;
  }
  if (raw !== OwnerType.INDIVIDUAL && raw !== OwnerType.JURISTIC) {
    throw new BadRequestException({ error: 'ownerType ต้องเป็น INDIVIDUAL หรือ JURISTIC' });
  }
  if (!owner) return raw;
  if (owner.ownerType !== raw) throw new BadRequestException({ error: OWNER_CHANGED_ERROR });
  return null;
}

// วันที่ในใบเสร็จ: รับ DD/MM/YYYY (หรือ DD-MM-YYYY) ตามที่ผู้ใช้อ่าน และ YYYY-MM-DD ที่หน้าเว็บส่ง
// ปีตั้งแต่ 2400 = พ.ศ. (ใบเสร็จพิมพ์ปี พ.ศ.) แปลงเป็น ค.ศ. ให้ · error แจ้งรูปแบบ DD/MM/YYYY ตรงกับช่องกรอก (ผู้ใช้ 2026-09-25)
function parseReceiptDate(raw: unknown): Date {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(text);
  const iso = dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : text;
  const year = Number(iso.slice(0, 4));
  const ce = year >= 2400 ? `${year - 543}${iso.slice(4)}` : iso;
  try {
    const date = parseSubmitDate(ce);
    // Date.parse เลื่อนวันที่ไม่มีจริงไปเดือนถัดไป (31-02 -> 03-03) - เทียบกลับให้ตรงเป๊ะ
    if (date.toISOString().slice(0, 10) !== ce) throw new Error('invalid date');
    return date;
  } catch {
    throw new BadRequestException({ error: 'วันที่ในใบเสร็จต้องเป็น DD/MM/YYYY ที่ถูกต้อง เช่น 23/09/2026' });
  }
}

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// วันที่รับใบเสร็จ: ค.ศ. YYYY-MM-DD ที่มีจริงในปฏิทิน (31/02 ไม่ผ่าน - Date.parse เลื่อนไปเดือนถัดไปเอง)
function parseReceivedDate(raw: unknown): Date {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? toDate(text) : null;
  if (!date || Number.isNaN(date.getTime()) || isoOf(date) !== text) {
    throw new BadRequestException({ error: 'วันที่รับใบเสร็จต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
  }
  return date;
}

const plateTextOf = (v: { plateCategory: string | null; plateNumber: string | null }) =>
  v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : null;

// วันที่ในใบเสร็จต้องไม่ก่อนวันที่ยื่น (ขนส่งออกใบเสร็จหลังรับเรื่อง) และไม่หลังวันที่รับใบเสร็จกลับมา/วันนี้ (ยังไม่มีใบเสร็จ)
// ใช้ทั้งตอนบันทึกครั้งแรกและตอนแก้ย้อนหลัง (พบ 2026-09-27: เดิมตรวจแค่ตอนแก้ ค่าผิดเข้าได้ตั้งแต่บันทึกครั้งแรก)
function assertReceiptDateInRange(receiptIso: string, submittedIso: string, receivedIso: string | null | undefined) {
  if (receiptIso < submittedIso) {
    throw new BadRequestException({ error: `วันที่ในใบเสร็จต้องไม่ก่อนวันที่ยื่นเอกสาร (${dmy(submittedIso)})` });
  }
  const today = bangkokToday();
  const latest = receivedIso && receivedIso < today ? receivedIso : today;
  if (receiptIso > latest) {
    throw new BadRequestException({
      error: latest === today ? 'วันที่ในใบเสร็จต้องไม่เกินวันนี้' : `วันที่ในใบเสร็จต้องไม่หลังวันที่รับใบเสร็จ (${dmy(latest)})`,
    });
  }
}

// วันที่รับใบเสร็จกลับมาต้องอยู่ระหว่างวันที่ยื่นกับวันนี้ (พบ 2026-09-27: พิมพ์ผิดเป็นก่อนวันยื่นแล้ว
// วันที่ในใบเสร็จแก้ย้อนหลังไม่ได้อีกเลย เพราะไม่มีวันไหนอยู่ในช่วงที่อนุญาต)
function assertReceivedDateInRange(receivedIso: string, submittedIso: string) {
  if (receivedIso < submittedIso) {
    throw new BadRequestException({ error: `วันที่รับใบเสร็จต้องไม่ก่อนวันที่ยื่นเอกสาร (${dmy(submittedIso)})` });
  }
  if (receivedIso > bangkokToday()) throw new BadRequestException({ error: 'วันที่รับใบเสร็จต้องไม่เกินวันนี้' });
}

// วันที่ในใบเสร็จต้องไม่หลังวันที่รับป้าย/รับเล่มที่บันทึกไว้แล้ว - Step 6/7 ตรวจอีกด้านไว้ (วันที่รับ >= วันที่ในใบเสร็จ)
// (พบ 2026-09-27: แก้วันที่ในใบเสร็จย้อนหลังเลื่อนไปหลังวันที่รับป้าย/เล่มได้ ภาพรวมเห็นใบเสร็จออกหลังได้ป้ายแล้ว)
function assertReceiptDateNotAfterReceived(receiptIso: string, vehicle: { plateReceivedDate: Date | null; bookReceivedDate: Date | null }) {
  const received: Array<[string, Date | null]> = [
    ['วันที่รับป้าย', vehicle.plateReceivedDate],
    ['วันที่รับเล่ม', vehicle.bookReceivedDate],
  ];
  for (const [label, date] of received) {
    if (date && receiptIso > isoOf(date)) {
      throw new BadRequestException({ error: `วันที่ในใบเสร็จต้องไม่หลัง${label} (${dmy(isoOf(date))})` });
    }
  }
}

// รายการที่มีรูปใบเสร็จแนบอยู่แล้วบันทึก "ยื่นไม่สำเร็จ" / "ค้างไว้" ไม่ได้ (พบ 2026-09-27: หน้าที่เปิดค้างไว้ไม่เห็นรูปที่อีกเครื่อง
// เพิ่งแนบ แล้วบันทึก FAILED ทำให้รูปค้างอยู่กับรายการที่ไม่มีหน้าไหนเข้าถึงได้)
export const RECEIPT_ATTACHED_ERROR = 'รายการนี้มีรูปใบเสร็จแนบแล้ว - โหลดหน้าใหม่แล้วบันทึกเป็นได้ใบเสร็จ';
const NO_RECEIPT_PHOTO_ERROR = 'ต้องแนบรูปใบเสร็จก่อนบันทึกว่าได้รับใบเสร็จ';
const ALREADY_UPDATED_ERROR = 'รายการนี้อัปเดตสถานะไปแล้ว';

// ตาราง "ได้ใบเสร็จแล้ว" โหลดทีละหน้า (โหลดเพิ่ม) - รายการอื่นๆ เอาทีเดียวเหมือนเดิม
const RECEIVED_PAGE_SIZE = 100;
const LIST_LIMIT = 2000;

// สรุปรายการค่าธรรมเนียมเป็นข้อความสั้นๆ ไว้เก็บใน VehicleEditLog ตอนยกเลิกรายการ ("ลงขัน 200, ค่าอากร 10")
function describeItems(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return '-';
  return items.map((i: { label?: unknown; amount?: unknown }) => `${String(i?.label ?? '')} ${Number(i?.amount ?? 0)}`).join(', ');
}

@Injectable()
export class DocumentSubmissionService {
  // createdAt ล่าสุดที่ submitBulk แจกไปแล้ว (มิลลิวินาที) - คำขอถัดไปเริ่มต่อจากนี้
  private lastBulkCreatedAt = 0;

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

  // ฐานข้อมูลมีตารางงานสลับเลขแล้วหรือยัง - ยังไม่ได้รันไมเกรชัน (P2021) ถือว่าไม่มีงานสลับเลข
  // เช็กนอก transaction ของ submit() (คำสั่งที่ error ใน transaction ของ Postgres ทำให้ทั้ง transaction ใช้ต่อไม่ได้)
  // เจอตารางแล้วจำไว้ ไม่ต้องเช็กซ้ำทุกคัน
  private plateSwapTableReady = false;
  private async hasPlateSwapTable(): Promise<boolean> {
    if (this.plateSwapTableReady) return true;
    try {
      await this.prisma.plateSwap.findFirst({ select: { id: true } });
      this.plateSwapTableReady = true;
      return true;
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2021') return false;
      throw err;
    }
  }

  // ต้องผ่าน Step 2 (แจ้งย้าย/ตัดบัญชี) + ตรวจรถผ่านภายใน 90 วัน และยังไม่เคยยื่นที่ค้างอยู่/ได้ใบเสร็จแล้ว -
  // ดูกฎทั้งหมดใน submission-eligibility.ts · client = transaction ของ submit() (อ่านหลังล็อกแถวรถแล้ว)
  // งานสลับเลขที่ยังเปิดอยู่ของรถคันนี้ (งานไหนก็ได้ ไม่ใช่แค่งานล่าสุด - ผู้ใช้ 2026-09-27) อ่านหลังล็อกแถวรถเช่นกัน:
  // การผูกรถใหม่กับงานสลับเลขล็อกแถวรถเดียวกัน (PlateSwapService) จึงผูกแทรกระหว่างตรวจกับบันทึกไม่ได้
  private async assertEligible(
    vehicle: {
      id: string;
      transferDone: boolean;
      inspectionSentDate: Date | null;
      inspectionResult: string | null;
      inspectionResultDate: Date | null;
    },
    submitDate: Date,
    checkPlateSwap: boolean,
    client: Pick<Prisma.TransactionClient, 'documentSubmission' | 'plateSwap'> = this.prisma,
  ) {
    const active = await client.documentSubmission.findFirst({
      where: { vehicleId: vehicle.id, status: { in: ACTIVE_SUBMISSION_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    const plateSwap = checkPlateSwap
      ? await client.plateSwap.findFirst({ where: { newVehicleId: vehicle.id, ...OPEN_PLATE_SWAP_WHERE }, select: { returnedDate: true } })
      : null;
    const reason = getSubmitBlockReason({ ...vehicle, activeSubmissionStatus: active?.status ?? null, plateSwap }, submitDate);
    if (reason) throw new BadRequestException({ error: reason });
  }

  // preview ค่าธรรมเนียม + ภาษีหลายคันในคำขอเดียว (หน้ายื่นเอกสาร: เพิ่มจากคิว/แก้ตัวเลือกหลายคันพร้อมกัน)
  // - คำนวณแบบเดียวกับ submit(): ownerType ใช้ได้เฉพาะรถที่ยังไม่มีเจ้าของ (ดู ownerTypeToCreate)
  // ไม่ส่งมา = ใช้เจ้าของรถเดิม รายการที่พังคืน error รายคัน ไม่ throw ทั้งชุด
  async previewBulk(dto: PreviewBulkDocumentSubmissionDto) {
    if (!dto || !Array.isArray(dto.entries)) throw new BadRequestException({ error: 'entries ต้องเป็น array' });
    const entries = dto.entries as PreviewBulkDocumentSubmissionEntryDto[];
    if (entries.length > MAX_BULK_ENTRIES) {
      throw new BadRequestException({ error: `รองรับไม่เกิน ${MAX_BULK_ENTRIES.toLocaleString('en-US')} คันต่อครั้ง` });
    }
    const vehicleIds = Array.from(new Set(entries.map((e) => e?.vehicleId).filter((id): id is string => typeof id === 'string')));
    const [vehicles, rules] = await Promise.all([
      this.prisma.vehicle.findMany({ where: { id: { in: vehicleIds }, deletedAt: null }, include: { owner: true } }),
      this.loadRuleSet(),
    ]);
    const byId = new Map(vehicles.map((v) => [v.id, v]));

    type Computed =
      | { vehicleId: unknown; error: string }
      | { vehicleId: string; fee: ReturnType<typeof computeDocumentFees>; taxInput: Parameters<TaxService['previewMany']>[0][number] };
    const scope = currentWriteScope(); // ยื่นได้เฉพาะประเภทรถที่บัญชีนี้แก้ได้
    const computed: Computed[] = entries.map((entry) => {
      const vehicle = typeof entry?.vehicleId === 'string' ? byId.get(entry.vehicleId) : undefined;
      if (!vehicle) return { vehicleId: entry?.vehicleId, error: 'ไม่พบข้อมูลรถ' };
      if (!isVehicleInScope(vehicle.body, scope)) return { vehicleId: vehicle.id, error: scopeErrorMessage(scope) };
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
        // กฎเดียวกับ submit(): มีเจ้าของอยู่แล้ว = ใช้ของเดิม (ประเภทไม่ตรงกับที่ส่งมา = หน้าจอเก่า คืน error ให้โหลดใหม่)
        if (entry.ownerType !== undefined) {
          const newOwnerType = ownerTypeToCreate(vehicle.owner, entry.ownerType);
          if (newOwnerType) owner = { ownerType: newOwnerType, isHirePurchaseBusiness: false, hirerType: null };
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
        // Error ธรรมดา (เช่น "ไม่พบข้อมูลค่าธรรมเนียม: <key>" จาก lookupFee) ส่งข้อความต่อให้เห็นสาเหตุ (พบ 2026-09-27)
        const responseMessage = (err as { response?: { error?: string } })?.response?.error;
        const plainMessage = err instanceof Error && !(err instanceof HttpException) ? err.message : undefined;
        return { vehicleId: vehicle.id, error: responseMessage ?? (plainMessage || 'คำนวณค่าธรรมเนียมไม่สำเร็จ') };
      }
    });

    const ok = computed.filter((c): c is Extract<Computed, { fee: unknown }> => 'fee' in c);
    const taxes = await this.taxService.previewMany(ok.map((c) => c.taxInput));
    const taxByEntry = new Map(ok.map((c, i) => [c, taxes[i]]));
    return {
      results: computed.map((c) => ('fee' in c ? { vehicleId: c.vehicleId, fee: c.fee, tax: taxByEntry.get(c) } : c)),
    };
  }

  // ยื่นรถ 1 คัน: บันทึก DocumentSubmission (snapshot ค่าธรรมเนียม) + TaxCalculation และเจ้าของรถ/เลขทะเบียนบน Vehicle
  // (mutable, ไม่ใช่ส่วนหนึ่งของ snapshot) ใน transaction เดียว - ใช้จาก submitBulk (และ unit test)
  // ล็อกแถวรถก่อนแล้วตรวจสิทธิ์ยื่นกับข้อมูลล่าสุด (พบ 2026-09-27: เดิมตรวจก่อนแล้วค่อยเขียนนอก transaction กดยืนยันจาก 2 แท็บ
  // หรือกดซ้ำตอนเน็ตหลุดได้ 2 รายการที่รอใบเสร็จของรถคันเดียว) คำขออื่นของรถคันนี้ (รวมการลบรถ) ต้องรอจนบันทึกเสร็จ
  // ctx: ตารางอัตราที่โหลดไว้แล้ว (ยื่นหลายคันโหลดครั้งเดียว) และ createdAt ที่เรียงตามลำดับในคำขอ
  async submit(vehicleId: string, dto: CreateDocumentSubmissionDto, ctx: SubmitContext = {}) {
    const submitDate = parseSubmitDate(dto.submitDate);
    const plateCategory = parsePlateFields(dto.plateCategory, 'plateCategory');
    const plateNumber = parsePlateFields(dto.plateNumber, 'plateNumber');
    const feeRules = ctx.feeRules ?? (await this.loadRuleSet());
    const checkPlateSwap = await this.hasPlateSwapTable();

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ${vehicleId} FOR UPDATE`;
        const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId, deletedAt: null }, include: { owner: true } });
        if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
        assertVehicleInScope(vehicle.body); // STAFF_CAR / STAFF_MOTO ยื่นได้เฉพาะประเภทรถของตัวเอง
        await this.assertEligible(vehicle, submitDate, checkPlateSwap, tx);
        const options = parseDocumentSubmissionOptions(dto, isMotorcycle(vehicle.body));
        assertPlateNumberProvided(options.plateNumberOption, plateCategory, plateNumber);
        const fees = computeDocumentFees(
          { body: vehicle.body, registrationProvince: vehicle.registrationProvince, ownerProvince: vehicle.ownerProvince },
          options,
          feeRules,
        );

        // อัปเดตเจ้าของรถ/เลขทะเบียนก่อนคำนวณภาษี - TaxService.calculateAndSave อ่าน Vehicle.ownerId จาก DB
        // ตรงๆ ไม่รับเป็น parameter จึงต้อง persist ก่อนเรียก ไม่งั้นภาษีจะคำนวณจากเจ้าของรถอันเก่า/ยังไม่มี
        const vehicleUpdateData: { ownerId?: string; plateCategory?: string | null; plateNumber?: string | null } = {};
        const newOwnerType = ownerTypeToCreate(vehicle.owner, dto.ownerType);
        if (newOwnerType) {
          // รถเก่าที่ยังไม่มีเจ้าของ: ผู้ใช้เลือกแค่ประเภท - สร้างแถวแบบไม่ระบุชื่อ แล้วเก็บไว้ในประวัติการแก้ไขของรถ
          const owner = await tx.vehicleOwner.create({
            data: { ownerType: newOwnerType, isHirePurchaseBusiness: false, hirerType: null },
            select: { id: true },
          });
          vehicleUpdateData.ownerId = owner.id;
          await tx.vehicleEditLog.create({
            data: {
              vehicleId,
              remark: 'ระบุประเภทเจ้าของรถตอนยื่นเอกสาร',
              changes: JSON.stringify({ owner: { from: null, to: OWNER_TYPE_LABEL[newOwnerType] } }),
              editedById: currentUser()?.id ?? null,
            },
          });
        }
        if (dto.plateCategory !== undefined) vehicleUpdateData.plateCategory = plateCategory;
        if (dto.plateNumber !== undefined) vehicleUpdateData.plateNumber = plateNumber;
        if (Object.keys(vehicleUpdateData).length > 0) {
          await tx.vehicle.update({ where: { id: vehicleId }, data: vehicleUpdateData });
        }

        const taxCalculation = await this.taxService.calculateAndSave(vehicleId, { client: tx, rules: ctx.taxRules });

        const submission = await tx.documentSubmission.create({
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
            ...(ctx.createdAt ? { createdAt: ctx.createdAt } : {}),
          },
        });

        return { submission, taxCalculation };
      },
      { timeout: 20_000 },
    );
  }

  // best-effort: บันทึกเท่าที่ทำได้ แล้วคืนรายการที่พลาดพร้อมเหตุผล ไม่ throw ทั้งชุดเมื่อบางคันพัง
  // (ยืนยันกับผู้ใช้แล้วตอนวางแผน - ดู plan file) ไม่เกิน 1,000 คันต่อคำขอ (หน้าเว็บแบ่งส่งทีละ 50)
  // createdAt กำหนดตามลำดับในคำขอก่อนเริ่มบันทึก (พบ 2026-09-27: เดิมใช้เวลาที่บันทึกเสร็จ ลำดับในใบส่งงานไม่ตรงกับที่เลือกและสลับ
  // ทุกครั้ง) คันไหนบันทึกเสร็จก่อนก็ได้ ใบส่งงานยังเรียงตามที่เลือก · บันทึกพร้อมกันไม่เกิน BULK_CONCURRENCY คัน ไม่ให้ transaction
  // เปิดค้างเกิน connection pool
  async submitBulk(dto: BulkCreateDocumentSubmissionDto) {
    if (!dto || !Array.isArray(dto.entries)) throw new BadRequestException({ error: 'entries ต้องเป็น array' });
    const entries = dto.entries as BulkDocumentSubmissionEntryDto[];
    if (entries.length > MAX_BULK_ENTRIES) {
      throw new BadRequestException({ error: `ยื่นได้ไม่เกิน ${MAX_BULK_ENTRIES.toLocaleString('en-US')} คันต่อครั้ง` });
    }

    const succeeded: Array<{ vehicleId: string; submission: unknown }> = [];
    const failed: Array<{ vehicleId: unknown; error: string }> = [];

    // รถคันเดียวกันซ้ำในชุดเดียวกัน - รับแค่แถวแรก (แถวถัดไปรอล็อกแถวรถแล้วติดยื่นซ้ำอยู่แล้ว แต่บอกเหตุผลให้ตรงกว่า)
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
    if (unique.length === 0) return { succeeded, failed };

    const [feeRules, taxRules] = await Promise.all([this.loadRuleSet(), this.taxService.loadRuleSet()]);
    // คันที่ i ได้ base + i มิลลิวินาที - base ไล่ต่อจากคำขอก่อนหน้าเสมอ (หน้าเว็บส่งทีละชุด ชุดหลังต้องอยู่หลังชุดแรกในใบส่งงาน)
    const base = Math.max(Date.now(), this.lastBulkCreatedAt + 1);
    this.lastBulkCreatedAt = base + unique.length - 1;
    const outcomes: Array<{ vehicleId: string; submission: unknown } | { vehicleId: unknown; error: string }> = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < unique.length) {
        const index = nextIndex++;
        const entry = unique[index];
        const vehicleId = entry?.vehicleId;
        if (typeof vehicleId !== 'string' || !vehicleId) {
          outcomes[index] = { vehicleId, error: 'vehicleId ไม่ถูกต้อง' };
          continue;
        }
        try {
          const result = await this.submit(vehicleId, entry, { feeRules, taxRules, createdAt: new Date(base + index) });
          outcomes[index] = { vehicleId, submission: result.submission };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ';
          const responseMessage = (err as { response?: { error?: string } })?.response?.error;
          outcomes[index] = { vehicleId, error: responseMessage ?? message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, unique.length) }, worker));

    // ผลเรียงตามลำดับที่ส่งมา ไม่ใช่ลำดับที่บันทึกเสร็จ
    for (const outcome of outcomes) {
      if ('error' in outcome) failed.push(outcome);
      else succeeded.push(outcome);
    }
    return { succeeded, failed };
  }

  // วันที่ยื่นทั้งหมดพร้อมจำนวนรายการ (ทุกสถานะ) ในขอบเขตประเภทรถของผู้ใช้ ใหม่สุดก่อน - หน้าดูข้อมูลที่ยื่นแล้วใช้ทำตัวเลือกวันที่
  // แล้วโหลดรายการทีละวันด้วย listByDate (พบ 2026-09-27: เดิมหน้านั้นโหลด 2,000 รายการล่าสุดแล้วสร้างวันที่เอง วันเก่าหายเงียบๆ
  // วันที่อยู่ขอบได้ไม่ครบแล้วพิมพ์ใบส่งงานขาด) - key เป็นวันที่ UTC แบบเดียวกับตัวกรอง date ของ listByDate
  async listDates() {
    const groups = await this.prisma.documentSubmission.groupBy({
      by: ['submitDate'],
      where: { vehicle: vehicleTypeWhere() }, // STAFF_CAR / STAFF_MOTO เห็นเฉพาะประเภทรถของตัวเอง
      _count: { _all: true },
      orderBy: { submitDate: 'desc' },
    });
    const counts = new Map<string, number>();
    for (const g of groups) {
      const date = g.submitDate.toISOString().slice(0, 10);
      counts.set(date, (counts.get(date) ?? 0) + g._count._all);
    }
    return { dates: [...counts].map(([date, count]) => ({ date, count })) };
  }

  // status: กรองตามสถานะ (หน้ารับใบเสร็จใช้ PENDING = รอใบเสร็จ / RECEIPT_RECEIVED = รับแล้ว)
  // kind (car | moto) กรองประเภทรถก่อนตัดจำนวน · q ค้นเลขตัวถัง/ทะเบียน/ลูกค้า/เลขที่ใบเสร็จ · offset = โหลดเพิ่ม (ดู hasMore)
  // (พบ 2026-09-27: ตาราง "ได้ใบเสร็จแล้ว" ได้แค่ 100 ใบล่าสุดรวมรถยนต์กับมอเตอร์ไซค์ ใบที่เก่ากว่านั้นแก้วันที่ไม่ได้)
  async listByDate(dateIso?: string, status?: string, filters: { kind?: string; q?: string; offset?: string } = {}) {
    if (dateIso !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
      throw new BadRequestException({ error: 'date ต้องเป็น ค.ศ. YYYY-MM-DD' });
    }
    if (status !== undefined && !['PENDING', 'RECEIPT_RECEIVED', 'FAILED'].includes(status)) {
      throw new BadRequestException({ error: 'status ต้องเป็น PENDING, RECEIPT_RECEIVED หรือ FAILED' });
    }
    const kind = filters.kind?.trim() || undefined;
    if (kind !== undefined && kind !== 'car' && kind !== 'moto') throw new BadRequestException({ error: 'kind ต้องเป็น car หรือ moto' });
    const offsetText = filters.offset?.trim() || '0';
    if (!/^\d{1,6}$/.test(offsetText)) throw new BadRequestException({ error: 'offset ต้องเป็นจำนวนเต็มตั้งแต่ 0' });
    const q = filters.q?.trim() ?? '';
    const where: Prisma.DocumentSubmissionWhereInput = {
      ...(dateIso
        ? {
            submitDate: {
              gte: new Date(`${dateIso}T00:00:00.000Z`),
              lt: new Date(new Date(`${dateIso}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000),
            },
          }
        : {}),
      ...(status ? { status } : {}),
      AND: [
        { vehicle: vehicleTypeWhere() }, // STAFF_CAR / STAFF_MOTO เห็นเฉพาะประเภทรถของตัวเอง
        ...(kind ? [{ vehicle: vehicleTypeWhere(kind === 'moto' ? 'MOTO' : 'CAR') }] : []),
        ...(q ? [{ OR: [{ vehicle: vehicleListWhere({ q }) }, { receiptNo: { contains: q, mode: 'insensitive' as const } }] }] : []),
      ],
    };

    const take = status === 'RECEIPT_RECEIVED' ? RECEIVED_PAGE_SIZE : LIST_LIMIT;
    // โหลดเพิ่มด้วย offset: เรียงด้วยค่าที่ไม่เปลี่ยนตอนแก้ข้อมูล + id ให้ลำดับตายตัว (พบ 2026-09-27: เดิมเรียงรอง updatedAt
    // แก้ใบเสร็จแล้วแถวย้ายที่ "โหลดเพิ่ม" ข้ามไป 1 แถว) - แก้วันที่รับแล้วแถวย้าย หน้าเว็บจัดการเอง (ReceiptCheckPage)
    const rows = await this.prisma.documentSubmission.findMany({
      where,
      orderBy:
        status === 'RECEIPT_RECEIVED'
          ? [{ receiptReceivedDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
          : [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      skip: Number(offsetText),
      take: take + 1, // เกินมา 1 แถว = ยังมีหน้าถัดไป
      include: {
        vehicle: {
          select: {
            chassis: true,
            body: true,
            plateCategory: true,
            plateNumber: true,
            // id = กุญแจใบยื่น/ใบส่งงาน (ผู้ใช้ 2026-09-27: รหัสลูกค้าทุกหน้า ชื่อซ้ำกันได้) - ชื่อ/บริษัท/สาขาใช้แสดงเท่านั้น
            customer: { select: { id: true, name: true, company: true, branch: true } },
            brand: { select: { name: true } },
            owner: { select: { name: true, ownerType: true, hirerType: true, financeCompanyId: true } },
            // วันที่ตรวจผ่าน - หน้ายกเลิกรายการเตือนเมื่อผลตรวจหมดอายุแล้ว (ยกเลิกแล้วต้องส่งตรวจรอบ 2 - พบ 2026-09-27)
            inspectionResultDate: true,
          },
        },
        // รูปใบเสร็จที่แนบแล้ว - ตัวรูปโหลดผ่าน GET /api/receipts/:id/image
        // readPending = รูปที่พนักงานจับคู่เองระหว่างที่ AI ยังอ่านอยู่ - หน้าเว็บถามผลต่อด้วย GET /api/receipts?ids=
        receipts: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, extractionSource: true, extraction: true, readPending: true, createdAt: true },
        },
      },
    });
    return { submissions: rows.slice(0, take), hasMore: rows.length > take };
  }

  // เปลี่ยนสถานะได้ครั้งเดียวจาก PENDING -> RECEIPT_RECEIVED หรือ FAILED เท่านั้น (ห้ามย้อนกลับ/เปลี่ยนซ้ำ)
  // การอัปเดตนี้ปลด block การยื่นซ้ำของรถคันนั้นใน assertNotPending()
  // ใช้จาก saveReceiptCheck เท่านั้น (พบ 2026-09-27: ถอด PATCH .../:id/status ที่หน้าเว็บเลิกใช้แล้วออก - เคยข้ามการบังคับแนบรูปได้)
  // receivedDate (ค.ศ. YYYY-MM-DD) ใช้เฉพาะ RECEIPT_RECEIVED - ไม่ส่งมาจะใช้วันนี้ตามเวลาไทย
  // RECEIPT_RECEIVED ต้องมีรูปใบเสร็จอย่างน้อย 1 รูป + เลขทะเบียน (หมวด+เลข) - ใช้ที่ส่งมา หรือที่รถคันนี้มีอยู่แล้วถ้าไม่ได้ส่ง
  // (FAILED ไม่ต้องมี แต่ต้องไม่มีรูปใบเสร็จ) และบันทึกลง Vehicle.plateCategory/plateNumber; receiptAmount/receiptNo (ไม่บังคับ) = ยอด/เลขที่บนใบเสร็จจริง
  // เขียนแบบมีเงื่อนไข (where status PENDING + เงื่อนไขรูป) (พบ 2026-09-27: เดิมเช็กแล้วค่อยเขียน สองคนบันทึกพร้อมกันทับกันได้
  // หรือรูปถูกแนบ/ถอดระหว่างนั้น)
  private async updateStatus(
    submissionId: string,
    statusRaw: unknown,
    receivedDateRaw?: unknown,
    extras: { plateCategory?: unknown; plateNumber?: unknown; receiptAmount?: unknown; receiptNo?: unknown; receiptDate?: unknown; failRemark?: unknown } = {},
  ): Promise<void> {
    if (statusRaw !== 'RECEIPT_RECEIVED' && statusRaw !== 'FAILED') {
      throw new BadRequestException({ error: 'status ต้องเป็น RECEIPT_RECEIVED หรือ FAILED' });
    }
    const submission = await this.prisma.documentSubmission.findUnique({
      where: { id: submissionId },
      include: { vehicle: { select: { plateCategory: true, plateNumber: true, body: true } }, _count: { select: { receipts: true } } },
    });
    if (!submission) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    assertVehicleInScope(submission.vehicle.body); // STAFF_CAR / STAFF_MOTO รับใบเสร็จได้เฉพาะประเภทรถของตัวเอง
    if (submission.status !== 'PENDING') {
      throw new BadRequestException({ error: ALREADY_UPDATED_ERROR });
    }

    // ยื่นไม่สำเร็จ = รถกลับไปทำ Step 4 ใหม่ได้ (กฎของผู้ใช้) แต่ต้องมีเหตุผลทุกครั้ง - แสดงในคิวรอยื่นเอกสาร
    if (statusRaw === 'FAILED') {
      const failRemark = typeof extras.failRemark === 'string' ? extras.failRemark.trim() : '';
      if (!failRemark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่ยื่นไม่สำเร็จ' });
      if (submission._count.receipts > 0) throw new BadRequestException({ error: RECEIPT_ATTACHED_ERROR });
      // ล็อกแถวก่อนเขียน: รูปที่อีกเครื่องกำลังแนบ/จับคู่เข้ามา (ล็อกแถวเดียวกัน) ต้องเสร็จก่อน แล้วเงื่อนไข "ไม่มีรูป" จะเห็นรูปนั้น
      await this.prisma.$transaction(async (tx) => {
        await lockSubmissions(tx, [submissionId]);
        const { count } = await tx.documentSubmission.updateMany({
          where: { id: submissionId, status: 'PENDING', receipts: { none: {} } },
          data: { status: 'FAILED', receiptReceivedDate: null, receiptDate: null, failRemark },
        });
        if (count === 0) throw await this.notUpdatedError(submissionId, RECEIPT_ATTACHED_ERROR, tx);
      });
      return;
    }

    if (submission._count.receipts === 0) throw new BadRequestException({ error: NO_RECEIPT_PHOTO_ERROR });
    const plateCategory =
      extras.plateCategory !== undefined ? parsePlateFields(extras.plateCategory, 'plateCategory') : submission.vehicle.plateCategory;
    const plateNumber = extras.plateNumber !== undefined ? parsePlateFields(extras.plateNumber, 'plateNumber') : submission.vehicle.plateNumber;
    if (!plateCategory || !plateNumber) {
      throw new BadRequestException({ error: 'กรุณากรอกหมวดทะเบียนและเลขทะเบียนก่อนบันทึกการรับใบเสร็จ' });
    }
    assertPlateFormat(plateCategory, plateNumber);
    const receiptAmount = parseReceiptAmount(extras.receiptAmount);
    const receiptNo = parseReceiptNo(extras.receiptNo);
    // วันที่รับใบเสร็จ: ไม่ส่งมา = วันนี้ตามเวลาไทย (พบ 2026-09-27: เดิมใช้วันที่ UTC ช่วงตี 0-7 ได้เป็นเมื่อวาน)
    const receiptReceivedDate =
      receivedDateRaw === undefined || receivedDateRaw === null || receivedDateRaw === '' ? toDate(bangkokToday()) : parseReceivedDate(receivedDateRaw);
    // วันที่ในใบเสร็จ: กรมขนส่งออกใบเสร็จวันที่ยื่น (ข้อมูลจริง 59/59 ใบ 2026-09-25) - ไม่ได้ส่งมาใช้วันที่ยื่น
    const receiptDate =
      extras.receiptDate === undefined || extras.receiptDate === null || extras.receiptDate === '' ? submission.submitDate : parseReceiptDate(extras.receiptDate);
    // ตรวจช่วงวันที่ตั้งแต่บันทึกครั้งแรก เหมือนตอนแก้ย้อนหลัง: วันที่ยื่น <= วันที่ในใบเสร็จ <= วันที่รับใบเสร็จ <= วันนี้
    const submitted = isoOf(submission.submitDate);
    assertReceivedDateInRange(isoOf(receiptReceivedDate), submitted);
    assertReceiptDateInRange(isoOf(receiptDate), submitted, isoOf(receiptReceivedDate));

    await this.prisma.$transaction(async (tx) => {
      await lockSubmissions(tx, [submissionId]); // รูปที่กำลังถูกย้าย/ลบออกจากรายการนี้ต้องเสร็จก่อน (ดู submission-lock.ts)
      const { count } = await tx.documentSubmission.updateMany({
        where: { id: submissionId, status: 'PENDING', receipts: { some: {} } },
        data: { status: 'RECEIPT_RECEIVED', receiptReceivedDate, receiptDate, receiptAmount, receiptNo },
      });
      if (count === 0) throw await this.notUpdatedError(submissionId, NO_RECEIPT_PHOTO_ERROR, tx);
      await tx.vehicle.update({ where: { id: submission.vehicleId }, data: { plateCategory, plateNumber } });
    });
  }

  // เขียนแบบมีเงื่อนไขแล้วไม่โดนแถวไหน: อ่านใหม่เพื่อบอกเหตุผลที่ตรง - สถานะเปลี่ยนไปแล้ว หรือเงื่อนไขรูปใบเสร็จไม่ตรง (photoError)
  private async notUpdatedError(
    submissionId: string,
    photoError: string,
    client: Pick<Prisma.TransactionClient, 'documentSubmission'> = this.prisma,
  ): Promise<Error> {
    const current = await client.documentSubmission.findUnique({ where: { id: submissionId }, select: { status: true } });
    if (!current) return new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    return new BadRequestException({ error: current.status !== 'PENDING' ? ALREADY_UPDATED_ERROR : photoError });
  }

  // ค้างไว้ (CARRY): ยังไม่ได้ใบเสร็จและยังไม่รู้สาเหตุ -> ยังอยู่ในใบยื่นเดิม ขึ้นว่า "ยังขาด" (ยัง PENDING)
  // ตรวจประเภทรถของผู้ใช้เหมือน RECEIVED/FAILED และต้องยังไม่มีรูปใบเสร็จ (พบ 2026-09-27: หน้าที่เปิดค้างไว้ไม่เห็นรูป
  // ที่อีกเครื่องเพิ่งแนบ แล้วบันทึกค้างทับ)
  private async carry(submissionId: string): Promise<void> {
    const submission = await this.prisma.documentSubmission.findUnique({
      where: { id: submissionId },
      select: { status: true, vehicle: { select: { body: true } }, _count: { select: { receipts: true } } },
    });
    if (!submission) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    assertVehicleInScope(submission.vehicle.body);
    if (submission.status !== 'PENDING') throw new BadRequestException({ error: 'รายการนี้ไม่ได้รอใบเสร็จอยู่แล้ว' });
    if (submission._count.receipts > 0) throw new BadRequestException({ error: RECEIPT_ATTACHED_ERROR });
    await this.prisma.$transaction(async (tx) => {
      await lockSubmissions(tx, [submissionId]); // เหมือนยื่นไม่สำเร็จ: รอรูปที่กำลังแนบเข้ามาก่อน
      const { count } = await tx.documentSubmission.updateMany({
        where: { id: submissionId, status: 'PENDING', receipts: { none: {} } },
        data: { receiptCarriedAt: new Date() },
      });
      if (count === 0) throw await this.notUpdatedError(submissionId, RECEIPT_ATTACHED_ERROR, tx);
    });
  }

  // แก้วันที่ในใบเสร็จย้อนหลัง (ผู้ใช้ 2026-09-25) - เฉพาะรายการที่ได้ใบเสร็จแล้ว, รับ ค.ศ. YYYY-MM-DD
  // ไม่แตะสถานะหรือช่องอื่น (สถานะยังเปลี่ยนได้ครั้งเดียวตาม updateStatus)
  // แก้ย้อนหลังต้องมีเหตุผล (ผู้ใช้ 2026-09-25) เก็บลง VehicleEditLog และวันที่ต้องสมเหตุสมผล:
  // ไม่ก่อนวันที่ยื่น (ขนส่งออกใบเสร็จหลังรับเรื่อง) และไม่หลังวันที่รับใบเสร็จกลับมา/วันนี้ (ยังไม่มีใบเสร็จ)
  async updateReceiptDate(submissionId: string, receiptDateRaw: unknown, remarkRaw?: unknown) {
    const receiptDate = parseReceiptDate(receiptDateRaw);
    const remark = typeof remarkRaw === 'string' ? remarkRaw.trim() : '';
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่แก้วันที่ในใบเสร็จ' });
    const submission = await this.prisma.documentSubmission.findUnique({
      where: { id: submissionId },
      select: {
        status: true,
        vehicleId: true,
        submitDate: true,
        receiptDate: true,
        receiptReceivedDate: true,
        vehicle: { select: { body: true, plateReceivedDate: true, bookReceivedDate: true } },
      },
    });
    if (!submission) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    assertVehicleInScope(submission.vehicle.body);
    if (submission.status !== 'RECEIPT_RECEIVED') {
      throw new BadRequestException({ error: 'แก้วันที่ในใบเสร็จได้เฉพาะรายการที่ได้ใบเสร็จแล้ว' });
    }
    const iso = isoOf(receiptDate);
    assertReceiptDateInRange(iso, isoOf(submission.submitDate), submission.receiptReceivedDate ? isoOf(submission.receiptReceivedDate) : null);
    const before = submission.receiptDate ? isoOf(submission.receiptDate) : null;
    if (before === iso) throw new BadRequestException({ error: 'วันที่ไม่ได้เปลี่ยน' });
    assertReceiptDateNotAfterReceived(iso, submission.vehicle);
    const [updated] = await this.prisma.$transaction([
      this.prisma.documentSubmission.update({ where: { id: submissionId }, data: { receiptDate } }),
      this.prisma.vehicleEditLog.create({
        data: {
          vehicleId: submission.vehicleId,
          remark,
          changes: JSON.stringify({ 'submission.receiptDate': { from: before, to: iso } }),
          editedById: currentUser()?.id ?? null,
        },
      }),
    ]);
    return updated;
  }

  // แก้ข้อมูลใบเสร็จของรายการที่ได้ใบเสร็จแล้ว (ผู้ใช้ 2026-09-27 เลือกแบบ ก): ทะเบียน (เขียนลง Vehicle) เลขที่ใบเสร็จ ยอด
  // วันที่รับใบเสร็จ และวันที่ในใบเสร็จ (แก้พร้อมกันได้ ตรวจช่วงวันที่ด้วยค่าใหม่ทั้งคู่) - ส่งมาเฉพาะช่องที่แก้
  // ไม่เปลี่ยนสถานะ (ได้ใบเสร็จแล้ว = จดทะเบียนแล้ว ห้ามย้อน) ต้องมีเหตุผล เก็บค่าเดิม/ค่าใหม่ลง VehicleEditLog
  // ใบส่งงาน/บิลที่ออกไปแล้วเก็บ snapshot ทะเบียน/เลขที่ใบเสร็จ (บิลเก็บยอดด้วย) ไว้ ไม่แก้ตาม - ตอบ liveSlips / liveInvoices ให้หน้าเว็บเตือน
  // วันที่ในใบเสร็จต้องไม่หลังวันที่รับป้าย/รับเล่มที่บันทึกแล้ว (assertReceiptDateNotAfterReceived)
  async updateReceiptFields(
    submissionId: string,
    body: {
      plateCategory?: unknown;
      plateNumber?: unknown;
      receiptNo?: unknown;
      receiptAmount?: unknown;
      receiptDate?: unknown;
      receiptReceivedDate?: unknown;
      remark?: unknown;
    } = {},
  ) {
    const input = body ?? {};
    const remark = typeof input.remark === 'string' ? input.remark.trim() : '';
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่แก้ข้อมูลใบเสร็จ' });
    const submission = await this.prisma.documentSubmission.findUnique({
      where: { id: submissionId },
      select: {
        status: true,
        vehicleId: true,
        submitDate: true,
        receiptDate: true,
        receiptReceivedDate: true,
        receiptNo: true,
        receiptAmount: true,
        vehicle: { select: { body: true, plateCategory: true, plateNumber: true, plateReceivedDate: true, bookReceivedDate: true } },
      },
    });
    if (!submission) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    assertVehicleInScope(submission.vehicle.body);
    if (submission.status !== 'RECEIPT_RECEIVED') {
      throw new BadRequestException({ error: 'แก้ข้อมูลใบเสร็จได้เฉพาะรายการที่ได้ใบเสร็จแล้ว' });
    }

    const changes: Record<string, { from: string | null; to: string | null }> = {};
    const data: { receiptNo?: string | null; receiptAmount?: number | null; receiptDate?: Date; receiptReceivedDate?: Date } = {};
    let plate: { plateCategory: string; plateNumber: string } | null = null;

    // ทะเบียน: ส่งมาช่องเดียวก็ได้ อีกช่องใช้ค่าเดิม - ได้ใบเสร็จแล้วต้องมีครบทั้งหมวดและเลข
    if (input.plateCategory !== undefined || input.plateNumber !== undefined) {
      const plateCategory =
        input.plateCategory !== undefined ? parsePlateFields(input.plateCategory, 'plateCategory') : submission.vehicle.plateCategory;
      const plateNumber = input.plateNumber !== undefined ? parsePlateFields(input.plateNumber, 'plateNumber') : submission.vehicle.plateNumber;
      if (!plateCategory || !plateNumber) throw new BadRequestException({ error: 'กรุณากรอกหมวดทะเบียนและเลขทะเบียน' });
      assertPlateFormat(plateCategory, plateNumber);
      const from = plateTextOf(submission.vehicle);
      const to = plateTextOf({ plateCategory, plateNumber });
      if (from !== to) {
        plate = { plateCategory, plateNumber };
        changes.plate = { from, to };
      }
    }
    if (input.receiptNo !== undefined) {
      const receiptNo = parseReceiptNo(input.receiptNo);
      if (receiptNo !== submission.receiptNo) {
        data.receiptNo = receiptNo;
        changes['submission.receiptNo'] = { from: submission.receiptNo, to: receiptNo };
      }
    }
    if (input.receiptAmount !== undefined) {
      const receiptAmount = parseReceiptAmount(input.receiptAmount);
      const before = submission.receiptAmount === null ? null : Number(submission.receiptAmount);
      if (receiptAmount !== before) {
        data.receiptAmount = receiptAmount;
        changes['submission.receiptAmount'] = { from: before === null ? null : String(before), to: receiptAmount === null ? null : String(receiptAmount) };
      }
    }
    // วันที่: ช่องที่ไม่ได้ส่งใช้ค่าเดิม แล้วตรวจช่วงร่วมกัน วันที่ยื่น <= วันที่ในใบเสร็จ <= วันที่รับใบเสร็จ <= วันนี้
    // ตรวจเฉพาะเมื่อวันที่เปลี่ยนจริง - แก้แค่ทะเบียนของแถวเก่าที่วันที่ไม่สมเหตุสมผลก็ยังแก้ได้
    if (input.receiptDate !== undefined || input.receiptReceivedDate !== undefined) {
      const submitted = isoOf(submission.submitDate);
      const receivedBefore = submission.receiptReceivedDate ? isoOf(submission.receiptReceivedDate) : null;
      const receiptBefore = submission.receiptDate ? isoOf(submission.receiptDate) : null;
      const received = input.receiptReceivedDate !== undefined ? isoOf(parseReceivedDate(input.receiptReceivedDate)) : receivedBefore;
      const receipt = input.receiptDate !== undefined ? isoOf(parseReceiptDate(input.receiptDate)) : receiptBefore;
      if (received && received !== receivedBefore) assertReceivedDateInRange(received, submitted);
      if (receipt && (receipt !== receiptBefore || received !== receivedBefore)) assertReceiptDateInRange(receipt, submitted, received);
      if (receipt && receipt !== receiptBefore) assertReceiptDateNotAfterReceived(receipt, submission.vehicle);
      if (received && received !== receivedBefore) {
        data.receiptReceivedDate = toDate(received);
        changes['submission.receiptReceivedDate'] = { from: receivedBefore, to: received };
      }
      if (receipt && receipt !== receiptBefore) {
        data.receiptDate = toDate(receipt);
        changes['submission.receiptDate'] = { from: receiptBefore, to: receipt };
      }
    }
    if (Object.keys(changes).length === 0) throw new BadRequestException({ error: 'ข้อมูลไม่ได้เปลี่ยน' });

    await this.prisma.$transaction(async (tx) => {
      // สถานะได้ใบเสร็จแล้วเปลี่ยนไม่ได้อยู่แล้ว - where status กันไว้อีกชั้น (updatedAt ให้มีอะไรเขียนเสมอแม้แก้แค่ทะเบียน)
      const { count } = await tx.documentSubmission.updateMany({
        where: { id: submissionId, status: 'RECEIPT_RECEIVED' },
        data: { ...data, updatedAt: new Date() },
      });
      if (count === 0) throw new BadRequestException({ error: 'แก้ข้อมูลใบเสร็จได้เฉพาะรายการที่ได้ใบเสร็จแล้ว' });
      if (plate) await tx.vehicle.update({ where: { id: submission.vehicleId }, data: plate });
      await tx.vehicleEditLog.create({
        data: { vehicleId: submission.vehicleId, remark, changes: JSON.stringify(changes), editedById: currentUser()?.id ?? null },
      });
    });

    // ใบส่งงาน (ยังไม่ยกเลิก) ของรถคันนี้ที่พิมพ์ทะเบียน/เลขที่ใบเสร็จเดิมไปแล้ว และบิล (ยังไม่ void) ที่เก็บทะเบียน/เลขที่/ยอดใบเสร็จเดิม
    // (พบ 2026-09-27: เดิมแก้แค่ยอดแล้วไม่เตือน ทั้งที่บิลที่ออกแล้วยังเรียกเก็บยอดเดิม - ใบส่งงานไม่มียอด)
    const slipSnapshotChanged = 'plate' in changes || 'submission.receiptNo' in changes;
    const invoiceSnapshotChanged = slipSnapshotChanged || 'submission.receiptAmount' in changes;
    const [slipItems, invoiceLines] = await Promise.all([
      slipSnapshotChanged
        ? this.prisma.deliverySlipItem.findMany({
            where: { vehicleId: submission.vehicleId, cancelledAt: null },
            select: { slip: { select: { slipNo: true } } },
          })
        : [],
      invoiceSnapshotChanged
        ? this.prisma.invoiceLine.findMany({
            where: { vehicleId: submission.vehicleId, invoice: { status: { not: 'VOID' } } },
            select: { invoice: { select: { invoiceNo: true } } },
          })
        : [],
    ]);
    const updated = await this.prisma.documentSubmission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        receiptNo: true,
        receiptAmount: true,
        receiptDate: true,
        receiptReceivedDate: true,
        vehicle: { select: { plateCategory: true, plateNumber: true } },
      },
    });
    return {
      submission: updated,
      liveSlips: [...new Set(slipItems.map((i) => `DL-${String(i.slip.slipNo).padStart(5, '0')}`))],
      liveInvoices: [...new Set(invoiceLines.map((l) => l.invoice.invoiceNo))],
    };
  }

  // ยกเลิกรายการที่ยื่นแล้ว (ผู้ใช้ 2026-09-25) เพื่อให้รถกลับไปอยู่ในคิวรอยื่นเอกสารแล้วยื่นใหม่ (ราคาคำนวณใหม่ทั้งหมด)
  // ลบแถว DocumentSubmission ทิ้ง ต่างจาก FAILED ที่เก็บไว้เป็นประวัติยื่นไม่สำเร็จ - ต้องมีเหตุผล, เก็บ snapshot ลง VehicleEditLog
  // ได้เฉพาะ PENDING (ได้ใบเสร็จแล้ว = จดทะเบียนแล้ว ห้ามยื่นซ้ำ) ทั้งรถยนต์และจักรยานยนต์
  // รูปใบเสร็จที่แนบไว้ไม่ถูกลบ: ถูกถอดออก (FK onDelete SetNull) กลับไปอยู่ในรายการรอจับคู่ ใช้จับคู่กับรายการที่ยื่นใหม่ได้
  async cancel(submissionId: string, remarkRaw: unknown) {
    const remark = typeof remarkRaw === 'string' ? remarkRaw.trim() : '';
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่ยกเลิก' });
    const submission = await this.prisma.documentSubmission.findUnique({
      where: { id: submissionId },
      include: { vehicle: { select: { body: true } }, _count: { select: { receipts: true } } },
    });
    if (!submission) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    assertVehicleInScope(submission.vehicle.body);
    if (submission.status !== 'PENDING') {
      throw new BadRequestException({ error: 'ยกเลิกได้เฉพาะรายการที่ยังรอใบเสร็จ' });
    }

    const snapshot = [
      `ยื่น ${submission.submitDate.toISOString().slice(0, 10)}${submission.urgent ? ' ด่วน' : ''}`,
      `Bill: ${describeItems(submission.billItems)}`,
      `No Bill: ${describeItems(submission.noBillItems)}`,
      `ภาษี ${submission.taxAmount === null ? '-' : Number(submission.taxAmount)}`,
      ...(submission._count.receipts > 0 ? [`ถอดรูปใบเสร็จ ${submission._count.receipts} รูป`] : []),
    ].join(' | ');
    // ลบแบบมีเงื่อนไข (พบ 2026-09-27: เดิมตรวจสถานะแล้วค่อยลบด้วย id อย่างเดียว ถ้าอีกคนบันทึกได้ใบเสร็จแทรกเข้ามาระหว่างนั้น
    // รายการที่ได้ใบเสร็จแล้วถูกลบ รถกลับเข้าคิวยื่นทั้งที่จดทะเบียนแล้ว) - ไม่โดนแถวไหน = throw ย้อนการถอดรูปด้วย
    await this.prisma.$transaction(async (tx) => {
      // ล็อกแถวรายการก่อนแถวรูปเหมือนตอนแนบ/ย้ายรูป (submission-lock.ts) - ลำดับเดียวกันกัน deadlock
      await lockSubmissions(tx, [submissionId]);
      await tx.receiptImage.updateMany({ where: { submissionId }, data: { submissionId: null } });
      const { count } = await tx.documentSubmission.deleteMany({ where: { id: submissionId, status: 'PENDING' } });
      if (count === 0) throw new BadRequestException({ error: 'ยกเลิกได้เฉพาะรายการที่ยังรอใบเสร็จ' });
      await tx.vehicleEditLog.create({
        data: {
          vehicleId: submission.vehicleId,
          remark,
          changes: JSON.stringify({ 'submission.cancelled': { from: snapshot, to: 'ยกเลิกการยื่น' } }),
          editedById: currentUser()?.id ?? null,
        },
      });
    });
    return { id: submissionId, cancelled: true };
  }

  // หน้ารับใบเสร็จ: บันทึกทั้งใบยื่นทีเดียว (best-effort - คันที่พลาดคืนเหตุผลกลับไป คันอื่นบันทึกต่อ)
  // RECEIVED = ได้ใบเสร็จ (ต้องแนบรูปใบเสร็จแล้วอย่างน้อย 1 รูป) / FAILED = ยื่นไม่สำเร็จ กลับไป Step 4
  // CARRY = ยังไม่ได้ใบเสร็จและยังไม่รู้สาเหตุ -> ค้างอยู่ในใบยื่นเดิม "ยังขาด" (ยัง PENDING)
  // FAILED / CARRY ต้องยังไม่มีรูปใบเสร็จ - มีรูปแล้วคืน RECEIPT_ATTACHED_ERROR ให้โหลดหน้าใหม่แล้วบันทึกเป็นได้ใบเสร็จ
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
          await this.updateStatus(submissionId, 'RECEIPT_RECEIVED', body.receivedDate, {
            plateCategory: entry.plateCategory,
            plateNumber: entry.plateNumber,
            receiptAmount: entry.receiptAmount,
            receiptNo: entry.receiptNo,
            receiptDate: entry.receiptDate,
          });
        } else if (entry?.action === 'FAILED') {
          await this.updateStatus(submissionId, 'FAILED', undefined, { failRemark: entry.failRemark });
        } else if (entry?.action === 'CARRY') {
          await this.carry(submissionId);
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

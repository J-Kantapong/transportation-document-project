// งานอื่นๆ ในขั้นส่งงานลูกค้า (ผู้ใช้ 2026-10-08: "งานควรจะต้อง delivery ใบเสร็จก่อนถึงจะวางบิลได้ ... อยากให้โฟลวเป็นคล้ายๆ กันหมด")
// งานโอน / ยกเลิกการใช้รถ / ย้ายออก / คัดแผ่นป้าย / ต่อภาษี อยู่คนละตาราง แต่ขั้นส่งงานใช้กฎเดียวกับรถจดใหม่และงานสลับเลข:
// เข้าคิวเมื่อของที่จะส่งครบ (ใบเสร็จกลับแล้ว - คัดป้ายต้องได้ป้ายด้วย - ต่อภาษีต้องรับป้ายภาษี/ใบเสร็จแล้ว) บันทึกเป็นใบ DL ของลูกค้า
// รายเดียว แล้วจึงวางบิลได้ (billing.service.ts ดู deliveredDate ของงาน)
// ไฟล์นี้อ่าน/แปลงแถวของแต่ละตารางให้เป็นรูปร่างเดียว (JobDeliveryRow) - การเขียนอยู่ใน delivery.service.ts
import type { AuditEntity } from '../audit/audit-log.js';
import type { VehicleScope } from '../auth/vehicle-scope.js';
import { vehicleKindOf } from '../auth/vehicle-scope.js';
import { isJobType, JOB_LABEL, JOB_TYPES, type JobType } from '../billing/other-jobs.js';
import type { Prisma } from '../generated/prisma/client.js';

export { isJobType, JOB_LABEL, JOB_TYPES };
export type { JobType };

// ชื่อ entity ใน AuditLog ของแต่ละงาน (ตรงกับที่ service ของงานนั้นใช้)
export const JOB_AUDIT_ENTITY: Record<JobType, AuditEntity> = {
  TRANSFER: 'VehicleTransfer',
  USE_CANCEL: 'VehicleUseCancellation',
  PLATE_COPY: 'PlateCopy',
  MOVE_OUT: 'VehicleMoveOut',
  TAX_RENEWAL: 'TaxRenewal',
};

// ชื่อ delegate ของ Prisma - ใช้เขียน deliveredDate/ผู้รับ ลงตารางของงาน (ค่าคงที่ ไม่รับจากผู้ใช้)
export const JOB_DELEGATE = {
  TRANSFER: 'vehicleTransfer',
  USE_CANCEL: 'vehicleUseCancellation',
  PLATE_COPY: 'plateCopy',
  MOVE_OUT: 'vehicleMoveOut',
  TAX_RENEWAL: 'taxRenewal',
} as const;

const TRANSFER_LABEL: Record<string, string> = { OWNER: 'โอนตามผู้ถือกรรมสิทธิ์', INSPECTION: 'โอนตรวจรถ' };
import { motorcycleTypeWhere } from '../vehicles/vehicle-reference-data.js';

export interface JobCustomer {
  id: string;
  name: string;
  company: string | null;
  branch: string | null;
}

// งานหนึ่งงานในรูปร่างกลาง - ช่องชื่อเดียวกับที่หน้า Delivery / ใบ DL ใช้กับรถจดใหม่
export interface JobDeliveryRow {
  type: JobType;
  id: string;
  customerId: string | null; // เจ้าของงาน - null = งานเก่าก่อนบังคับกรอก (ส่งงานไม่ได้จนกว่าจะเติม)
  customer: JobCustomer | null;
  vehicleKind: 'car' | 'moto';
  chassis: string;
  brandName: string; // ต่อภาษีไม่มียี่ห้อ ใช้ประเภทรถย่อ (รย.1 / รย.12)
  plateCategory: string | null;
  plateNumber: string | null;
  receiptNo: string | null;
  ownerName: string | null; // งานโอน = ผู้รับโอน
  submitDate: Date;
  returnedDate: Date | null; // ใบเสร็จกลับ (ต่อภาษี = receivedDate)
  plateReceivedDate: Date | null; // เฉพาะคัดป้าย
  // พร้อมส่งเมื่อ: ใบเสร็จกลับ (+ ป้ายสำหรับคัดป้าย) - null = ยังไม่พร้อม
  readySince: Date | null;
  deliveredDate: Date | null;
  deliveryRecipient: string | null;
  deliveryNote: string | null;
  detail: string; // ชื่องานที่พิมพ์บนใบ DL เช่น "โอนตรวจรถ", "คัดแผ่นป้ายทะเบียน"
  updatedAt: Date;
}

export type JobDeliveryQuery =
  | { mode: 'queue' } // พร้อมส่งและยังไม่ส่ง
  | { mode: 'awaiting' } // เหมือน queue แต่ไม่สนขอบเขตผู้ใช้ (ภาพรวม/เตือน)
  | { mode: 'recent'; take: number } // ส่งแล้วล่าสุด
  | { mode: 'ids'; ids: Map<JobType, string[]> };

type Db = Pick<Prisma.TransactionClient, 'vehicleTransfer' | 'vehicleUseCancellation' | 'vehicleMoveOut' | 'plateCopy' | 'taxRenewal' | 'invoiceItem'>;

const CUSTOMER_SELECT = { select: { id: true, name: true, company: true, branch: true } } as const;

const classWhere = (scope: VehicleScope) =>
  scope === 'ALL' ? {} : scope === 'MOTO' ? { vehicleClass: 'MOTO' } : scope === 'CAR' ? { vehicleClass: 'CAR' } : { id: { in: [] as string[] } };
const taxClassWhere = (scope: VehicleScope) =>
  scope === 'ALL'
    ? {}
    : scope === 'MOTO'
      ? motorcycleTypeWhere('vehicleType')
      : scope === 'CAR'
        ? { NOT: motorcycleTypeWhere('vehicleType') }
        : { id: { in: [] as string[] } };

const laterOf = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));

// อ่านงานทุกประเภทตามโหมดที่ขอ - คืนรูปร่างกลาง เรียงวันที่ยื่นเก่าก่อน (recent: วันที่ส่งล่าสุดก่อน)
export async function loadJobRows(db: Db, query: JobDeliveryQuery, scope: VehicleScope): Promise<JobDeliveryRow[]> {
  const idsOf = (type: JobType) => (query.mode === 'ids' ? query.ids.get(type) ?? [] : null);
  const wanted = (type: JobType) => query.mode !== 'ids' || (query.ids.get(type)?.length ?? 0) > 0;
  const effectiveScope = query.mode === 'awaiting' ? 'ALL' : scope;
  // เงื่อนไขร่วม: ไม่ยกเลิก + มีเจ้าของงาน (ส่งงานให้ใครไม่รู้ไม่ได้) - โหมด ids ไม่กรองสถานะ ให้ service บอกเหตุผลเอง
  const stateWhere = (ready: Record<string, unknown>) => {
    if (query.mode === 'ids') return {};
    if (query.mode === 'recent') return { deliveredDate: { not: null }, customerId: { not: null } };
    return { deliveredDate: null, customerId: { not: null }, ...ready };
  };
  const orderBy = query.mode === 'recent' ? [{ deliveredDate: 'desc' as const }, { updatedAt: 'desc' as const }] : [{ submitDate: 'asc' as const }, { createdAt: 'asc' as const }];
  const take = query.mode === 'recent' ? query.take : undefined;
  const idWhere = (type: JobType) => (idsOf(type) ? { id: { in: idsOf(type)! } } : {});

  const common = {
    id: true,
    customerId: true,
    customer: CUSTOMER_SELECT,
    vehicleClass: true,
    chassis: true,
    brand: true,
    plateCategory: true,
    plateNumber: true,
    receiptNo: true,
    submitDate: true,
    returnedDate: true,
    deliveredDate: true,
    deliveryRecipient: true,
    deliveryNote: true,
    updatedAt: true,
  } as const;

  const [transfers, cancels, moveOuts, copies, renewals] = await Promise.all([
    wanted('TRANSFER')
      ? db.vehicleTransfer.findMany({
          where: { cancelledAt: null, ...idWhere('TRANSFER'), ...stateWhere({ returnedDate: { not: null } }), ...classWhere(effectiveScope) },
          select: { ...common, transferType: true, transfereeName: true },
          orderBy,
          take,
        })
      : [],
    wanted('USE_CANCEL')
      ? db.vehicleUseCancellation.findMany({
          where: { cancelledAt: null, ...idWhere('USE_CANCEL'), ...stateWhere({ returnedDate: { not: null } }), ...classWhere(effectiveScope) },
          select: { ...common, ownerName: true },
          orderBy,
          take,
        })
      : [],
    wanted('MOVE_OUT')
      ? db.vehicleMoveOut.findMany({
          where: { cancelledAt: null, ...idWhere('MOVE_OUT'), ...stateWhere({ returnedDate: { not: null } }), ...classWhere(effectiveScope) },
          select: { ...common, ownerName: true },
          orderBy,
          take,
        })
      : [],
    wanted('PLATE_COPY')
      ? db.plateCopy.findMany({
          where: {
            cancelledAt: null,
            ...idWhere('PLATE_COPY'),
            ...stateWhere({ returnedDate: { not: null }, plateReceivedDate: { not: null } }),
            ...classWhere(effectiveScope),
          },
          select: { ...common, ownerName: true, plateReceivedDate: true },
          orderBy,
          take,
        })
      : [],
    wanted('TAX_RENEWAL')
      ? db.taxRenewal.findMany({
          where: {
            cancelledAt: null,
            ...idWhere('TAX_RENEWAL'),
            ...stateWhere({ receivedDate: { not: null }, paymentDate: { not: null } }),
            ...taxClassWhere(effectiveScope),
          },
          select: {
            id: true,
            customerId: true,
            customer: CUSTOMER_SELECT,
            vehicleType: true,
            chassis: true,
            plateCategory: true,
            plateNumber: true,
            receiptNo: true,
            ownerName: true,
            submitDate: true,
            receivedDate: true,
            paymentDate: true,
            deliveredDate: true,
            deliveryRecipient: true,
            deliveryNote: true,
            updatedAt: true,
          },
          orderBy,
          take,
        })
      : [],
  ]);

  const kindOfClass = (c: string): 'car' | 'moto' => (c === 'MOTO' ? 'moto' : 'car');
  type BaseRow = {
    id: string;
    customerId: string | null;
    customer: JobCustomer | null;
    vehicleClass: string;
    chassis: string;
    brand: string;
    plateCategory: string;
    plateNumber: string;
    receiptNo: string | null;
    submitDate: Date;
    returnedDate: Date | null;
    deliveredDate: Date | null;
    deliveryRecipient: string | null;
    deliveryNote: string | null;
    updatedAt: Date;
  };
  const base = (type: JobType, r: BaseRow, detail: string, ownerName: string | null): JobDeliveryRow => ({
    type,
    id: r.id,
    customerId: r.customerId,
    customer: r.customer,
    vehicleKind: kindOfClass(r.vehicleClass),
    chassis: r.chassis,
    brandName: r.brand,
    plateCategory: r.plateCategory,
    plateNumber: r.plateNumber,
    receiptNo: r.receiptNo,
    ownerName,
    submitDate: r.submitDate,
    returnedDate: r.returnedDate,
    plateReceivedDate: null,
    readySince: r.returnedDate,
    deliveredDate: r.deliveredDate,
    deliveryRecipient: r.deliveryRecipient,
    deliveryNote: r.deliveryNote,
    detail,
    updatedAt: r.updatedAt,
  });

  const rows: JobDeliveryRow[] = [
    ...transfers.map((r) => base('TRANSFER', r, TRANSFER_LABEL[r.transferType] ?? JOB_LABEL.TRANSFER, r.transfereeName)),
    ...cancels.map((r) => base('USE_CANCEL', r, JOB_LABEL.USE_CANCEL, r.ownerName)),
    ...moveOuts.map((r) => base('MOVE_OUT', r, JOB_LABEL.MOVE_OUT, r.ownerName)),
    ...copies.map((r) => ({
      ...base('PLATE_COPY', r, JOB_LABEL.PLATE_COPY, r.ownerName),
      plateReceivedDate: r.plateReceivedDate,
      // คัดป้ายส่งได้เมื่อได้ทั้งใบเสร็จและป้าย (ผู้ใช้ 2026-10-08) - พร้อมตั้งแต่วันที่ได้ครบทั้งสองอย่าง
      readySince: r.returnedDate && r.plateReceivedDate ? laterOf(r.returnedDate, r.plateReceivedDate) : null,
    })),
    ...renewals.map(
      (r): JobDeliveryRow => ({
        type: 'TAX_RENEWAL',
        id: r.id,
        customerId: r.customerId,
        customer: r.customer,
        vehicleKind: vehicleKindOf(r.vehicleType),
        chassis: r.chassis,
        brandName: r.vehicleType.split('-')[0].trim(),
        plateCategory: r.plateCategory,
        plateNumber: r.plateNumber,
        receiptNo: r.receiptNo,
        ownerName: r.ownerName,
        submitDate: r.submitDate,
        returnedDate: r.receivedDate,
        plateReceivedDate: null,
        readySince: r.receivedDate && r.paymentDate ? r.receivedDate : null,
        deliveredDate: r.deliveredDate,
        deliveryRecipient: r.deliveryRecipient,
        deliveryNote: r.deliveryNote,
        detail: JOB_LABEL.TAX_RENEWAL,
        updatedAt: r.updatedAt,
      }),
    ),
  ];
  if (query.mode === 'recent') {
    return rows.sort((a, b) => (b.deliveredDate?.getTime() ?? 0) - (a.deliveredDate?.getTime() ?? 0)).slice(0, query.take);
  }
  return rows.sort((a, b) => a.submitDate.getTime() - b.submitDate.getTime() || a.chassis.localeCompare(b.chassis));
}

export const jobKey = (type: JobType, id: string) => `${type}:${id}`;

// งานที่อยู่ในบิลที่ยังไม่ VOID แล้ว -> เลขที่บิล (คีย์ type:id) - ใบ DL ของงานที่วางบิลแล้วยกเลิก/เปลี่ยนวันที่ไม่ได้ เหมือนรถจดใหม่
export async function jobInvoiceNos(db: Pick<Db, 'invoiceItem'>, jobs: Array<{ type: JobType; id: string }>): Promise<Map<string, string>> {
  const billed = new Map<string, string>();
  if (jobs.length === 0) return billed;
  const rows = await db.invoiceItem.findMany({
    where: { sourceType: { in: [...new Set(jobs.map((j) => j.type))] }, sourceId: { in: jobs.map((j) => j.id) }, invoice: { status: { not: 'VOID' } } },
    select: { sourceType: true, sourceId: true, invoice: { select: { invoiceNo: true } } },
  });
  for (const r of rows) if (r.sourceType && r.sourceId) billed.set(`${r.sourceType}:${r.sourceId}`, r.invoice.invoiceNo);
  return billed;
}

// delegate ของตารางงาน สำหรับ updateMany แบบมีเงื่อนไข (ชื่อมาจาก JOB_DELEGATE เท่านั้น)
export function jobDelegate(db: Prisma.TransactionClient, type: JobType) {
  return db[JOB_DELEGATE[type]] as unknown as {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

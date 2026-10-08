import { currentUser } from '../auth/request-context.js';
import { vehicleKindOf, vehicleScopeFor, type VehicleKind } from '../auth/vehicle-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { parseDateParam } from '../vehicles/vehicle-list-filter.js';

// หน้าค้นหารถ: ค้นงานอื่นๆ ที่ไม่ได้อยู่ในตารางรถจดใหม่ (ผู้ใช้ 2026-10-08 "รวมทุกงาน") - สลับเลข, ยกเลิกการใช้รถ, ย้ายออก,
// คัดแผ่นป้าย, งานโอน, ต่อภาษี ค้นด้วยเลขตัวถัง / เลขเครื่อง / ทะเบียน / ชื่อ ได้เหมือนรถจดใหม่ - อ่านอย่างเดียว
// ไม่รวมแจ้งย้ายยามาฮ่า (เก็บเป็นจำนวนคันรายวัน ไม่มีข้อมูลรถ) และต้องมีคำค้น (ค้นด้วยวันที่อย่างเดียวจะได้งานท่วม)
// สิทธิ์เท่ากับ API ของแต่ละงาน (access-policy.ts SUBMIT_READ): ADMIN / STAFF_CAR / STAFF_MOTO / ACCOUNTANT, ประเภทรถตามขอบเขตของบทบาท

export type JobType = 'PLATE_SWAP' | 'USE_CANCEL' | 'MOVE_OUT' | 'PLATE_COPY' | 'TRANSFER' | 'TAX_RENEWAL';

export const JOB_TYPE_LABEL: Record<JobType, string> = {
  PLATE_SWAP: 'สลับเลข',
  USE_CANCEL: 'ยกเลิกการใช้รถ',
  MOVE_OUT: 'ย้ายออก',
  PLATE_COPY: 'คัดแผ่นป้าย',
  TRANSFER: 'งานโอน',
  TAX_RENEWAL: 'ต่อภาษี',
};

export interface JobSearchRow {
  key: string;
  type: JobType;
  typeLabel: string;
  id: string;
  date: string; // วันที่ยื่น (ค.ศ. YYYY-MM-DD)
  kind: VehicleKind;
  customerName: string | null;
  ownerName: string | null;
  chassis: string;
  engine: string | null;
  plate: string | null;
  brandName: string | null;
  status: string; // ข้อความสถานะ เช่น "รอรับใบเสร็จ"
  done: boolean;
  cancelled: boolean;
  href: string; // หน้างานที่มีรายการนี้
}

export interface JobSearchResult {
  jobs: JobSearchRow[];
  truncated: boolean; // งานบางประเภทมีมากกว่าที่แสดง - พิมพ์คำค้นให้เจาะจงขึ้น
  allowed: boolean; // false = บทบาทนี้ไม่มีสิทธิ์อ่านงานอื่นๆ
}

const PER_TYPE = 30;
const JOB_READ_ROLES = ['ADMIN', 'STAFF_CAR', 'STAFF_MOTO', 'ACCOUNTANT'];
const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const plateText = (category: string | null, number: string | null) => (category && number ? `${category} ${number}` : null);
const classKind = (vehicleClass: string): VehicleKind => (vehicleClass === 'MOTO' ? 'moto' : 'car');

// ช่องข้อความของแต่ละงานที่ค้นได้ + ทะเบียนพิมพ์ติดกัน ("ตค 8772" / "ตค8772") = หมวด + เลข (กฎเดียวกับ vehicleListWhere)
function textWhere(q: string, textFields: string[], plateFields: [string, string][], extra: Record<string, unknown>[] = []) {
  const contains = { contains: q, mode: 'insensitive' as const };
  const or: Record<string, unknown>[] = [
    ...textFields.map((f) => ({ [f]: contains })),
    { customer: { name: contains } },
    { customer: { company: contains } },
    ...extra,
  ];
  const plate = q.replace(/[\s-]/g, '').match(/^(.*\D)(\d{1,4})$/);
  for (const [category, number] of plateFields) {
    or.push({ [category]: contains }, { [number]: contains });
    if (plate) or.push({ [category]: { contains: plate[1], mode: 'insensitive' }, [number]: plate[2] });
  }
  return or;
}

export async function searchJobs(
  prisma: PrismaService,
  params: { q?: string; from?: string; to?: string; kind?: string },
): Promise<JobSearchResult> {
  const user = currentUser();
  if (user && !user.roles.some((r) => JOB_READ_ROLES.includes(r))) return { jobs: [], truncated: false, allowed: false };
  const q = params.q?.trim() ?? '';
  if (!q) return { jobs: [], truncated: false, allowed: true };

  const from = parseDateParam(params.from, 'from');
  const to = parseDateParam(params.to, 'to');
  const dateWhere = from || to ? { submitDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
  // ขอบเขตประเภทรถ: ตามบทบาท (ADMIN / ACCOUNTANT = ทุกคัน) + ตัวกรองประเภทรถของหน้าจอ
  const scope = user ? vehicleScopeFor(user.roles) : 'ALL';
  const wanted: VehicleKind | null = params.kind === 'car' || params.kind === 'moto' ? params.kind : null;
  const classes = (['CAR', 'MOTO'] as const).filter(
    (c) => (scope === 'ALL' || scope === c) && (!wanted || classKind(c) === wanted),
  );
  if (!classes.length) return { jobs: [], truncated: false, allowed: true };
  const classWhere = { vehicleClass: { in: [...classes] } };
  const take = PER_TYPE + 1;
  const orderBy = [{ submitDate: 'desc' as const }, { id: 'desc' as const }];
  const customer = { select: { name: true } };
  const vehicleFields = ['chassis', 'engine', 'ownerName', 'brand'];

  const [swaps, cancels, moveOuts, copies, transfers, renewals] = await Promise.all([
    prisma.plateSwap.findMany({
      where: {
        ...classWhere,
        ...dateWhere,
        OR: textWhere(
          q,
          ['oldChassis', 'oldEngine', 'oldOwnerName', 'oldBrand'],
          [
            ['oldPlateCategory', 'oldPlateNumber'],
            ['newPlateCategory', 'newPlateNumber'],
          ],
          [{ newVehicle: { chassis: { contains: q, mode: 'insensitive' } } }],
        ),
      } as Prisma.PlateSwapWhereInput,
      orderBy,
      take,
      include: { customer },
    }),
    prisma.vehicleUseCancellation.findMany({
      where: { ...classWhere, ...dateWhere, OR: textWhere(q, vehicleFields, [['plateCategory', 'plateNumber']]) } as Prisma.VehicleUseCancellationWhereInput,
      orderBy,
      take,
      include: { customer },
    }),
    prisma.vehicleMoveOut.findMany({
      where: { ...classWhere, ...dateWhere, OR: textWhere(q, vehicleFields, [['plateCategory', 'plateNumber']]) } as Prisma.VehicleMoveOutWhereInput,
      orderBy,
      take,
      include: { customer },
    }),
    prisma.plateCopy.findMany({
      where: { ...classWhere, ...dateWhere, OR: textWhere(q, vehicleFields, [['plateCategory', 'plateNumber']]) } as Prisma.PlateCopyWhereInput,
      orderBy,
      take,
      include: { customer },
    }),
    prisma.vehicleTransfer.findMany({
      where: {
        ...classWhere,
        ...dateWhere,
        OR: textWhere(q, ['chassis', 'engine', 'transferorName', 'transfereeName', 'brand'], [['plateCategory', 'plateNumber']]),
      } as Prisma.VehicleTransferWhereInput,
      orderBy,
      take,
      include: { customer },
    }),
    // ต่อภาษีไม่มี vehicleClass - แยกประเภทรถจาก vehicleType (รย.12- = จักรยานยนต์) ด้านล่าง
    prisma.taxRenewal.findMany({
      where: { ...dateWhere, OR: textWhere(q, ['chassis', 'engine', 'ownerName'], [['plateCategory', 'plateNumber']]) } as Prisma.TaxRenewalWhereInput,
      orderBy,
      take,
      include: { customer },
    }),
  ]);

  const jobs: JobSearchRow[] = [];
  let truncated = false;
  const cut = <T>(rows: T[]) => {
    if (rows.length > PER_TYPE) truncated = true;
    return rows.slice(0, PER_TYPE);
  };
  const base = (type: JobType) => ({ type, typeLabel: JOB_TYPE_LABEL[type] });

  for (const j of cut(swaps)) {
    const cls = classKind(j.vehicleClass);
    const pair = j.kind === 'OLD_OLD' ? 'old-old' : 'old-new';
    const newPlate = plateText(j.newPlateCategory, j.newPlateNumber);
    jobs.push({
      ...base('PLATE_SWAP'),
      key: `PLATE_SWAP:${j.id}`,
      id: j.id,
      date: isoOf(j.submitDate),
      kind: cls,
      customerName: j.customer?.name ?? null,
      ownerName: j.oldOwnerName,
      chassis: j.oldChassis,
      engine: j.oldEngine,
      plate: [plateText(j.oldPlateCategory, j.oldPlateNumber), newPlate ? `→ ${newPlate}` : null].filter(Boolean).join(' ') || null,
      brandName: j.oldBrand,
      status: j.returnedDate ? `รับเอกสารกลับแล้ว ${isoOf(j.returnedDate)}` : 'รอรับเอกสารกลับ',
      done: !!j.returnedDate,
      cancelled: !!j.cancelledAt,
      href: `/registration/plate-swap/${cls}/${pair}/receive-receipt`,
    });
  }

  type SimpleRow = {
    id: string;
    vehicleClass: string;
    submitDate: Date;
    ownerName: string;
    chassis: string;
    engine: string;
    brand: string;
    plateCategory: string;
    plateNumber: string;
    returnedDate: Date | null;
    cancelledAt: Date | null;
    customer: { name: string } | null;
  };
  const simple = (type: JobType, rows: SimpleRow[], path: string) => {
    for (const j of cut(rows)) {
      const cls = classKind(j.vehicleClass);
      jobs.push({
        ...base(type),
        key: `${type}:${j.id}`,
        id: j.id,
        date: isoOf(j.submitDate),
        kind: cls,
        customerName: j.customer?.name ?? null,
        ownerName: j.ownerName,
        chassis: j.chassis,
        engine: j.engine,
        plate: plateText(j.plateCategory, j.plateNumber),
        brandName: j.brand,
        status: j.returnedDate ? `รับใบเสร็จแล้ว ${isoOf(j.returnedDate)}` : 'รอรับใบเสร็จ',
        done: !!j.returnedDate,
        cancelled: !!j.cancelledAt,
        href: path.replace('{cls}', cls),
      });
    }
  };
  simple('USE_CANCEL', cancels, '/registration/other/cancel-use/{cls}/return');
  simple('MOVE_OUT', moveOuts, '/registration/other/move-out/{cls}/return');

  for (const j of cut(copies)) {
    const waitingPlate = !j.plateReceivedDate;
    jobs.push({
      ...base('PLATE_COPY'),
      key: `PLATE_COPY:${j.id}`,
      id: j.id,
      date: isoOf(j.submitDate),
      kind: 'car',
      customerName: j.customer?.name ?? null,
      ownerName: j.ownerName,
      chassis: j.chassis,
      engine: j.engine,
      plate: plateText(j.plateCategory, j.plateNumber),
      brandName: j.brand,
      status: !j.returnedDate ? 'รอรับใบเสร็จ' : waitingPlate ? 'รับใบเสร็จแล้ว รอรับป้าย' : `รับป้ายแล้ว ${isoOf(j.plateReceivedDate!)}`,
      done: !!j.returnedDate && !waitingPlate,
      cancelled: !!j.cancelledAt,
      href: !j.returnedDate ? '/registration/other/plate-copy/return' : '/registration/other/plate-copy/receive-plate',
    });
  }

  for (const j of cut(transfers)) {
    const inspection = j.transferType === 'INSPECTION';
    const returnPage = `/registration/transfer/${inspection ? 'inspection' : 'owner'}/return`;
    let status: string;
    let href = returnPage;
    if (inspection && !j.inspectionSentDate) {
      status = 'รอส่งตรวจ';
      href = '/registration/transfer/inspection/inspect';
    } else if (inspection && !j.inspectionResult) {
      status = 'ส่งตรวจแล้ว รอผลตรวจ';
      href = '/registration/transfer/inspection/inspect';
    } else if (inspection && j.inspectionResult === 'FAIL') {
      status = 'ตรวจไม่ผ่าน';
      href = '/registration/transfer/inspection/inspect';
    } else {
      status = j.returnedDate ? `รับใบเสร็จแล้ว ${isoOf(j.returnedDate)}` : 'รอรับใบเสร็จ';
    }
    jobs.push({
      ...base('TRANSFER'),
      key: `TRANSFER:${j.id}`,
      id: j.id,
      date: isoOf(j.submitDate),
      kind: classKind(j.vehicleClass),
      customerName: j.customer?.name ?? null,
      ownerName: `${j.transferorName} → ${j.transfereeName}`,
      chassis: j.chassis,
      engine: j.engine,
      plate: plateText(j.plateCategory, j.plateNumber),
      brandName: j.brand,
      status: `${inspection ? 'โอนตรวจรถ' : 'โอนตามผู้ถือกรรมสิทธิ์'} · ${status}`,
      done: !!j.returnedDate,
      cancelled: !!j.cancelledAt,
      href,
    });
  }

  for (const j of renewals.slice(0, PER_TYPE)) {
    const kind = vehicleKindOf(j.vehicleType);
    if (wanted && kind !== wanted) continue;
    if (scope !== 'ALL' && scope !== (kind === 'moto' ? 'MOTO' : 'CAR')) continue;
    jobs.push({
      ...base('TAX_RENEWAL'),
      key: `TAX_RENEWAL:${j.id}`,
      id: j.id,
      date: isoOf(j.submitDate),
      kind,
      customerName: j.customer?.name ?? null,
      ownerName: j.ownerName,
      chassis: j.chassis,
      engine: j.engine,
      plate: plateText(j.plateCategory, j.plateNumber),
      brandName: null,
      status: j.deliveredDate
        ? `ส่งคืนลูกค้าแล้ว ${isoOf(j.deliveredDate)}`
        : j.receivedDate
          ? 'รับป้ายภาษีแล้ว รอส่งคืน'
          : j.paymentDate
            ? 'ชำระภาษีแล้ว รอรับป้ายภาษี'
            : 'รอชำระภาษี',
      done: !!j.deliveredDate,
      cancelled: !!j.cancelledAt,
      href: '/registration/tax-renewal',
    });
  }

  if (renewals.length > PER_TYPE) truncated = true;
  jobs.sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date < b.date ? 1 : -1));
  return { jobs, truncated, allowed: true };
}

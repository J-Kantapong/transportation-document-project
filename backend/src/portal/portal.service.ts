import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

// Portal ลูกค้า (เฟสแรก ผู้ใช้ตกลง 2026-09-22): ดูรถของบริษัทตัวเองพร้อมสถานะ 8 ขั้นตอน + กดยืนยันรับของ
// ห้ามส่งราคา/ค่าธรรมเนียม/ค่าใช้จ่ายใดๆ ออกไปจากที่นี่

export type PortalStepState = 'DONE' | 'CURRENT' | 'PENDING' | 'FAILED';

export interface PortalStep {
  key: string;
  title: string;
  state: PortalStepState;
  date: string | null; // วันที่ทำขั้นนั้นเสร็จ (ค.ศ. YYYY-MM-DD) ถ้ามี
  note: string | null; // เช่น "ตรวจไม่ผ่าน" / "ยื่นไม่สำเร็จ" - ไม่ใส่เหตุผลภายในของร้าน
}

export interface PortalVehicle {
  id: string;
  date: string;
  chassis: string;
  brandName: string;
  color: string | null;
  body: string | null;
  registrationProvince: string | null;
  plate: string | null;
  steps: PortalStep[];
  currentStep: string; // ชื่อขั้นที่กำลังทำอยู่ หรือ "เสร็จสิ้น"
  deliveredDate: string | null;
  plateDeliveredDate: string | null;
  deliveryConfirmedAt: string | null;
}

const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

const VEHICLE_SELECT = {
  id: true,
  date: true,
  chassis: true,
  color: true,
  body: true,
  registrationProvince: true,
  plateCategory: true,
  plateNumber: true,
  transferDone: true,
  transferCompletedDate: true,
  inspectionSentDate: true,
  inspectionResult: true,
  inspectionResultDate: true,
  plateReceivedDate: true,
  bookReceivedDate: true,
  deliveredDate: true,
  plateDeliveredDate: true,
  deliveryConfirmedAt: true,
  createdAt: true,
  brand: { select: { name: true } },
  documentSubmissions: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { status: true, submitDate: true, receiptReceivedDate: true },
  },
} as const;

type Row = {
  id: string;
  date: Date;
  chassis: string;
  color: string | null;
  body: string | null;
  registrationProvince: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  transferDone: boolean;
  transferCompletedDate: Date | null;
  inspectionSentDate: Date | null;
  inspectionResult: string | null;
  inspectionResultDate: Date | null;
  plateReceivedDate: Date | null;
  bookReceivedDate: Date | null;
  deliveredDate: Date | null;
  plateDeliveredDate: Date | null;
  deliveryConfirmedAt: Date | null;
  createdAt: Date;
  brand: { name: string };
  documentSubmissions: Array<{ status: string; submitDate: Date; receiptReceivedDate: Date | null }>;
};

export function buildSteps(v: Row): PortalStep[] {
  const submission = v.documentSubmissions[0];
  const receiptReceived = submission?.status === 'RECEIPT_RECEIVED';
  const inspectionPassed = v.inspectionResult === 'ผ่าน';
  const raw: Array<Omit<PortalStep, 'state'> & { done: boolean; failed?: boolean }> = [
    { key: 'entry', title: 'รับข้อมูลรถ', done: true, date: isoDate(v.date), note: null },
    {
      key: 'transfer',
      title: v.registrationProvince === 'กรุงเทพมหานคร' ? 'ตัดบัญชี' : 'แจ้งย้าย',
      done: v.transferDone,
      date: isoDate(v.transferCompletedDate),
      note: null,
    },
    {
      key: 'inspection',
      title: 'ตรวจรถ',
      done: inspectionPassed,
      failed: v.inspectionResult === 'ไม่ผ่าน',
      date: inspectionPassed ? isoDate(v.inspectionResultDate) : null,
      note: v.inspectionResult === 'ไม่ผ่าน' ? 'ตรวจไม่ผ่าน รอตรวจใหม่' : v.inspectionSentDate && !v.inspectionResult ? 'ส่งตรวจแล้ว รอผล' : null,
    },
    {
      key: 'submit',
      title: 'ยื่นเอกสารจดทะเบียน',
      done: Boolean(submission) && submission.status !== 'FAILED',
      failed: submission?.status === 'FAILED',
      date: submission && submission.status !== 'FAILED' ? isoDate(submission.submitDate) : null,
      note: submission?.status === 'FAILED' ? 'ยื่นไม่สำเร็จ รอยื่นใหม่' : null,
    },
    { key: 'receipt', title: 'ได้รับใบเสร็จกรมขนส่ง', done: receiptReceived, date: receiptReceived ? isoDate(submission.receiptReceivedDate) : null, note: null },
    { key: 'plate', title: 'ได้รับป้ายทะเบียน', done: Boolean(v.plateReceivedDate), date: isoDate(v.plateReceivedDate), note: null },
    { key: 'book', title: 'ได้รับเล่มทะเบียน', done: Boolean(v.bookReceivedDate), date: isoDate(v.bookReceivedDate), note: null },
    {
      key: 'delivery',
      title: 'ส่งมอบให้ลูกค้า',
      done: Boolean(v.deliveredDate) && Boolean(v.plateDeliveredDate),
      date: isoDate(v.plateDeliveredDate ?? v.deliveredDate),
      note: v.deliveredDate && !v.plateDeliveredDate ? 'ส่งใบเสร็จ + เล่มแล้ว ป้ายจะส่งตามทีหลัง' : null,
    },
  ];
  // ขั้นที่ยังไม่เสร็จขั้นแรก = CURRENT (ป้ายอาจออกช้ากว่าเล่มได้ จึงดูเป็นรายขั้น ไม่บังคับเรียงหลังใบเสร็จ)
  let currentFound = false;
  return raw.map((s) => {
    let state: PortalStepState = 'DONE';
    if (!s.done) {
      state = s.failed ? 'FAILED' : currentFound ? 'PENDING' : 'CURRENT';
      currentFound = true;
    }
    const { done: _d, failed: _f, ...rest } = s;
    return { ...rest, state };
  });
}

function mapVehicle(v: Row): PortalVehicle {
  const steps = buildSteps(v);
  const current = steps.find((s) => s.state !== 'DONE');
  return {
    id: v.id,
    date: isoDate(v.date) ?? '',
    chassis: v.chassis,
    brandName: v.brand.name,
    color: v.color,
    body: v.body,
    registrationProvince: v.registrationProvince,
    plate: v.plateCategory || v.plateNumber ? [v.plateCategory, v.plateNumber].filter(Boolean).join(' ') : null,
    steps,
    currentStep: current ? current.title : 'เสร็จสิ้น',
    deliveredDate: isoDate(v.deliveredDate),
    plateDeliveredDate: isoDate(v.plateDeliveredDate),
    deliveryConfirmedAt: v.deliveryConfirmedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class PortalService {
  constructor(private readonly prisma: PrismaService) {}

  private requireCustomer(customerId: string | null): string {
    if (!customerId) throw new ForbiddenException({ error: 'บัญชีนี้ยังไม่ได้ผูกกับบริษัทลูกค้า กรุณาติดต่อผู้ดูแลระบบ' });
    return customerId;
  }

  async company(customerId: string | null) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: this.requireCustomer(customerId) },
      select: { id: true, name: true, company: true, branch: true },
    });
    if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลบริษัท' });
    return { customer };
  }

  async vehicles(customerId: string | null): Promise<{ vehicles: PortalVehicle[] }> {
    const rows = await this.prisma.vehicle.findMany({
      where: { customerId: this.requireCustomer(customerId), deletedAt: null }, // รถที่ถูกลบไม่แสดงในพอร์ทัลลูกค้า
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      select: VEHICLE_SELECT,
    });
    return { vehicles: rows.map(mapVehicle) };
  }

  async confirmDelivery(customerId: string | null, vehicleId: string): Promise<{ vehicle: PortalVehicle }> {
    const owner = this.requireCustomer(customerId);
    // where ด้วย customerId ด้วย - รถของบริษัทอื่นตอบ "ไม่พบ" เหมือนไม่มีอยู่
    const vehicle = await this.prisma.vehicle.findFirst({ where: { id: vehicleId, customerId: owner, deletedAt: null }, select: VEHICLE_SELECT });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    if (!vehicle.deliveredDate) throw new BadRequestException({ error: 'รถคันนี้ยังไม่ได้ส่งมอบ' });
    if (vehicle.deliveryConfirmedAt) return { vehicle: mapVehicle(vehicle) };
    const updated = await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { deliveryConfirmedAt: new Date() },
      select: VEHICLE_SELECT,
    });
    return { vehicle: mapVehicle(updated) };
  }
}

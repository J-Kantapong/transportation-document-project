import { vi } from 'vitest';
import { BillingService } from './billing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const customer = {
  id: 'c1',
  name: 'Lexus',
  company: 'บริษัท เลกซัส ออโต้ ซิตี้ จำกัด',
  branch: 'สาขา 00001',
  address: 'ที่อยู่',
  taxId: '0105547142882',
  billingVat: true,
  billingWhtRate: 3,
  billingWhtSpecialRate: 1,
  billingWhtSpecialUntil: new Date('2026-12-31T00:00:00.000Z'),
};

function vehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    customerId: 'c1',
    chassis: 'CH1',
    body: 'รย.1-เก๋ง 2 ตอน',
    plateCategory: 'กก',
    plateNumber: '7733',
    deliveredDate: new Date('2026-09-20T00:00:00.000Z'),
    brand: { name: 'Lexus' },
    documentSubmissions: [{ receiptNo: '69/0035371' }],
    invoiceLines: [],
    ...overrides,
  };
}

function service(vehicles: unknown[], existingInvoice: unknown = null) {
  const create = vi.fn().mockImplementation(async ({ data }) => ({
    id: 'i1',
    status: 'ISSUED',
    paidDate: null,
    taxInvoiceNo: null,
    voidReason: null,
    ...data,
    lines: data.lines.create.map((l: object, n: number) => ({ id: `l${n}`, ...l })),
  }));
  const prisma = {
    customer: { findUnique: vi.fn().mockResolvedValue(customer) },
    invoice: { findUnique: vi.fn().mockResolvedValue(existingInvoice), create },
    vehicle: { findMany: vi.fn().mockResolvedValue(vehicles) },
  } as unknown as PrismaService;
  return { svc: new BillingService(prisma), create };
}

const dto = (o: Record<string, unknown> = {}) => ({
  customerId: 'c1',
  invoiceNo: 'IV2026-121',
  issueDate: '2026-09-21',
  jobLabel: 'จดทะเบียนรถยนต์',
  lines: [{ vehicleId: 'v1', receiptAmount: 3745, serviceFee: 700, deduction: 500, deductionNote: 'ลูกค้าชำระค่าขอใช้เลขเอง' }],
  extras: [{ label: 'ค่าส่งเอกสาร', amount: 200 }],
  ...o,
});

describe('BillingService.createInvoice', () => {
  it('คำนวณยอดฝั่ง server ตามเงื่อนไขลูกค้า ณ วันออกบิล (หัก 1% ถึงสิ้นปี)', async () => {
    const { svc } = service([vehicle()]);
    const invoice = await svc.createInvoice(dto());
    expect(invoice).toMatchObject({ feeTotal: 3745, serviceTotal: 900, vatAmount: 63, whtRate: 1, whtAmount: 9, netTotal: 4699 });
    expect(invoice.lines[0]).toMatchObject({ chassis: 'CH1', plateText: 'กก 7733', receiptNo: '69/0035371', serviceFee: 700, deduction: 500 });
    expect(invoice.customer.name).toBe('บริษัท เลกซัส ออโต้ ซิตี้ จำกัด');
  });

  it('พ้นวันสิ้นสุดอัตราพิเศษแล้วกลับไปหัก 3%', async () => {
    const { svc } = service([vehicle()]);
    const invoice = await svc.createInvoice(dto({ issueDate: '2027-01-05' }));
    expect(invoice).toMatchObject({ whtRate: 3, whtAmount: 27 });
  });

  it('รถที่อยู่ในบิลอื่นแล้ววางบิลซ้ำไม่ได้', async () => {
    const { svc, create } = service([vehicle({ invoiceLines: [{ invoice: { invoiceNo: 'IV2026-117' } }] })]);
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('IV2026-117') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('รถที่ยังไม่ได้บันทึกส่งงานวางบิลไม่ได้', async () => {
    const { svc } = service([vehicle({ deliveredDate: null })]);
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('ส่งงาน') } });
  });

  it('เลขที่บิลซ้ำไม่ได้', async () => {
    const { svc } = service([vehicle()], { id: 'old' });
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('ถูกใช้ไปแล้ว') } });
  });

  it('รถของลูกค้ารายอื่นลงบิลนี้ไม่ได้', async () => {
    const { svc } = service([vehicle({ customerId: 'c2' })]);
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่ใช่ของลูกค้า') } });
  });
});

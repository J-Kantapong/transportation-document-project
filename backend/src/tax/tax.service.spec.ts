import { vi } from 'vitest';
import { TaxService } from './tax.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GovTaxFuelGroup } from '../generated/prisma/enums.js';

// Prisma.Decimal ตอบ .toString() เสมอ - จำลองแบบนั้นเพื่อทดสอบ mapping ใน loadRuleSet()
// (ดู tax.service.ts: Decimal -> string ก่อนส่งเข้า calculateGovernmentTax)
function decimal(value: number) {
  return { toString: () => String(value) };
}

function mockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    governmentTaxCcBracket: { findMany: vi.fn().mockResolvedValue([]) },
    governmentTaxWeightBracket: { findMany: vi.fn().mockResolvedValue([]) },
    governmentTaxEvIncentive: { findMany: vi.fn().mockResolvedValue([]) },
    governmentTaxMotorcycleFlat: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  } as unknown as PrismaService;
}

describe('TaxService.preview', () => {
  it('happy path: RY12 ICE ผ่านการ map Decimal->string แล้วคำนวณได้จริง', async () => {
    const prisma = mockPrisma({
      governmentTaxMotorcycleFlat: { findMany: vi.fn().mockResolvedValue([{ fuelGroup: GovTaxFuelGroup.ICE, amount: decimal(100) }]) },
    });
    const service = new TaxService(prisma);

    const result = await service.preview({
      body: 'รย.12-300-799cc',
      fuel: 'เบนซิน',
      cc: null,
      weight: null,
      firstRegistrationDate: null,
      owner: { ownerType: 'INDIVIDUAL', isHirePurchaseBusiness: false, hirerType: null },
    });

    expect(result.status).toBe('CALCULATED');
    expect(result.amount).toBe(100);
  });

  it('missing rule: ไม่มีแถว VERIFIED เลย -> MISSING_VERIFIED_RULE, ไม่คืน 0', async () => {
    const prisma = mockPrisma();
    const service = new TaxService(prisma);

    const result = await service.preview({
      body: 'รย.1-เก๋ง 2 ตอน',
      fuel: 'เบนซิน',
      cc: 1000,
      weight: null,
      firstRegistrationDate: null,
      owner: { ownerType: 'INDIVIDUAL', isHirePurchaseBusiness: false, hirerType: null },
    });

    expect(result.status).toBe('MISSING_VERIFIED_RULE');
    expect(result.amount).toBeNull();
  });

  it('missing input: ไม่ระบุเจ้าของรถของ รย.1 -> MISSING_INPUT', async () => {
    const prisma = mockPrisma();
    const service = new TaxService(prisma);

    const result = await service.preview({
      body: 'รย.1-เก๋ง 2 ตอน',
      fuel: 'เบนซิน',
      cc: 1000,
      weight: null,
      firstRegistrationDate: null,
      owner: null,
    });

    expect(result.status).toBe('MISSING_INPUT');
    expect(result.amount).toBeNull();
  });
});

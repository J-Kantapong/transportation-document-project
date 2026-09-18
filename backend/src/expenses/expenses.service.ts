import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  collectExpenseItems,
  DAILY_EXPENSE_TRIGGER_LABELS,
  eachDay,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_CATEGORY_ORDER,
  type ExpenseItem,
} from './daily-expense-calculator.js';

// ช่วงวันที่สูงสุดที่ขอสรุปยอดรายวันได้ในครั้งเดียว
const MAX_RANGE_DAYS = 93;

function isValidDateParam(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

// Prisma.Decimal -> string (null คงเป็น null ไม่ใช่ "null")
function decimalString(value: { toString(): string } | null): string | null {
  return value === null ? null : value.toString();
}

function baht(satang: number): number {
  return satang / 100;
}

function sumSatang(items: ExpenseItem[]): number {
  return items.reduce((sum, item) => sum + item.amountSatang, 0);
}

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  async daily(dateParam: unknown) {
    if (!isValidDateParam(dateParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ date ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    const items = await this.loadItems(dateParam, dateParam);

    const categories = EXPENSE_CATEGORY_ORDER.map((category) => {
      const inCategory = items.filter((item) => item.category === category);
      return {
        category,
        label: EXPENSE_CATEGORY_LABELS[category],
        count: inCategory.length,
        total: baht(sumSatang(inCategory)),
      };
    }).filter((c) => c.count > 0);

    return {
      date: dateParam,
      total: baht(sumSatang(items)),
      count: items.length,
      categories,
      items: items.map((item) => ({
        id: item.id,
        category: item.category,
        categoryLabel: EXPENSE_CATEGORY_LABELS[item.category],
        label: item.label,
        detail: item.detail,
        amount: baht(item.amountSatang),
      })),
    };
  }

  async dailyTotals(fromParam: unknown, toParam: unknown) {
    if (!isValidDateParam(fromParam) || !isValidDateParam(toParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ from/to ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    if (fromParam > toParam) {
      throw new BadRequestException({ error: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' });
    }
    const days = eachDay(fromParam, toParam);
    if (days.length > MAX_RANGE_DAYS) {
      throw new BadRequestException({ error: `ขอสรุปได้ครั้งละไม่เกิน ${MAX_RANGE_DAYS} วัน` });
    }

    const items = await this.loadItems(fromParam, toParam);
    const byDay = new Map<string, ExpenseItem[]>();
    for (const item of items) {
      byDay.set(item.date, [...(byDay.get(item.date) ?? []), item]);
    }

    return {
      days: days.map((date) => {
        const dayItems = byDay.get(date) ?? [];
        return { date, total: baht(sumSatang(dayItems)), count: dayItems.length };
      }),
    };
  }

  async listRules() {
    const rules = await this.prisma.dailyExpenseRule.findMany({ orderBy: [{ code: 'asc' }, { effectiveFrom: 'desc' }] });
    return {
      rules: rules.map((rule) => ({
        id: rule.id,
        code: rule.code,
        label: rule.label,
        trigger: rule.trigger,
        triggerLabel: DAILY_EXPENSE_TRIGGER_LABELS[rule.trigger],
        amount: rule.amount.toString(),
        effectiveFrom: rule.effectiveFrom.toISOString().slice(0, 10),
        active: rule.active,
        note: rule.note,
      })),
    };
  }

  private async loadItems(from: string, to: string): Promise<ExpenseItem[]> {
    const gte = new Date(`${from}T00:00:00.000Z`);
    const lt = new Date(`${to}T00:00:00.000Z`);
    lt.setUTCDate(lt.getUTCDate() + 1);
    const range = { gte, lt };

    const [vehicles, yamahaEntries, rules] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: {
          OR: [
            { transferCompletedDate: range },
            { inspectionSentDate: range },
            { inspectionResultDate: range },
            { inspectionRound2Date: range },
          ],
        },
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.yamahaRelocationEntry.findMany({ where: { date: range } }),
      this.prisma.dailyExpenseRule.findMany(),
    ]);

    return collectExpenseItems({
      from,
      to,
      vehicles: vehicles.map((v) => ({
        id: v.id,
        chassis: v.chassis,
        customerName: v.customer.name,
        brandName: v.brand.name,
        transferDone: v.transferDone,
        transferCompletedDate: isoDay(v.transferCompletedDate),
        transferCost: decimalString(v.transferCost),
        inspectionSentType: v.inspectionSentType,
        inspectionSentDate: isoDay(v.inspectionSentDate),
        inspectionSentCost: decimalString(v.inspectionSentCost),
        inspectionResult: v.inspectionResult,
        inspectionResultDate: isoDay(v.inspectionResultDate),
        inspectionResultCost: decimalString(v.inspectionResultCost),
        inspectionRound2Done: v.inspectionRound2Done,
        inspectionRound2Date: isoDay(v.inspectionRound2Date),
        inspectionRound2Cost: decimalString(v.inspectionRound2Cost),
      })),
      yamahaEntries: yamahaEntries.map((entry) => ({
        id: entry.id,
        date: entry.date.toISOString().slice(0, 10),
        size: entry.size,
        count: entry.count,
        billFee: entry.billFee.toString(),
        noBillFee: entry.noBillFee.toString(),
      })),
      rules: rules.map((rule) => ({
        code: rule.code,
        label: rule.label,
        trigger: rule.trigger,
        amount: rule.amount.toString(),
        effectiveFrom: rule.effectiveFrom.toISOString().slice(0, 10),
        active: rule.active,
      })),
    });
  }
}

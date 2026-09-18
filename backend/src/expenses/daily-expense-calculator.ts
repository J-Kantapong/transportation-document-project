// รวมค่าใช้จ่ายรายวันจากทุกขั้นตอนที่มีการบันทึกค่าใช้จ่ายจริง (pure - ไม่แตะฐานข้อมูล เพื่อทดสอบได้)
//
// แหล่งข้อมูล (วันที่ของค่าใช้จ่าย = วันที่ที่บันทึกไว้ในขั้นตอนนั้น):
// - แจ้งย้าย/ตัดบัญชี: Vehicle.transferCost ณ transferCompletedDate (เฉพาะ transferDone)
// - ตรวจรถ: นับครั้งเดียวต่อคัน - ถ้าบันทึกผลตรวจพร้อมค่าใช้จ่ายแล้วใช้ inspectionResultCost ณ
//   inspectionResultDate (ค่าใช้จ่ายจริง ซึ่งหน้าตรวจรถตั้งค่าเริ่มต้นมาจากค่าส่งตรวจ) ไม่อย่างนั้นใช้
//   inspectionSentCost ณ inspectionSentDate - ห้ามรวมทั้งสองช่อง ไม่อย่างนั้นค่าตรวจจะถูกนับซ้ำ
// - ตรวจรถรอบ 2: inspectionRound2Cost ณ inspectionRound2Date (เฉพาะ inspectionRound2Done)
// - งานแจ้งย้ายยามาฮ่า: billFee + noBillFee ของแต่ละแถว ณ date
// - เงื่อนไขรายวัน (DailyExpenseRule): เช่น ค่าคำขอตรวจรถ 25 บาท ครั้งเดียวต่อวันที่มีการตรวจรถ
//
// ภาษีรถประจำปี (TaxCalculation) ไม่นับ - เป็นผลคำนวณ ไม่ใช่การจ่ายจริง. รายการที่ยอด 0 บาท
// (เช่น เอารถมาตรวจเอง) ไม่แสดงเป็นรายการค่าใช้จ่าย แต่ยังนับเป็น "วันที่มีการตรวจรถ" ตามเงื่อนไข.

export type ExpenseCategory = 'DAILY_RULE' | 'TRANSFER_NOTICE' | 'INSPECTION' | 'INSPECTION_ROUND2' | 'YAMAHA_RELOCATION';

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  DAILY_RULE: 'ค่าใช้จ่ายตามเงื่อนไขรายวัน',
  TRANSFER_NOTICE: 'แจ้งย้าย/ตัดบัญชี',
  INSPECTION: 'ตรวจรถ',
  INSPECTION_ROUND2: 'ตรวจรถรอบ 2',
  YAMAHA_RELOCATION: 'งานแจ้งย้ายยามาฮ่า',
};

export const EXPENSE_CATEGORY_ORDER = Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[];

export type DailyExpenseTriggerCode = 'INSPECTION_DAY';

export const DAILY_EXPENSE_TRIGGER_LABELS: Record<DailyExpenseTriggerCode, string> = {
  INSPECTION_DAY: 'ทุกวันที่มีการตรวจรถอย่างน้อย 1 คัน (ส่งตรวจ หรือ ตรวจรถรอบ 2) - คิดครั้งเดียวต่อวัน',
};

// วันที่ทั้งหมดในไฟล์นี้เป็นสตริง ISO 'YYYY-MM-DD' (เทียบกันแบบสตริงได้ตรงลำดับเวลา)
export interface ExpenseVehicleInput {
  id: string;
  chassis: string;
  customerName: string;
  brandName: string;
  transferDone: boolean;
  transferCompletedDate: string | null;
  transferCost: string | null;
  inspectionSentType: string | null;
  inspectionSentDate: string | null;
  inspectionSentCost: string | null;
  inspectionResult: string | null;
  inspectionResultDate: string | null;
  inspectionResultCost: string | null;
  inspectionRound2Done: boolean;
  inspectionRound2Date: string | null;
  inspectionRound2Cost: string | null;
}

export interface ExpenseYamahaInput {
  id: string;
  date: string;
  size: 'SMALL' | 'LARGE';
  count: number;
  billFee: string;
  noBillFee: string;
}

export interface DailyExpenseRuleInput {
  code: string;
  label: string;
  trigger: DailyExpenseTriggerCode;
  amount: string;
  effectiveFrom: string;
  active: boolean;
}

export interface ExpenseItem {
  id: string;
  date: string;
  category: ExpenseCategory;
  label: string;
  detail: string;
  amountSatang: number;
}

// รวมยอดเป็นสตางค์ (จำนวนเต็ม) กันทศนิยมลอยตัวคลาดเคลื่อน
export function toSatang(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function vehicleDetail(v: ExpenseVehicleInput): string {
  return [v.chassis, v.brandName, v.customerName].filter(Boolean).join(' · ');
}

// เงื่อนไขหนึ่ง code อาจมีหลายแถว (อัตราเก่า/ใหม่) - ใช้แถวที่ effectiveFrom ล่าสุดที่ไม่เกินวันนั้น
// ถ้าแถวนั้น active = false แปลว่าปิดเงื่อนไขตั้งแต่วันนั้น
export function ruleForDay(rules: DailyExpenseRuleInput[], code: string, day: string): DailyExpenseRuleInput | null {
  let chosen: DailyExpenseRuleInput | null = null;
  for (const rule of rules) {
    if (rule.code !== code || rule.effectiveFrom > day) continue;
    if (!chosen || rule.effectiveFrom > chosen.effectiveFrom) chosen = rule;
  }
  return chosen?.active ? chosen : null;
}

// วันที่มีการตรวจรถ -> จำนวนครั้งที่ตรวจในวันนั้น (ส่งตรวจ + ตรวจรถรอบ 2)
export function inspectionDays(vehicles: ExpenseVehicleInput[]): Map<string, number> {
  const days = new Map<string, number>();
  const add = (day: string | null) => {
    if (day) days.set(day, (days.get(day) ?? 0) + 1);
  };
  for (const v of vehicles) {
    add(v.inspectionSentDate);
    if (v.inspectionRound2Done) add(v.inspectionRound2Date);
  }
  return days;
}

export function collectExpenseItems(input: {
  vehicles: ExpenseVehicleInput[];
  yamahaEntries: ExpenseYamahaInput[];
  rules: DailyExpenseRuleInput[];
  from: string;
  to: string;
}): ExpenseItem[] {
  const { vehicles, yamahaEntries, rules, from, to } = input;
  const inRange = (day: string) => day >= from && day <= to;
  const items: ExpenseItem[] = [];
  const push = (item: ExpenseItem) => {
    if (inRange(item.date) && item.amountSatang > 0) items.push(item);
  };

  for (const v of vehicles) {
    const transfer = toSatang(v.transferCost);
    if (v.transferDone && v.transferCompletedDate && transfer !== null) {
      push({
        id: `transfer:${v.id}`,
        date: v.transferCompletedDate,
        category: 'TRANSFER_NOTICE',
        label: 'ค่าแจ้งย้าย/ตัดบัญชี',
        detail: vehicleDetail(v),
        amountSatang: transfer,
      });
    }

    const resultCost = v.inspectionResultDate ? toSatang(v.inspectionResultCost) : null;
    const sentCost = toSatang(v.inspectionSentCost);
    if (v.inspectionResultDate && resultCost !== null) {
      push({
        id: `inspection:${v.id}`,
        date: v.inspectionResultDate,
        category: 'INSPECTION',
        label: `ค่าตรวจรถ (${v.inspectionResult ?? 'บันทึกผลตรวจ'})`,
        detail: vehicleDetail(v),
        amountSatang: resultCost,
      });
    } else if (v.inspectionSentDate && sentCost !== null) {
      push({
        id: `inspection:${v.id}`,
        date: v.inspectionSentDate,
        category: 'INSPECTION',
        label: `ค่าส่งตรวจ (${v.inspectionSentType ?? 'ส่งตรวจ'})`,
        detail: vehicleDetail(v),
        amountSatang: sentCost,
      });
    }

    const round2 = toSatang(v.inspectionRound2Cost);
    if (v.inspectionRound2Done && v.inspectionRound2Date && round2 !== null) {
      push({
        id: `round2:${v.id}`,
        date: v.inspectionRound2Date,
        category: 'INSPECTION_ROUND2',
        label: 'ค่าตรวจรถรอบ 2',
        detail: vehicleDetail(v),
        amountSatang: round2,
      });
    }
  }

  for (const entry of yamahaEntries) {
    push({
      id: `yamaha:${entry.id}`,
      date: entry.date,
      category: 'YAMAHA_RELOCATION',
      label: `แจ้งย้ายยามาฮ่า ${entry.size === 'SMALL' ? 'รถเล็ก' : 'รถใหญ่'}`,
      detail: `${entry.count} คัน`,
      amountSatang: (toSatang(entry.billFee) ?? 0) + (toSatang(entry.noBillFee) ?? 0),
    });
  }

  const inspectionRuleCodes = [...new Set(rules.filter((r) => r.trigger === 'INSPECTION_DAY').map((r) => r.code))];
  for (const [day, count] of inspectionDays(vehicles)) {
    for (const code of inspectionRuleCodes) {
      const rule = ruleForDay(rules, code, day);
      if (!rule) continue;
      push({
        id: `rule:${code}:${day}`,
        date: day,
        category: 'DAILY_RULE',
        label: rule.label,
        detail: `ตรวจรถ ${count} คันในวันนี้ · คิดครั้งเดียวต่อวัน`,
        amountSatang: toSatang(rule.amount) ?? 0,
      });
    }
  }

  return items.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      EXPENSE_CATEGORY_ORDER.indexOf(a.category) - EXPENSE_CATEGORY_ORDER.indexOf(b.category) ||
      a.detail.localeCompare(b.detail),
  );
}

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

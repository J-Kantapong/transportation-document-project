// ตัวคำนวณล้วนๆ (ไม่แตะฐานข้อมูล) ของหน้าภาพรวมผู้บริหาร - ใช้ใน OverviewService และทดสอบแยกได้
// วันที่ทุกตัวเป็นข้อความ ค.ศ. YYYY-MM-DD (เที่ยงคืน UTC เหมือนทั้งระบบ) ยกเว้นที่ระบุว่า Date

const DAY_MS = 24 * 60 * 60 * 1000;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const toDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
export const isoOf = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  return isoOf(new Date(toDate(iso).getTime() + days * DAY_MS));
}

// จำนวนวันเต็มจาก from ถึง to (to - from) เป็นลบได้ถ้า to อยู่ก่อน from
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((toDate(toIso).getTime() - toDate(fromIso).getTime()) / DAY_MS);
}

// วันนี้ตามเวลาไทย (UTC+7) - เซิร์ฟเวอร์รันเป็น UTC จึงต้องเลื่อนเอง ไม่งั้นช่วง 00:00-07:00 จะเป็นวันเมื่อวาน
export function bangkokToday(now: Date = new Date()): string {
  return isoOf(new Date(now.getTime() + 7 * 60 * 60 * 1000));
}

// เปลี่ยนแปลงเป็น % เทียบช่วงก่อนหน้า - ไม่มีฐานเทียบ (ก่อนหน้า = 0) ให้ null ห้ามแสดง 100%/∞ หลอกตา
export function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return round2(((current - previous) / previous) * 100);
}

// --- ลูกหนี้ ---------------------------------------------------------------------

export const AGING_BUCKETS = [
  { key: 'd0_30', label: '0-30 วัน', max: 30 },
  { key: 'd31_60', label: '31-60 วัน', max: 60 },
  { key: 'd61_90', label: '61-90 วัน', max: 90 },
  { key: 'd90p', label: 'เกิน 90 วัน', max: Infinity },
] as const;

export function agingBuckets(items: Array<{ date: string; amount: number }>, today: string) {
  const out = AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label, amount: 0, count: 0 }));
  for (const item of items) {
    const age = Math.max(0, daysBetween(item.date, today));
    const idx = AGING_BUCKETS.findIndex((b) => age <= b.max);
    out[idx].amount += item.amount;
    out[idx].count += 1;
  }
  return out.map((b) => ({ ...b, amount: round2(b.amount) }));
}

// --- ประมาณการรับเงิน ---------------------------------------------------------------

export const DEFAULT_PAY_DAYS = 30; // ยังไม่มีประวัติชำระเงินเลย
export const DEFAULT_BILLING_LAG_DAYS = 7; // ยังไม่มีประวัติส่งงาน -> วางบิล
export const MIN_PAY_SAMPLES = 3; // ลูกค้าที่มีประวัติน้อยกว่านี้ใช้ค่าเฉลี่ยรวมแทน
export const FORECAST_MAX_AGE_DAYS = 90; // ค้างเกินนี้ไม่นับเป็นเงินที่จะได้ (แยกเป็น "เสี่ยง")

export interface PaidSample {
  customerId: string;
  issueDate: string;
  paidDate: string;
  firstDeliveredDate: string | null; // วันส่งงานเร็วสุดในบิลนั้น - ใช้หาเวลาจากส่งงานถึงวางบิล
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function paymentBehaviour(samples: PaidSample[]) {
  const daysByCustomer = new Map<string, number[]>();
  const all: number[] = [];
  const lags: number[] = [];
  for (const s of samples) {
    const d = Math.max(0, daysBetween(s.issueDate, s.paidDate));
    all.push(d);
    daysByCustomer.set(s.customerId, [...(daysByCustomer.get(s.customerId) ?? []), d]);
    if (s.firstDeliveredDate) lags.push(Math.max(0, daysBetween(s.firstDeliveredDate, s.issueDate)));
  }
  const overall = mean(all);
  const perCustomer = new Map<string, number>();
  for (const [id, ds] of daysByCustomer) if (ds.length >= MIN_PAY_SAMPLES) perCustomer.set(id, mean(ds)!);
  return {
    avgDaysToPay: overall === null ? null : Math.round(overall),
    avgBillingLagDays: lags.length ? Math.round(mean(lags)!) : null,
    samples: all.length,
    payDaysFor: (customerId: string) => Math.round(perCustomer.get(customerId) ?? overall ?? DEFAULT_PAY_DAYS),
    billingLagDays: lags.length ? Math.round(mean(lags)!) : DEFAULT_BILLING_LAG_DAYS,
  };
}

export interface ForecastInput {
  today: string;
  weeks: number;
  receivable: Array<{ customerId: string; issueDate: string; amount: number }>; // บิลที่วางแล้วรอรับเงิน
  unbilled: Array<{ customerId: string; deliveredDate: string; amount: number }>; // ส่งงานแล้วยังไม่วางบิล
  payDaysFor: (customerId: string) => number;
  billingLagDays: number;
  avgDailySpend: number;
}

// สัปดาห์ที่ i ครอบวัน today+7i .. today+7i+6 - บิลที่ครบกำหนดคาดการณ์ไปแล้ว (เลยกำหนด) ใส่สัปดาห์แรก (ต้องตามทวง)
// บิลค้างเกิน FORECAST_MAX_AGE_DAYS ไม่นับ แยกเป็น atRisk ให้ผู้บริหารเห็นว่ามีเงินที่อาจไม่ได้
export function buildForecast(input: ForecastInput) {
  const { today, weeks } = input;
  const inflow = Array<number>(weeks).fill(0);
  const overdueInflow = Array<number>(weeks).fill(0);
  let atRiskAmount = 0;
  let atRiskCount = 0;

  const place = (expectedIso: string, amount: number) => {
    const offset = daysBetween(today, expectedIso);
    const overdue = offset < 0;
    const week = Math.min(weeks - 1, Math.max(0, Math.floor(Math.max(0, offset) / 7)));
    if (offset >= weeks * 7) return; // เกินขอบเขตประมาณการ
    inflow[week] += amount;
    if (overdue) overdueInflow[week] += amount;
  };

  for (const r of input.receivable) {
    if (daysBetween(r.issueDate, today) > FORECAST_MAX_AGE_DAYS) {
      atRiskAmount += r.amount;
      atRiskCount += 1;
      continue;
    }
    place(addDays(r.issueDate, input.payDaysFor(r.customerId)), r.amount);
  }
  for (const u of input.unbilled) {
    if (daysBetween(u.deliveredDate, today) > FORECAST_MAX_AGE_DAYS) continue; // ข้อมูลเก่าค้างสะสม ไม่ใช่เงินที่คาดว่าจะเข้าเร็วๆ นี้
    const billOn = addDays(u.deliveredDate, input.billingLagDays);
    const billed = daysBetween(today, billOn) < 0 ? today : billOn; // เลยเวลาที่ควรวางบิลแล้ว = วางบิลวันนี้
    place(addDays(billed, input.payDaysFor(u.customerId)), u.amount);
  }

  let cumulative = 0;
  const rows = inflow.map((inAmount, i) => {
    const outAmount = round2(input.avgDailySpend * 7);
    const net = inAmount - outAmount;
    cumulative += net;
    return {
      weekStart: addDays(today, i * 7),
      weekEnd: addDays(today, i * 7 + 6),
      inflow: round2(inAmount),
      overdueInflow: round2(overdueInflow[i]),
      outflow: round2(outAmount),
      net: round2(net),
      cumulativeNet: round2(cumulative),
    };
  });
  return { weeks: rows, atRiskAmount: round2(atRiskAmount), atRiskCount };
}

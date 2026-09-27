// บัญชีรับเงินของลูกค้า (ผู้ใช้ 2026-09-26/27) - ฟังก์ชันล้วน ไม่แตะฐานข้อมูล
// COMPANY = บัญชีบริษัท (มี VAT), PERSONAL = บัญชีบุคคล (เช่น SPI, YMAC - ไม่มี VAT)
// ลูกค้าหนึ่งรายใช้บัญชีเดียว แต่ย้ายได้ในอนาคตพร้อมวันเริ่มใช้ - งานวันไหนใช้บัญชีของวันนั้น ย้ายแล้วงานเก่าไม่เปลี่ยนตาม

export const ACCOUNTS = ['COMPANY', 'PERSONAL'] as const;
export type BillingAccount = (typeof ACCOUNTS)[number];

export const ACCOUNT_LABEL: Record<BillingAccount, string> = { COMPANY: 'บัญชีบริษัท', PERSONAL: 'บัญชีบุคคล' };

export const isBillingAccount = (v: unknown): v is BillingAccount => typeof v === 'string' && (ACCOUNTS as readonly string[]).includes(v);

export interface AccountPeriod {
  account: string;
  effectiveFrom: string; // ISO YYYY-MM-DD
}

// บัญชีที่ใช้ ณ วันที่ dateIso = แถวล่าสุดที่เริ่มใช้ไม่เกินวันนั้น / ก่อนแถวแรก หรือไม่มีแถวเลย = บัญชีบริษัท
export function accountOn(periods: AccountPeriod[], dateIso: string): BillingAccount {
  let best: AccountPeriod | null = null;
  for (const p of periods) {
    if (p.effectiveFrom <= dateIso && (!best || p.effectiveFrom > best.effectiveFrom)) best = p;
  }
  return best && isBillingAccount(best.account) ? best.account : 'COMPANY';
}

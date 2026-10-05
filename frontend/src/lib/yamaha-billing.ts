import type { ItemRow } from "@/components/InvoiceItemsEditor";

// ราคาและชื่อบรรทัดบิลงานแจ้งย้ายยามาฮ่า (ผู้ใช้ 2026-10-05) ใช้ในหน้าบิลกำหนดเอง: dropdown ราคา + ปุ่มดึงยอดของเดือน
// ลำดับและชื่อตามที่ผู้ใช้กำหนด - รถเล็ก: ค่าธรรมเนียม / ค่าบริการ / ค่าบริการจัดการเอกสารบัญชีรายเดือน · รถใหญ่: ค่าธรรมเนียม / ค่าบริการ
// ชื่อและราคาตรงกับใบเสนอราคา (backend/src/billing/quotation-calc.ts) - แก้สองที่ให้ตรงกัน
// ค่าธรรมเนียม = ค่าใบเสร็จกรมขนส่ง 5 บาท/คัน (ไม่มี VAT ไม่หัก) · ค่าบริการ = VAT + หัก ณ ที่จ่าย
// ราคาค่าบริการรถเล็กทำ 3 ปีแรก: 2026 = 20, 2027 = 21, 2028 = 22 · ต้นทุนยังไม่ทราบ เว้นว่างไว้
const FEE_TITLE = "ค่าธรรมเนียมแจ้งย้ายรถจักรยานยนต์";
const SERVICE_TITLE = "ค่าบริการแจ้งย้ายรถจักรยานยนต์";
const MONTHLY_TITLE = "ค่าบริการจัดการเอกสารบัญชีรถจักรยานยนต์ยามาฮ่า";
const FEE_PER_VEHICLE = 5;
const MONTHLY_FEE = 9000;

// รถเล็ก 20 บาท (21 ตั้งแต่ 2027-01, 22 ตั้งแต่ 2028-01) · รถใหญ่ 50 บาท - month = YYYY-MM (ค.ศ.)
export function yamahaServiceRate(
  size: "SMALL" | "LARGE",
  month: string,
): number {
  if (size === "LARGE") return 50;
  if (month >= "2028-01") return 22;
  if (month >= "2027-01") return 21;
  return 20;
}

// ลูกค้ายามาฮ่า = ชื่อบริษัท/ชื่อมีคำว่า ยามาฮ่า หรือ yamaha
export const isYamahaCustomer = (c: {
  company?: string | null;
  name?: string | null;
}): boolean => /ยามาฮ่า|yamaha/i.test(`${c.company ?? ""} ${c.name ?? ""}`);

const THAI_MONTHS = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

// YYYY-MM -> "ตุลาคม 2026" (ปี ค.ศ. ตามที่ผู้ใช้เลือก 2026-10-05)
export const thaiMonthLabel = (month: string): string =>
  `${THAI_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

interface YamahaLine {
  id: string;
  size: "SMALL" | "LARGE" | null; // null = รายเดือน ไม่ผูกกับขนาด
  kind: ItemRow["kind"];
  description: string;
  unit: number;
  unitNote: string;
}

// ทุกบรรทัดของเดือน month ตามลำดับที่ผู้ใช้กำหนด
function yamahaLines(month: string): YamahaLine[] {
  const m = thaiMonthLabel(month);
  const sized = (size: "SMALL" | "LARGE"): YamahaLine[] => {
    const tag = size === "SMALL" ? "(เล็ก)" : "(ใหญ่)";
    const id = size === "SMALL" ? "small" : "large";
    return [
      {
        id: `fee-${id}`,
        size,
        kind: "FEE",
        description: `${FEE_TITLE} ${tag} ประจำเดือน ${m}`,
        unit: FEE_PER_VEHICLE,
        unitNote: "/คัน (ไม่มี VAT)",
      },
      {
        id: `svc-${id}`,
        size,
        kind: "SERVICE",
        description: `${SERVICE_TITLE} ${tag}`,
        unit: yamahaServiceRate(size, month),
        unitNote: "/คัน",
      },
    ];
  };
  const [feeSmall, svcSmall] = sized("SMALL");
  return [
    feeSmall,
    svcSmall,
    {
      id: "monthly",
      size: null,
      kind: "SERVICE",
      description: MONTHLY_TITLE,
      unit: MONTHLY_FEE,
      unitNote: "/เดือน",
    },
    ...sized("LARGE"),
  ];
}

const money = (n: number) => n.toLocaleString("en-US");

const rowOf = (l: YamahaLine, quantity: number): ItemRow => ({
  kind: l.kind,
  description: l.description,
  quantityText: String(quantity),
  unitPriceText: String(l.unit),
  costText: "",
});

export interface YamahaPriceOption {
  id: string;
  label: string; // ข้อความใน dropdown (มีราคา)
  row: ItemRow;
}

// ตัวเลือกใน dropdown: เติมทีละบรรทัด จำนวน 1 ให้แก้เอง
export function yamahaPriceOptions(month: string): YamahaPriceOption[] {
  return yamahaLines(month).map((l) => ({
    id: l.id,
    label: `${l.description} - ${money(l.unit)} บาท${l.unitNote}`,
    row: rowOf(l, 1),
  }));
}

// บิลทั้งชุดของเดือนจากยอดแจ้งย้ายในระบบ - ขนาดที่ไม่มีรถในเดือนนั้นไม่ออกบรรทัด · รายเดือนมีเสมอ
export function yamahaBillRows(
  month: string,
  counts: { SMALL: number; LARGE: number },
): ItemRow[] {
  return yamahaLines(month)
    .filter((l) => l.size === null || counts[l.size] > 0)
    .map((l) => rowOf(l, l.size === null ? 1 : counts[l.size]));
}

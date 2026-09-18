// Seeds the fee master/reference tables from the user's registration pricing spec
// (prototype/sites-reference/docs/vehicle_registration_pricing_db.xlsx). Run with:
//   npx prisma db seed
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { GovTaxFuelGroup, GovTaxRuleStatus, GovTaxVehicleFamily } from "../src/generated/prisma/enums.js";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const TYPE_BRAND_ROWS: Array<[string, string]> = [
  ["รย.12-น้อยกว่า 300cc", "อื่นๆ"],
  ["รย.12-300-799cc", "อื่นๆ"],
  ["รย.12-800-999cc", "อื่นๆ"],
  ["รย.12-1000cc ขึ้นไป", "อื่นๆ"],
  ["รย.1-เก๋ง 2 ตอน", "อื่นๆ"],
  ["รย.1-เก๋ง 2 ตอน", "Benz"],
  ["รย.1-เก๋ง 2 ตอน", "BMW"],
  ["รย.1-เก๋ง 2 ตอน", "Lexus"],
  ["รย.1-เก๋ง 2 ตอน", "Volvo"],
  ["รย.1-นั่ง 2 ตอน", "อื่นๆ"],
  ["รย.1-นั่ง 3 ตอน", "อื่นๆ"],
  ["รย.2-นั่ง 2 แถว", "อื่นๆ"],
  ["รย.2-นั่ง 4 ตอน", "อื่นๆ"],
  ["รย.3-กระบะบรรทุก", "อื่นๆ"],
  ["รย.3-กระบะบรรทุกมีหลังคา", "อื่นๆ"],
  ["รย.3-กระบะบรรทุกมีหลังคาแหนบ", "อื่นๆ"],
  ["รย.3-ตู้บรรทุก", "อื่นๆ"],
  ["นำรถมาตรวจ", "อื่นๆ"],
];

const VEHICLE_TYPES_13 = [
  "รย.12-น้อยกว่า 300cc",
  "รย.12-300-799cc",
  "รย.12-800-999cc",
  "รย.12-1000cc ขึ้นไป",
  "รย.1-เก๋ง 2 ตอน",
  "รย.1-นั่ง 2 ตอน",
  "รย.1-นั่ง 3 ตอน",
  "รย.2-นั่ง 2 แถว",
  "รย.2-นั่ง 4 ตอน",
  "รย.3-กระบะบรรทุก",
  "รย.3-กระบะบรรทุกมีหลังคา",
  "รย.3-กระบะบรรทุกมีหลังคาแหนบ",
  "รย.3-ตู้บรรทุก",
];

const PROVINCES = [
  "กรุงเทพมหานคร", "สมุทรปราการ", "นนทบุรี", "ปทุมธานี", "พระนครศรีอยุธยา", "อ่างทอง", "ลพบุรี", "สิงห์บุรี",
  "ชัยนาท", "สระบุรี", "ชลบุรี", "ระยอง", "จันทบุรี", "ตราด", "ฉะเชิงเทรา", "ปราจีนบุรี", "นครนายก", "สระแก้ว",
  "นครราชสีมา", "บุรีรัมย์", "สุรินทร์", "ศรีสะเกษ", "อุบลราชธานี", "ยโสธร", "ชัยภูมิ", "อำนาจเจริญ", "บึงกาฬ",
  "หนองบัวลำภู", "ขอนแก่น", "อุดรธานี", "เลย", "หนองคาย", "มหาสารคาม", "ร้อยเอ็ด", "กาฬสินธุ์", "สกลนคร",
  "นครพนม", "มุกดาหาร", "เชียงใหม่", "ลำพูน", "ลำปาง", "อุตรดิตถ์", "แพร่", "น่าน", "พะเยา", "เชียงราย",
  "แม่ฮ่องสอน", "นครสวรรค์", "อุทัยธานี", "กำแพงเพชร", "ตาก", "สุโขทัย", "พิษณุโลก", "พิจิตร", "เพชรบูรณ์",
  "ราชบุรี", "กาญจนบุรี", "สุพรรณบุรี", "นครปฐม", "สมุทรสาคร", "สมุทรสงคราม", "เพชรบุรี", "ประจวบคีรีขันธ์",
  "นครศรีธรรมราช", "กระบี่", "พังงา", "ภูเก็ต", "สุราษฎร์ธานี", "ระนอง", "ชุมพร", "สงขลา", "สตูล", "ตรัง",
  "พัทลุง", "ปัตตานี", "ยะลา", "นราธิวาส",
];

// Display order for the ยี่ห้อ dropdown, user-specified. Benz/BMW/Lexus/Volvo also have
// their own fee row in the pricing spec (ตัดบัญชี/แจ้งย้าย/ตรวจรถ กทม. for รย.1-เก๋ง 2 ตอน),
// matched by name in vehicles.service.ts's fee lookup; the rest fall back to the "อื่นๆ"
// fee row. Brand.sortOrder defaults to 1000, so any brand added later via "+ เพิ่มยี่ห้อ"
// always lands after this curated list.
const ORDERED_BRANDS = ["Toyota", "Deepal", "Lexus", "Honda", "Yamaha", "Zontes", "Benz", "BMW", "Volvo"];

async function seedBrands() {
  for (const [index, name] of ORDERED_BRANDS.entries()) {
    const sortOrder = index + 1;
    await prisma.brand.upsert({ where: { name }, create: { name, sortOrder }, update: { sortOrder } });
  }
}

async function seedDeregistration() {
  const amounts = [12, 12, 12, 12, 20, 20, 20, 20, 20, 20, 20, 50, 50, 20, 20, 20, 20, 20];
  for (let i = 0; i < TYPE_BRAND_ROWS.length; i++) {
    const [vehicleType, brand] = TYPE_BRAND_ROWS[i];
    await prisma.feeDeregistration.upsert({
      where: { vehicleType_brand: { vehicleType, brand } },
      create: { vehicleType, brand, amount: amounts[i] },
      update: { amount: amounts[i] },
    });
  }
}

async function seedRelocate() {
  const noBillAmounts = [20, 20, 20, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  for (let i = 0; i < TYPE_BRAND_ROWS.length; i++) {
    const [vehicleType, brand] = TYPE_BRAND_ROWS[i];
    await prisma.feeRelocate.upsert({
      where: { vehicleType_brand: { vehicleType, brand } },
      create: { vehicleType, brand, noBillAmount: noBillAmounts[i], billAmount: 5 },
      update: { noBillAmount: noBillAmounts[i], billAmount: 5 },
    });
  }
}

async function seedInspectionBangkok() {
  const amounts = [50, 300, 500, 1000, 150, 200, 200, 200, 200, 300, 300, 500, 1000, 300, 1000, 3000, 1000, 0];
  for (let i = 0; i < TYPE_BRAND_ROWS.length; i++) {
    const [vehicleType, brand] = TYPE_BRAND_ROWS[i];
    await prisma.feeInspectionBangkok.upsert({
      where: { vehicleType_brand: { vehicleType, brand } },
      create: { vehicleType, brand, amount: amounts[i] },
      update: { amount: amounts[i] },
    });
  }
}

async function seedInspectionProvince() {
  // Empty shell: 77 provinces x 13 vehicle types, amount left null until the user
  // supplies province-by-province inspection rates. One bulk insert (not per-row
  // upserts) since this is 1001 rows and each upsert is a separate network round trip
  // to Neon. skipDuplicates keeps any amount already filled in by hand on a re-run.
  const data = PROVINCES.flatMap((province) =>
    VEHICLE_TYPES_13.map((vehicleType) => ({ province, vehicleType, amount: null })),
  );
  await prisma.feeInspectionProvince.createMany({ data, skipDuplicates: true });
}

// Government annual tax (ภาษีรถประจำปี) - only seed the rule sets the user has given exact
// figures for. The EV tax-incentive schedule is still missing (see memory
// project_fee_pricing_workflow); leave that empty rather than guessing.
async function seedGovernmentTaxCcBrackets() {
  // RY1 (รย.1) ICE/HEV/PHEV: progressive บาท/cc, ใช้สูตรเดียวกันทั้ง 3 เชื้อเพลิงตามที่ให้มา
  // ccFrom/ccTo คือเกณฑ์ต่อเนื่อง (0/600/1800) ไม่ใช่ช่วงจำนวนเต็มแบบ "601-1800" - อัตราส่วนเกินคิดจาก
  // ส่วนที่เกินเกณฑ์พอดี (เช่น cc=600 เสียแค่ 300 บาท ไม่ใช่ 601 * 0.5) ดู government-tax-calculator.ts
  const brackets: Array<[ccFrom: number, ccTo: number | null, ratePerCc: number, sortOrder: number]> = [
    [0, 600, 0.5, 0],
    [600, 1800, 1.5, 1],
    [1800, null, 4, 2],
  ];
  // status/active: VERIFIED+active because the user confirmed these figures in conversation
  // (see memory/project_fee_pricing_workflow.md) - not because a legal citation is attached.
  // See the governance comment above GovernmentTaxCcBracket in schema.prisma.
  for (const fuelGroup of [GovTaxFuelGroup.ICE, GovTaxFuelGroup.HEV, GovTaxFuelGroup.PHEV]) {
    for (const [ccFrom, ccTo, ratePerCc, sortOrder] of brackets) {
      await prisma.governmentTaxCcBracket.upsert({
        where: { vehicleFamily_fuelGroup_ccFrom: { vehicleFamily: GovTaxVehicleFamily.RY1, fuelGroup, ccFrom } },
        create: {
          vehicleFamily: GovTaxVehicleFamily.RY1,
          fuelGroup,
          ccFrom,
          ccTo,
          ratePerCc,
          sortOrder,
          status: GovTaxRuleStatus.VERIFIED,
          active: true,
        },
        update: { ccTo, ratePerCc, sortOrder, status: GovTaxRuleStatus.VERIFIED, active: true },
      });
    }
  }
}

// น้ำหนักรถ (กก.) -> ภาษีเหมาช่วง (บาท/ปี) สำหรับ รย.1-รถไฟฟ้า (BEV), รย.2 (ใช้ตาราง "passenger"
// เดียวกับ รย.1-BEV) และ รย.3 (ใช้ตาราง "truck") มาจากเอกสาร ก.พ. ตาราง 2-3 หน้า PDF 20-21 อ้าง DLT
// 2565 (https://www.ocsc.go.th/wp-content/uploads/2024/09/ISFE881.pdf) - ผู้ใช้ยืนยันให้ใช้เป็น
// ข้อมูลจริง (VERIFIED) เมื่อ 2026-09-19 แม้ไฟล์ต้นฉบับ (thai-vehicle-tax-engine build.mjs) จะทำเครื่องหมาย
// PENDING_REVIEW/disabled ไว้ก็ตาม - ตัวคูณเจ้าของรถ (นิติบุคคล x2) คูณทับตัวเลขนี้ต่อใน
// government-tax-calculator.ts ตามเดิม ไม่เปลี่ยนแปลง
async function seedGovernmentTaxWeightBrackets() {
  const bounds: Array<number | null> = [500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, null];
  const passenger = [150, 300, 450, 800, 1000, 1300, 1600, 1900, 2200, 2400, 2600, 2800, 3000, 3200, 3400, 3600];
  const truck = [300, 450, 600, 750, 900, 1050, 1350, 1650, 1950, 2250, 2550, 2850, 3150, 3450, 3750, 4050];
  const legalReference = "ก.พ. ตาราง 2-3 (อ้าง DLT 2565): https://www.ocsc.go.th/wp-content/uploads/2024/09/ISFE881.pdf";

  const rows: Array<{
    vehicleFamily: GovTaxVehicleFamily;
    fuelGroup: GovTaxFuelGroup | null;
    weightFrom: number;
    weightTo: number | null;
    amount: number;
    sortOrder: number;
  }> = [];
  bounds.forEach((weightTo, i) => {
    const weightFrom = i === 0 ? 0 : (bounds[i - 1] as number);
    rows.push({ vehicleFamily: GovTaxVehicleFamily.RY1, fuelGroup: GovTaxFuelGroup.BEV, weightFrom, weightTo, amount: passenger[i], sortOrder: i });
    rows.push({ vehicleFamily: GovTaxVehicleFamily.RY2, fuelGroup: null, weightFrom, weightTo, amount: passenger[i], sortOrder: i });
    rows.push({ vehicleFamily: GovTaxVehicleFamily.RY3, fuelGroup: null, weightFrom, weightTo, amount: truck[i], sortOrder: i });
  });

  for (const row of rows) {
    // upsert's compound-unique `where` rejects a literal null for the nullable fuelGroup column
    // (Prisma client validation, not a DB limitation) - findFirst+create/update by hand instead
    // for the RY2/RY3 rows (fuelGroup: null applies to every fuel, see schema.prisma comment).
    const existing = await prisma.governmentTaxWeightBracket.findFirst({
      where: { vehicleFamily: row.vehicleFamily, fuelGroup: row.fuelGroup, weightFrom: row.weightFrom },
    });
    const data = { weightTo: row.weightTo, amount: row.amount, sortOrder: row.sortOrder, status: GovTaxRuleStatus.VERIFIED, active: true, legalReference };
    if (existing) {
      await prisma.governmentTaxWeightBracket.update({ where: { id: existing.id }, data });
    } else {
      await prisma.governmentTaxWeightBracket.create({ data: { ...row, ...data } });
    }
  }
}

async function seedGovernmentTaxMotorcycleFlat() {
  // RY12 (รย.12) ICE: 100 บาท/ปี คงที่ทุก cc ตามกฎ ไม่ผูกกับช่วง cc ที่ใช้ตั้งราคาบริการบริษัท
  // ยืนยันแล้วตามที่ผู้ใช้ให้มา - VERIFIED+active
  await prisma.governmentTaxMotorcycleFlat.upsert({
    where: { fuelGroup: GovTaxFuelGroup.ICE },
    create: { fuelGroup: GovTaxFuelGroup.ICE, amount: 100, status: GovTaxRuleStatus.VERIFIED, active: true },
    update: { amount: 100, status: GovTaxRuleStatus.VERIFIED, active: true },
  });
  // RY12 BEV: กฎแยกต่างหาก ยังไม่มีข้อมูล - เตรียมแถวไว้เฉยๆ รอผู้ใช้ให้เงื่อนไข
  await prisma.governmentTaxMotorcycleFlat.upsert({
    where: { fuelGroup: GovTaxFuelGroup.BEV },
    create: { fuelGroup: GovTaxFuelGroup.BEV, amount: null, note: "รอกฎภาษีรถจักรยานยนต์ไฟฟ้าแยกต่างหาก" },
    update: {},
  });
}

async function seedParamTable(
  model: "feeCarBillParam" | "feeCarNoBillParam" | "feeMotorcycleBillParam" | "feeMotorcycleNoBillParam",
  rows: Array<[string, number | null, (string | null)?]>,
) {
  for (const [key, amount, note] of rows) {
    await (prisma[model] as any).upsert({
      where: { key },
      create: { key, amount, note: note ?? null },
      update: { amount, note: note ?? null },
    });
  }
}

async function main() {
  await seedBrands();
  await seedDeregistration();
  await seedRelocate();
  await seedInspectionBangkok();
  await seedInspectionProvince();
  await seedGovernmentTaxCcBrackets();
  await seedGovernmentTaxWeightBrackets();
  await seedGovernmentTaxMotorcycleFlat();
  // ค่าภาษีรถยนต์/รถจักรยานยนต์ เดิมเคยเป็นแถว param เดี่ยวๆ ด้านล่าง (กรอกเอง) - ย้ายไปคำนวณจาก
  // GovernmentTaxCcBracket/WeightBracket/MotorcycleFlat แทนแล้ว ลบแถวเก่าทิ้งกันข้อมูลซ้ำซ้อน/ขัดแย้งกัน
  await prisma.feeCarBillParam.deleteMany({ where: { key: "ค่าภาษีรถยนต์" } });
  await prisma.feeMotorcycleBillParam.deleteMany({ where: { key: "ค่าภาษีรถจักรยานยนต์" } });

  await seedParamTable("feeCarBillParam", [
    ["ค่าคำขอ (ปกติ)", 5, "ใช้เมื่อจดในจังหวัดภูมิลำเนาของเจ้าของรถ"],
    ["ค่าคำขอ (ขอใช้จังหวัดอื่น)", 10, "ใช้เมื่อมีรายการนอกเหนือจากการจดทะเบียนปกติ ซึ่งมีรายการเพิ่มเติมมากกว่าปกติ (ไม่จำกัดเฉพาะกรณีข้ามจังหวัด)"],
    ["ค่าธรรมเนียมอื่นๆ (ขอใช้จังหวัดอื่น)", 20, "เพิ่มเฉพาะกรณีขอใช้จังหวัดอื่น"],
    ["ค่าตรวจสภาพรถ (Step4)", 50, null],
    ["ค่าแผ่นป้ายทะเบียนรถ", 200, null],
    ["ค่าใบคู่มือการจดทะเบียน", 100, null],
    ["ค่าขอใช้เลขทะเบียน - เลขประมูล", 1500, null],
    ["ค่าขอใช้เลขทะเบียน - ไม่ใช่เลขประมูล", 500, null],
    ["ค่าทำแผ่นป้ายทะเบียนใหม่ - ป้ายขาวดำ", 200, null],
    ["ค่าทำแผ่นป้ายทะเบียนใหม่ - ป้ายประมูล", 1200, null],
    ["ค่าย้ายออกต่างจังหวัด", 50, "กรณีจดพร้อมย้ายออกไปต่างจังหวัด"],
  ]);

  await seedParamTable("feeCarNoBillParam", [
    ["ค่าอากร (ปกติ)", 10, null],
    ["ค่าอากร (ทำเพิ่มเติมเกิน 1 รายการ)", 30, null],
    ["ลงขัน - รย.1-เก๋ง 2 ตอน", 40, null],
    ["ลงขัน - รย.1-นั่ง 2 ตอน", 40, null],
    ["ลงขัน - รย.1-นั่ง 3 ตอน", 40, null],
    ["ลงขัน - รย.2-นั่ง 2 แถว", 40, null],
    ["ลงขัน - รย.2-นั่ง 4 ตอน", 40, null],
    ["ลงขัน - รย.3-กระบะบรรทุก", 40, null],
    ["ลงขัน - รย.3-กระบะบรรทุกมีหลังคา", 40, null],
    ["ลงขัน - รย.3-กระบะบรรทุกมีหลังคาแหนบ", 40, null],
    ["ลงขัน - รย.3-ตู้บรรทุก", 40, null],
    ["งานด่วนเพิ่ม (ต่อคัน)", 100, null],
  ]);

  await seedParamTable("feeMotorcycleBillParam", [
    ["ค่าคำขอ (ปกติ)", 5, "ใช้เมื่อจดในจังหวัดภูมิลำเนาของเจ้าของรถ"],
    ["ค่าคำขอ (ขอใช้จังหวัดอื่น)", 10, "ใช้เมื่อมีรายการนอกเหนือจากการจดทะเบียนปกติ ซึ่งมีรายการเพิ่มเติมมากกว่าปกติ (ไม่จำกัดเฉพาะกรณีข้ามจังหวัด)"],
    ["ค่าธรรมเนียมอื่นๆ (ขอใช้จังหวัดอื่น)", 20, "เพิ่มเฉพาะกรณีขอใช้จังหวัดอื่น"],
    ["ค่าตรวจสภาพรถ (จยย.)", 10, null],
    ["ค่าแผ่นป้ายทะเบียน", 100, null],
    ["ค่าใบคู่มือจดทะเบียน", 100, null],
    ["ค่าขอใช้เลขทะเบียน", 500, "มอเตอร์ไซค์มีราคาเดียว ไม่แยกเลขประมูล/ไม่ใช่เลขประมูลแบบรถยนต์"],
  ]);

  await seedParamTable("feeMotorcycleNoBillParam", [
    ["ค่าอากร (ปกติ)", 10, null],
    ["ค่าอากร (ทำเพิ่มเติมเกิน 1 รายการ)", 30, null],
    ["ลงขัน - รย.12 ทุกประเภท (CC)", 40, "ข้อมูลต้นทางระบุ 40 บาทเท่ากันทุกช่วง CC"],
    ["ลงขันด่วนเพิ่ม (ต่อคัน)", 50, null],
    ["ลงขัน - จดใหม่ หยุดใช้ย้ายออก", 250, "เฉพาะมอเตอร์ไซค์ - แทนที่ลงขันปกติเมื่อเลือกตัวเลือกนี้"],
  ]);

  console.log("Brands and fee master tables seeded.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });

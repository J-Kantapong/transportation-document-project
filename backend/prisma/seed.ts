// Seeds the fee master/reference tables from the user's registration pricing spec
// (prototype/sites-reference/docs/vehicle_registration_pricing_db.xlsx). Run with:
//   npx prisma db seed
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

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

async function seedParamTable(
  model: "feeCarBillParam" | "feeCarNoBillParam" | "feeMotorcycleBillParam" | "feeMotorcycleNoBillParam",
  rows: Array<[string, number | null, string?]>,
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

  await seedParamTable("feeCarBillParam", [
    ["ค่าคำขอ (ปกติ)", 5, "ใช้เมื่อจดในจังหวัดภูมิลำเนาของเจ้าของรถ"],
    ["ค่าคำขอ (ขอใช้จังหวัดอื่น)", 10, "ใช้เมื่อจังหวัดที่จดทะเบียนต่างจากจังหวัดเจ้าของรถ"],
    ["ค่าธรรมเนียมอื่นๆ (ขอใช้จังหวัดอื่น)", 20, "เพิ่มเฉพาะกรณีขอใช้จังหวัดอื่น"],
    ["ค่าตรวจสภาพรถ (Step4)", 50, null],
    ["ค่าแผ่นป้ายทะเบียนรถ", 200, null],
    ["ค่าใบคู่มือการจดทะเบียน", 100, null],
    ["ค่าภาษีรถยนต์", 0, "ยังไม่ได้กำหนดสูตร (อิง CC/น้ำหนัก/ประเภทเชื้อเพลิง) - กรอกเองต่อคันจนกว่าจะได้เงื่อนไข"],
    ["ค่าขอใช้เลขทะเบียน - เลขประมูล", 1500, null],
    ["ค่าขอใช้เลขทะเบียน - ไม่ใช่เลขประมูล", 500, null],
    ["ค่าทำแผ่นป้ายทะเบียนใหม่ - ป้ายขาวดำ", 200, null],
    ["ค่าทำแผ่นป้ายทะเบียนใหม่ - ป้ายประมูล", 1200, null],
    ["ค่าย้ายออกต่างจังหวัด", 50, "กรณีจดพร้อมย้ายออกไปต่างจังหวัด"],
  ]);

  await seedParamTable("feeCarNoBillParam", [
    ["ค่าอากร (ปกติ)", 10, null],
    ["ค่าอากร (ทำเพิ่มเติมเกิน 1 รายการ)", 30, null],
    ["ลงขัน - รย.1-เก๋ง 2 ตอน", 50, null],
    ["ลงขัน - รย.1-นั่ง 2 ตอน", 100, null],
    ["ลงขัน - รย.1-นั่ง 3 ตอน", 50, null],
    ["ลงขัน - รย.2-นั่ง 2 แถว", 50, null],
    ["ลงขัน - รย.2-นั่ง 4 ตอน", 50, null],
    ["ลงขัน - รย.3-กระบะบรรทุก", 50, null],
    ["ลงขัน - รย.3-กระบะบรรทุกมีหลังคา", 50, null],
    ["ลงขัน - รย.3-กระบะบรรทุกมีหลังคาแหนบ", null, "ไม่มีราคาลงขันในข้อมูลที่ให้มา - กรอกเพิ่มเอง"],
    ["ลงขัน - รย.3-ตู้บรรทุก", 50, null],
    ["งานด่วนเพิ่ม (ต่อคัน)", 100, null],
  ]);

  await seedParamTable("feeMotorcycleBillParam", [
    ["ค่าคำขอ (ปกติ)", 5, "ใช้เมื่อจดในจังหวัดภูมิลำเนาของเจ้าของรถ"],
    ["ค่าคำขอ (ขอใช้จังหวัดอื่น)", 10, "ใช้เมื่อจังหวัดที่จดทะเบียนต่างจากจังหวัดเจ้าของรถ"],
    ["ค่าธรรมเนียมอื่นๆ (ขอใช้จังหวัดอื่น)", 20, "เพิ่มเฉพาะกรณีขอใช้จังหวัดอื่น"],
    ["ค่าตรวจสภาพรถ (จยย.)", 100, null],
    ["ค่าแผ่นป้ายทะเบียน", 100, null],
    ["ค่าใบคู่มือจดทะเบียน", 100, null],
    ["ค่าภาษีรถจักรยานยนต์", 100, null],
  ]);

  await seedParamTable("feeMotorcycleNoBillParam", [
    ["ค่าอากร (ปกติ)", 10, null],
    ["ค่าอากร (ทำเพิ่มเติมเกิน 1 รายการ)", 30, null],
    ["ลงขัน - รย.12 ทุกประเภท (CC)", 40, "ข้อมูลต้นทางระบุ 40 บาทเท่ากันทุกช่วง CC"],
    ["ลงขันด่วนเพิ่ม (ต่อคัน)", 50, null],
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

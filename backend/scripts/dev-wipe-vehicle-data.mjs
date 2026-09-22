// สคริปต์ dev: ล้างข้อมูลรถทั้งหมด (รถ + ข้อมูลลูกโซ่ทุกขั้นตอน) เพื่อเริ่มใช้งานจริง โดยเก็บลูกค้า ยี่ห้อ
// ตารางค่าธรรมเนียม/ภาษี ตารางค่าดำเนินการต่อลูกค้า (ServiceFeeRate) และผู้ใช้ไว้
// ก่อนลบจะสำรองทุกแถวที่ถูกลบเป็น JSON และย้ายไฟล์รูปออกไปไว้ที่ uploads/<backupDir>/ (โฟลเดอร์ uploads ไม่ขึ้น git)
// ใช้: node --env-file=.env scripts/dev-wipe-vehicle-data.mjs <backupDir>   เช่น backup-2
import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const backupDir = process.argv[2];
if (!backupDir) {
  console.error('ระบุชื่อโฟลเดอร์สำรอง เช่น backup-2');
  process.exit(1);
}
const backupRoot = path.resolve('uploads', backupDir);
if (fs.existsSync(backupRoot)) {
  console.error(`มีโฟลเดอร์ ${backupRoot} อยู่แล้ว - ใช้ชื่ออื่น`);
  process.exit(1);
}
const storageRoot = path.resolve(process.env.RECEIPT_STORAGE_DIR ?? 'uploads/receipts');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

// 1) สำรองทุกแถวที่จะถูกลบ
const backup = {
  backedUpAt: new Date().toISOString(),
  vehicles: await prisma.vehicle.findMany(),
  vehicleEditLogs: await prisma.vehicleEditLog.findMany(),
  cases: await prisma.case.findMany({ include: { documents: true, transferDetail: true, plateSwapDetail: true, addressChangeDetail: true } }).catch(() => prisma.case.findMany()),
  taxCalculations: await prisma.taxCalculation.findMany(),
  documentSubmissions: await prisma.documentSubmission.findMany(),
  receiptImages: await prisma.receiptImage.findMany(),
  platePhotos: await prisma.platePhoto.findMany(),
  bookPhotos: await prisma.bookPhoto.findMany(),
  vehicleOwners: await prisma.vehicleOwner.findMany(),
  invoices: await prisma.invoice.findMany(),
  invoiceLines: await prisma.invoiceLine.findMany(),
};
fs.mkdirSync(backupRoot, { recursive: true });
fs.writeFileSync(path.join(backupRoot, 'db-backup.json'), JSON.stringify(backup, null, 2));

// 2) ย้ายไฟล์รูป (ใบเสร็จ/ป้าย/เล่ม) ที่อ้างถึงในฐานข้อมูลไปไว้ในโฟลเดอร์สำรอง
const keys = [...backup.receiptImages, ...backup.platePhotos, ...backup.bookPhotos].map((r) => r.storageKey);
let moved = 0;
for (const key of keys) {
  const src = path.join(storageRoot, key);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(backupRoot, 'files', key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  moved += 1;
}

// 3) ลบตามลำดับ FK (InvoiceLine -> Vehicle เป็น Restrict จึงต้องลบบิลก่อน; ที่เหลือ Cascade/SetNull จาก Vehicle)
const deleted = await prisma.$transaction(async (tx) => ({
  invoiceLine: (await tx.invoiceLine.deleteMany()).count,
  invoice: (await tx.invoice.deleteMany()).count,
  case: (await tx.case.deleteMany()).count,
  receiptImage: (await tx.receiptImage.deleteMany()).count,
  vehicle: (await tx.vehicle.deleteMany()).count, // cascade: VehicleEditLog, TaxCalculation, DocumentSubmission
  platePhoto: (await tx.platePhoto.deleteMany()).count,
  bookPhoto: (await tx.bookPhoto.deleteMany()).count,
  vehicleOwner: (await tx.vehicleOwner.deleteMany()).count,
}));

const summary = {
  backedUp: Object.fromEntries(Object.entries(backup).filter(([k]) => k !== 'backedUpAt').map(([k, v]) => [k, v.length])),
  deleted,
  filesMoved: moved,
  kept: { customer: await prisma.customer.count(), brand: await prisma.brand.count(), serviceFeeRate: await prisma.serviceFeeRate.count() },
};
fs.writeFileSync(
  path.join(backupRoot, 'README.txt'),
  `${backupDir} - สำรองไว้ ${new Date().toLocaleDateString('th-TH')} ก่อนล้างข้อมูลรถทั้งหมดเพื่อเริ่มใช้งานจริง\n\n` +
    `db-backup.json  ทุกแถวที่ถูกลบจากฐานข้อมูล Neon\n` +
    `files/          รูปใบเสร็จ/ป้าย/เล่มที่อ้างถึงในฐานข้อมูลตอนล้าง (${moved} ไฟล์)\n\n` +
    `ลูกค้า ยี่ห้อ ตารางค่าธรรมเนียม/ภาษี และ ServiceFeeRate ไม่ได้ลบ จึงไม่อยู่ในไฟล์นี้\n\n` +
    JSON.stringify(summary, null, 2) + '\n',
);
console.log(JSON.stringify(summary, null, 2));
await prisma.$disconnect();

// One-off: SPI price table = DLT receipt + a fixed service fee per model (user 2026-11-17).
// The small-car rows were all-in prices (2,060 / 2,400 / 2,598 / 3,052 / 5,715), which is only right for an individual
// owner with no extra item; juristic owners (double tax) and ขอใช้จังหวัดอื่น (+25 on the receipt) came out wrong.
// Also adds the rows that were missing (Alphard, chassis MR02A8 / MR03A8, Commuter, เสริมแหนบ).
//
// From the backend folder:
//   node scripts/set-spi-rates.mjs                      dry run: reads production (read-only user), changes nothing
//   node scripts/set-spi-rates.mjs --apply-production   writes the table on production in one transaction
//
// Safety: it refuses to write unless the SPI table on production is exactly the 14 rows this script was written
// against, so a table somebody edited in the meantime is never overwritten. Existing rows keep their id.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const APPLY = process.argv.includes('--apply-production');
const CUSTOMER = 'SPI';

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Only the two lines this script needs are read from .env, so the other secrets never enter the process.
function envUrls() {
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8');
  const clean = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  let readOnly = '';
  const owners = [];
  for (const line of text.split(/\r?\n/)) {
    const ro = line.match(/^\s*PROD_READONLY_DATABASE_URL\s*=\s*(.*)$/);
    if (ro) readOnly = clean(ro[1]);
    const db = line.match(/^\s*#?\s*DATABASE_URL\s*=\s*(.*)$/); // active or commented-out
    if (db) owners.push(clean(db[1]));
  }
  return { readOnly, owners };
}

const host = (url) => new URL(url).hostname.replace('-pooler', '');
const { readOnly, owners } = envUrls();
if (!readOnly) fail('ยังไม่ได้ตั้ง PROD_READONLY_DATABASE_URL ใน backend/.env');
// Production = the DATABASE_URL line (it is the commented-out one) on the same host as the read-only production URL.
const writeUrl = process.env.SPI_RATES_DATABASE_URL || owners.find((u) => host(u) === host(readOnly));
if (APPLY && !writeUrl) fail('ไม่พบ DATABASE_URL ของ production ใน backend/.env (บรรทัดที่ host เดียวกับ PROD_READONLY_DATABASE_URL)');
if (APPLY && host(writeUrl) !== host(readOnly)) fail('ฐานข้อมูลที่จะเขียนไม่ใช่ production - ไม่ทำต่อ');

// --- the table ---------------------------------------------------------------------------------------------
const row = (ccMin, ccMax, chassisPrefix, bodyPrefix, amount, includesReceipt, kind = 'BASE') => ({
  ccMin, ccMax, chassisPrefix, bodyPrefix, amount, includesReceipt, kind,
  vehicleKind: kind === 'URGENT' ? 'ANY' : 'CAR',
});
// What production must look like before the change (rows by sortOrder).
const BEFORE = [
  row(1400, 1600, 'MR2B78', null, 2400, true),
  row(1400, 1600, 'MR2A78', null, 2598, true),
  row(1400, 1600, 'MHFAB1', null, 2598, true),
  row(1100, 1300, null, null, 2060, true),
  row(2300, 2450, null, null, 655, false),
  row(2650, 2750, null, null, 655, false),
  row(2700, 2800, 'MR0YA3', null, 655, false),
  row(2700, 2800, 'MR04A8', null, 655, false),
  row(2700, 2800, 'MR05A3', null, 655, false),
  row(1700, 1900, null, null, 3052, true),
  row(null, null, 'JTMADD', null, 685, false),
  row(null, null, null, null, 100, false, 'URGENT'),
  row(2450, 2550, null, null, 5715, true),
  row(2700, 2800, 'MR01A8', null, 655, false),
];
// After: same order, all-in rows become "receipt + fee", five rows added at the end.
const AFTER = [
  row(1400, 1600, 'MR2B78', null, 401, false), // 2NR เก๋ง 2 ตอน (was all-in 2,400)
  row(1400, 1600, 'MR2A78', null, 599, false), // 2NR นั่ง 2 ตอน (was 2,598)
  row(1400, 1600, 'MHFAB1', null, 599, false), // 2NR นั่ง 3 ตอน (was 2,598)
  row(1100, 1300, null, null, 509.5, false), // 3NR (was 2,060)
  BEFORE[4], BEFORE[5], BEFORE[6], BEFORE[7], BEFORE[8],
  row(1700, 1900, null, null, 600, false), // 2ZR Corolla Cross (was 3,052)
  BEFORE[10], BEFORE[11],
  row(2450, 2550, 'MR2AB3', null, 512, false), // A25 Camry (was 5,715, any chassis)
  BEFORE[13],
  row(2450, 2550, 'JTNAEA', null, 599, false), // Alphard (SPI list 5,830)
  row(2700, 2800, 'MR02A8', null, 655, false), // 1GD รย.3
  row(2700, 2800, 'MR03A8', null, 655, false), // 1GD นั่ง 2 ตอน
  row(2700, 2800, 'JTFXB3', null, 1505, false), // Commuter รย.2 (SPI list 4,060)
  row(2300, 2450, null, 'รย.3-กระบะบรรทุกมีหลังคาแหนบ', 680, false), // เสริมแหนบ +25
];

const num = (v) => (v === null || v === undefined ? null : Number(v));
const same = (a, b) =>
  num(a.ccMin) === num(b.ccMin) && num(a.ccMax) === num(b.ccMax) && (a.chassisPrefix ?? null) === (b.chassisPrefix ?? null) &&
  (a.bodyPrefix ?? null) === (b.bodyPrefix ?? null) && num(a.amount) === num(b.amount) && a.includesReceipt === b.includesReceipt &&
  a.kind === b.kind && a.vehicleKind === b.vehicleKind && !a.registrationProvince && !a.vatInclusive;
const show = (r) =>
  `${r.kind === 'BASE' ? 'ราคาหลัก' : r.kind} CC ${r.ccMin ?? '-'}-${r.ccMax ?? '-'} ตัวถัง ${r.chassisPrefix ?? '-'} ${r.bodyPrefix ?? ''} = ${num(r.amount)}${r.includesReceipt ? ' (รวมใบเสร็จ)' : ''}`;

// Same matching rule as suggestRate in src/billing/billing-calculator.ts (specific rows first, then sortOrder).
function suggest(rates, v) {
  const spec = (r) => (r.registrationProvince ? 2 : 0) + (r.bodyPrefix ? 1 : 0);
  const sorted = rates.map((r, i) => ({ ...r, i })).sort((a, b) => spec(b) - spec(a) || a.i - b.i);
  for (const r of sorted) {
    if (r.kind !== 'BASE') continue;
    if (r.bodyPrefix && !(v.body ?? '').startsWith(r.bodyPrefix)) continue;
    if (r.ccMin !== null || r.ccMax !== null) {
      if (v.cc === null) continue;
      if (r.ccMin !== null && v.cc < num(r.ccMin)) continue;
      if (r.ccMax !== null && v.cc >= num(r.ccMax)) continue;
    }
    if (r.chassisPrefix && !v.chassis.toUpperCase().startsWith(r.chassisPrefix)) continue;
    return r;
  }
  return null;
}
const total = (r, receipt) => (r ? (r.includesReceipt ? num(r.amount) : receipt + num(r.amount)) : null);

// --- run ---------------------------------------------------------------------------------------------------
const client = new pg.Client({ connectionString: APPLY ? writeUrl : readOnly });
await client.connect();
try {
  await client.query(APPLY ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY');
  const cust = await client.query('select id, name from "Customer" where name = $1', [CUSTOMER]);
  if (cust.rows.length !== 1) throw new Error(`หาลูกค้า ${CUSTOMER} ไม่เจอ หรือเจอมากกว่า 1 ราย (${cust.rows.length})`);
  const customerId = cust.rows[0].id;
  const current = (
    await client.query(
      `select id, "vehicleKind", "ccMin", "ccMax", "chassisPrefix", "bodyPrefix", "registrationProvince", amount, "vatInclusive", "includesReceipt", kind, "sortOrder"
       from "ServiceFeeRate" where "customerId" = $1 order by "sortOrder" ${APPLY ? 'for update' : ''}`,
      [customerId],
    )
  ).rows;

  const alreadyDone = current.length === AFTER.length && current.every((r, i) => same(r, AFTER[i]));
  if (alreadyDone) {
    console.log('ตารางราคา SPI เป็นชุดใหม่อยู่แล้ว ไม่ต้องทำอะไร');
  } else {
    const untouched = current.length === BEFORE.length && current.every((r, i) => same(r, BEFORE[i]));
    if (!untouched) {
      console.log('ตารางราคา SPI ตอนนี้:');
      current.forEach((r, i) => console.log(`  ${i}. ${show(r)}`));
      throw new Error('ตารางราคา SPI บน production ไม่ตรงกับ 14 แถวที่สคริปต์นี้รู้จัก (มีคนแก้ไปแล้ว) - ไม่เขียนทับ');
    }

    console.log(`${APPLY ? 'กำลังแก้' : 'ทดลอง (ยังไม่แก้จริง)'} ตารางราคา ${CUSTOMER} บน production:`);
    AFTER.forEach((r, i) => {
      const old = BEFORE[i];
      console.log(`  ${String(i).padStart(2)}. ${!old ? 'เพิ่ม  ' : same(old, r) ? 'เดิม  ' : 'แก้   '} ${show(r)}${old && !same(old, r) ? `   <- เดิม ${num(old.amount)}${old.includesReceipt ? ' (รวมใบเสร็จ)' : ''}` : ''}`);
    });

    // Effect on the cars that are not billed yet.
    const cars = (
      await client.query(
        `select v.chassis, v.body, v.cc, coalesce(v."plateCategory",'')||' '||coalesce(v."plateNumber",'') as plate, s."receiptAmount" as receipt
         from "Vehicle" v
         join lateral (select * from "DocumentSubmission" d where d."vehicleId" = v.id order by d."createdAt" desc limit 1) s on true
         where v."customerId" = $1 and v."deletedAt" is null and s."receiptAmount" is not null and v."billingClosedAt" is null
           and not exists (select 1 from "InvoiceLine" l join "Invoice" i on i.id = l."invoiceId" where l."vehicleId" = v.id and i.status <> 'VOID')
         order by v."plateNumber"`,
        [customerId],
      )
    ).rows;
    let changed = 0;
    console.log(`\nรถที่ยังไม่ได้วางบิล ${cars.length} คัน - คันที่ราคาเปลี่ยน:`);
    for (const c of cars) {
      const v = { chassis: c.chassis, body: c.body, cc: num(c.cc) };
      const before = total(suggest(BEFORE, v), num(c.receipt));
      const after = total(suggest(AFTER, v), num(c.receipt));
      if (before === after) continue;
      changed += 1;
      console.log(`  ${c.plate.padEnd(10)} ${c.chassis.slice(0, 6)} ใบเสร็จ ${num(c.receipt)}: ${before ?? 'ไม่มีราคา'} -> ${after ?? 'ไม่มีราคา'}`);
    }
    console.log(`  รวมเปลี่ยน ${changed} คัน ที่เหลือราคาเท่าเดิม (ไม่รวมค่าด่วน / หักค่าขอใช้เลข ซึ่งคิดตอนวางบิลเหมือนเดิม)`);

    if (APPLY) {
      for (let i = 0; i < AFTER.length; i += 1) {
        const r = AFTER[i];
        if (i < current.length) {
          if (same(current[i], r)) continue;
          await client.query(
            `update "ServiceFeeRate" set "ccMin" = $2, "ccMax" = $3, "chassisPrefix" = $4, "bodyPrefix" = $5, amount = $6, "includesReceipt" = $7, "updatedAt" = now()
             where id = $1 and "customerId" = $8`,
            [current[i].id, r.ccMin, r.ccMax, r.chassisPrefix, r.bodyPrefix, r.amount, r.includesReceipt, customerId],
          );
        } else {
          await client.query(
            `insert into "ServiceFeeRate" (id, "customerId", label, "vehicleKind", "ccMin", "ccMax", "chassisPrefix", "bodyPrefix", amount, "vatInclusive", "includesReceipt", kind, "sortOrder", "createdAt", "updatedAt")
             values ($1, $2, '', $3, $4, $5, $6, $7, $8, false, $9, $10, $11, now(), now())`,
            [`c${randomBytes(12).toString('hex')}`, customerId, r.vehicleKind, r.ccMin, r.ccMax, r.chassisPrefix, r.bodyPrefix, r.amount, r.includesReceipt, r.kind, i],
          );
        }
      }
      const saved = (
        await client.query(
          `select "vehicleKind", "ccMin", "ccMax", "chassisPrefix", "bodyPrefix", "registrationProvince", amount, "vatInclusive", "includesReceipt", kind
           from "ServiceFeeRate" where "customerId" = $1 order by "sortOrder"`,
          [customerId],
        )
      ).rows;
      if (saved.length !== AFTER.length || !saved.every((r, i) => same(r, AFTER[i]))) throw new Error('ตรวจหลังบันทึกแล้วไม่ตรง - ยกเลิกทั้งหมด');
      await client.query('COMMIT');
      console.log(`\nบันทึกแล้ว: ตารางราคา ${CUSTOMER} มี ${saved.length} แถว`);
    } else {
      console.log('\nยังไม่ได้แก้อะไร - ถ้าถูกต้องให้รัน: node scripts/set-spi-rates.mjs --apply-production');
    }
  }
} catch (error) {
  console.error(`ผิดพลาด: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end().catch(() => {});
}

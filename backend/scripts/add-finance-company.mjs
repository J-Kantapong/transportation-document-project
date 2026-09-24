// เพิ่มบริษัทไฟแนนซ์ลงตาราง FinanceCompany (ข้ามชื่อที่มีอยู่แล้ว ไม่แก้/ลบของเดิม)
// ใช้:
//   node scripts/add-finance-company.mjs --target=prod "บริษัท ก จำกัด" "ธนาคาร ข จำกัด (มหาชน)"
//   node scripts/add-finance-company.mjs --target=dev  "..."
//   ไม่ใส่ --apply = ดูอย่างเดียว (dry run); ใส่ --apply เพื่อเขียนจริง
// target=dev  ใช้บรรทัด DATABASE_URL= ที่เปิดอยู่ใน backend/.env
// target=prod ใช้บรรทัด #DATABASE_URL= ที่ comment ไว้ (ep-odd-sun) ใน backend/.env
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const args = process.argv.slice(2);
const target = args.find((a) => a.startsWith('--target='))?.split('=')[1];
const apply = args.includes('--apply');
const names = [...new Set(args.filter((a) => !a.startsWith('--')).map((n) => n.trim().replace(/\s+/g, ' ')).filter(Boolean))];

if (!['prod', 'dev'].includes(target) || names.length === 0) {
  console.error('usage: node scripts/add-finance-company.mjs --target=prod|dev [--apply] "ชื่อบริษัท" ...');
  process.exit(1);
}

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/);
const prefix = target === 'prod' ? '#DATABASE_URL=' : 'DATABASE_URL=';
const url = env.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();
if (!url) throw new Error(`ไม่พบบรรทัด ${prefix} ใน backend/.env`);
if (target === 'prod' && !url.includes('ep-odd-sun')) throw new Error('prod URL ไม่ใช่ ep-odd-sun ตรวจ .env ก่อน');

const client = new pg.Client({ connectionString: url });
await client.connect();
const host = new URL(url).host.split('.')[0];
console.log(`target=${target} (${host}) ${apply ? 'APPLY' : 'DRY RUN'}`);

// เทียบแบบตัดช่องว่างทั้งหมด กันชื่อซ้ำที่ต่างกันแค่เว้นวรรค
const squash = (s) => s.replace(/\s+/g, '');
const { rows: existing } = await client.query('SELECT name FROM "FinanceCompany"');
const byKey = new Map(existing.map((r) => [squash(r.name), r.name]));

for (const name of names) {
  const dup = byKey.get(squash(name));
  if (dup) {
    console.log(`skip (มีแล้ว): ${dup}`);
    continue;
  }
  if (apply) {
    const id = 'c' + randomBytes(12).toString('hex');
    await client.query('INSERT INTO "FinanceCompany" (id, name, "sortOrder", "createdAt") VALUES ($1, $2, 1000, now())', [id, name]);
    console.log(`added: ${name}`);
  } else {
    console.log(`would add: ${name}`);
  }
  byKey.set(squash(name), name);
}

const { rows } = await client.query('SELECT name FROM "FinanceCompany" ORDER BY "sortOrder", name');
console.log(`\nFinanceCompany ทั้งหมด ${rows.length} รายการ:`);
for (const r of rows) console.log(' - ' + r.name);
await client.end();

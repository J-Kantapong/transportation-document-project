// Read-only queries against production, for Claude Code.
// Uses ONLY PROD_READONLY_DATABASE_URL from backend/.env (never DATABASE_URL) and refuses any
// database user other than claude_readonly. The role itself has SELECT only; the READ ONLY
// transaction below is a second guard.
//
// Usage (from the repo root):
//   node backend/scripts/prod-read.mjs "select count(*) from \"Vehicle\""
//   node backend/scripts/prod-read.mjs --file path/to/query.sql
//   node backend/scripts/prod-read.mjs --max 2000 --file query.sql     (default 500 rows printed)
//   ... or pipe the SQL on stdin.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ENV_NAME = 'PROD_READONLY_DATABASE_URL';
const REQUIRED_USER = 'claude_readonly';

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Read just this one variable, so the other secrets in .env never enter this process.
function readUrl() {
  if (process.env[ENV_NAME]) return process.env[ENV_NAME];
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    fail(`ไม่พบ ${envPath}`);
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${ENV_NAME}\\s*=\\s*(.*)$`));
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}

function readArgs() {
  const args = process.argv.slice(2);
  let max = 500;
  let sql = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--file') sql = readFileSync(args[(i += 1)], 'utf8');
    else if (args[i] === '--max') max = Number(args[(i += 1)]);
    else sql = args[i];
  }
  if (!sql && !process.stdin.isTTY) sql = readFileSync(0, 'utf8');
  if (!Number.isInteger(max) || max < 1) fail('--max ต้องเป็นจำนวนเต็มบวก');
  return { sql: sql.trim(), max };
}

const url = readUrl();
if (!url) fail(`ยังไม่ได้ตั้ง ${ENV_NAME} ใน backend/.env`);

let user;
try {
  user = decodeURIComponent(new URL(url).username);
} catch {
  fail(`${ENV_NAME} ไม่ใช่ URL ที่ถูกต้อง`);
}
if (user !== REQUIRED_USER) {
  fail(`${ENV_NAME} ต้องเป็นผู้ใช้ ${REQUIRED_USER} เท่านั้น (ตอนนี้เป็นผู้ใช้อื่น) - ไม่เชื่อมต่อ`);
}

const { sql, max } = readArgs();
if (!sql) fail('ไม่มีคำสั่ง SQL');

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query('BEGIN TRANSACTION READ ONLY');
  await client.query("SET LOCAL statement_timeout = '30s'");
  const result = await client.query(sql);
  const rows = result.rows ?? [];
  console.log(JSON.stringify(rows.slice(0, max), null, 1));
  if (rows.length > max) console.log(`... แสดง ${max} จาก ${rows.length} แถว (เพิ่ม --max เพื่อดูทั้งหมด)`);
  else console.log(`${rows.length} แถว`);
} catch (error) {
  console.error(`ผิดพลาด: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end().catch(() => {});
}

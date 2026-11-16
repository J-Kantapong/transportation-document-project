// บัญชีทดสอบของ Claude Code บนฐานข้อมูล dev เท่านั้น (ผู้ใช้ 2026-11-16: ไม่ต้องให้ผู้ใช้ login ให้ทุกครั้งที่ทดสอบบน localhost)
// - สร้างบัญชี ADMIN claude-test@local.test ด้วยรหัสผ่านสุ่ม แล้วเก็บไว้ใน backend/.env.claude-test (gitignore: .env.*)
// - ปฏิเสธถ้า DATABASE_URL ใน backend/.env ไม่ใช่ฐานข้อมูล dev (ep-purple-night) - ห้ามมีบัญชีนี้บน production
// - ไม่พิมพ์รหัสผ่านออกจอ · รันซ้ำ = ไม่ทำอะไร (มีไฟล์แล้ว) · --reset = สุ่มรหัสใหม่แล้วตั้งให้บัญชีเดิม
//
// ใช้ (จากรากโปรเจกต์):  node backend/scripts/dev-claude-test-account.mjs [--reset]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_HOST_MARK = 'ep-purple-night';
const EMAIL = 'claude-test@local.test';
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const credsPath = join(backendDir, '.env.claude-test');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// อ่านเฉพาะ DATABASE_URL ที่ใช้งานอยู่ (บรรทัดที่ไม่ถูก comment) เพื่อตรวจว่าเป็น dev
let envText;
try {
  envText = readFileSync(join(backendDir, '.env'), 'utf8');
} catch {
  fail('ไม่พบ backend/.env');
}
const dbLine = envText.split(/\r?\n/).find((line) => /^\s*DATABASE_URL\s*=/.test(line));
if (!dbLine || !dbLine.includes(DEV_HOST_MARK)) {
  fail(`DATABASE_URL ใน backend/.env ไม่ใช่ฐานข้อมูล dev (${DEV_HOST_MARK}) - ไม่สร้างบัญชีทดสอบ`);
}

const reset = process.argv.includes('--reset');
if (existsSync(credsPath) && !reset) {
  console.log(`มีบัญชีทดสอบอยู่แล้ว (${EMAIL}) - รหัสผ่านอยู่ใน backend/.env.claude-test`);
  process.exit(0);
}

const password = randomBytes(18).toString('base64url');
const result = spawnSync('npx', ['tsx', 'scripts/seed-admin.ts'], {
  cwd: backendDir,
  shell: true,
  stdio: 'inherit',
  env: { ...process.env, ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: password, ADMIN_NAME: 'Claude (ทดสอบ)' },
});
if (result.status !== 0) fail('สร้างบัญชีทดสอบไม่สำเร็จ - ไม่ได้เขียนไฟล์รหัสผ่าน');

writeFileSync(
  credsPath,
  ['# บัญชีทดสอบของ Claude Code บนฐานข้อมูล dev เท่านั้น - ห้าม commit (gitignore: .env.*)', `CLAUDE_TEST_EMAIL=${EMAIL}`, `CLAUDE_TEST_PASSWORD=${password}`, ''].join('\n'),
  'utf8',
);
console.log('เขียน backend/.env.claude-test แล้ว');

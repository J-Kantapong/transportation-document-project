// ตรวจว่า .env ตั้งค่า R2 ถูก: อัปโหลดไฟล์ทดสอบ อ่านกลับ แล้วลบทิ้ง
// วิธีใช้: cd backend && node scripts/check-r2.mjs                  (อ่าน backend/.env)
//        cd backend && node scripts/check-r2.mjs .env.production  (ตรวจ bucket ของ production ก่อนใส่ใน Render)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const envName = process.argv[2] ?? '.env';
const envFile = process.argv[2] ? path.resolve(process.argv[2]) : new URL('../.env', import.meta.url);
console.log(`อ่านค่าจาก ${envName}`);
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missing = need.filter((k) => !process.env[k]?.trim());
if (missing.length) {
  console.error(`ยังไม่ได้ตั้งค่าใน ${envName}: ${missing.join(', ')}`);
  process.exit(1);
}

const bucket = process.env.R2_BUCKET.trim();
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(), secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim() },
});

const prefix = (process.env.R2_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '');
const key = `${prefix ? `${prefix}/` : ''}_check/${Date.now()}.txt`;
const body = `r2 check ${new Date().toISOString()}`;
try {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain' }));
  console.log(`อัปโหลด ${key} สำเร็จ`);
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const back = await res.Body.transformToString();
  if (back !== body) throw new Error('อ่านกลับมาได้ข้อมูลไม่ตรง');
  console.log('อ่านกลับสำเร็จ');
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  console.log('ลบไฟล์ทดสอบสำเร็จ');
  console.log(`\nR2 bucket "${bucket}" พร้อมใช้งาน - รีสตาร์ท backend แล้วรูปใหม่จะเก็บบน R2`);
} catch (err) {
  console.error('\nเชื่อมต่อ R2 ไม่สำเร็จ:', err?.name ?? '', err?.message ?? err);
  if (err?.name === 'InvalidAccessKeyId' || err?.name === 'SignatureDoesNotMatch') console.error('→ ตรวจ R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY');
  if (err?.name === 'NoSuchBucket') console.error('→ ตรวจ R2_BUCKET ให้ตรงกับชื่อ bucket ที่สร้าง');
  if (err?.name === 'AccessDenied') console.error('→ token ต้องมีสิทธิ์ Object Read & Write บน bucket นี้');
  process.exit(1);
}

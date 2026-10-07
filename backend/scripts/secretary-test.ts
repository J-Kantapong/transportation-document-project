// ส่งข้อความทดสอบเข้าไลน์ส่วนตัว เพื่อเช็กว่าบอทเลขาตั้งค่าถูก (ผู้ใช้ 2026-10-07)
// ต้องมี LINE_CHANNEL_ACCESS_TOKEN + LINE_USER_ID ใน backend/.env แล้วรัน: npm run secretary:test
import 'dotenv/config';
import process from 'node:process';
import { LineConfigError, pushLineText } from '../src/secretary/line-client.js';

try {
  await pushLineText('ทดสอบจากเลขา: ระบบส่งข้อความเข้าไลน์ได้แล้ว');
  console.log('ส่งแล้ว - เปิดไลน์ดูข้อความจากบอทได้เลย');
} catch (error) {
  if (error instanceof LineConfigError) {
    console.error(error.message);
  } else {
    console.error('ส่งไม่สำเร็จ:', error instanceof Error ? error.message : error);
  }
  process.exit(1);
}

// ลองถามเลขา AI จากเครื่อง (ผู้ใช้ 2026-11-20 รอบ 1) - ไม่ส่งอะไรเข้าไลน์ พิมพ์คำตอบในหน้าจอ เสียค่า AI จริงตามจำนวน token
//   npm run secretary:ask -- "SPI ค้างจ่ายเท่าไหร่"
//   npm run secretary:ask -- "คำถามแรก" "คำถามต่อเนื่อง"   (ถามต่อกันในบทสนทนาเดียว)
// ใช้ฐานข้อมูลตาม DATABASE_URL ใน backend/.env และต้องมี ANTHROPIC_API_KEY
// ไม่ใช้ Nest DI เพราะ tsx ไม่ส่ง decorator metadata - ประกอบ service เองเหมือนที่ Nest ทำ
import 'dotenv/config';
import process from 'node:process';
import { OverviewService } from '../src/overview/overview.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AiChatService } from '../src/secretary/ai-chat.service.js';
import { splitReply } from '../src/secretary/ai-chat.js';
import { LookupService } from '../src/secretary/lookup.service.js';
import { NotesService } from '../src/secretary/notes.service.js';
import { SecretaryService } from '../src/secretary/secretary.service.js';
import { StatementService } from '../src/secretary/statement.service.js';
import { VehicleSearchService } from '../src/vehicle-search/vehicle-search.service.js';

const questions = process.argv.slice(2).filter((q) => q.trim());
if (questions.length === 0) {
  console.error('ใช้: npm run secretary:ask -- "คำถาม"');
  process.exit(1);
}

const prisma = new PrismaService();
let failed = false;
try {
  await prisma.$connect();
  const overview = new OverviewService(prisma);
  // คำสั่งลิงก์เอกสารใช้แค่ฐานข้อมูล ไม่ต้องมีตัวออกใบกำกับ/วางบิลจริง
  const statements = new StatementService(prisma, undefined as never, undefined as never);
  const ai = new AiChatService(new VehicleSearchService(prisma));
  const secretary = new SecretaryService(overview, prisma, new NotesService(prisma), statements, new LookupService(prisma, overview, statements), ai);
  for (const question of questions) {
    const started = Date.now();
    const answer = await ai.ask(question, (command) => {
      console.log(`  [เครื่องมือ] ${command}`);
      return secretary.readOnlyCommand(command);
    });
    console.log(`\nถาม: ${question}\n---`);
    for (const part of splitReply(answer.text)) console.log(part);
    const u = answer.usage;
    console.log(`--- ${((Date.now() - started) / 1000).toFixed(1)} วินาที · ${u.rounds} รอบ · input ${u.inputTokens} · cached ${u.cachedTokens} · output ${u.outputTokens}\n`);
  }
} catch (error) {
  failed = true;
  console.error('ถามไม่สำเร็จ:', error instanceof Error ? error.message : error);
} finally {
  await prisma.$disconnect();
}
process.exit(failed ? 1 : 0);

// เทียบ AI อ่านรูปป้ายทะเบียน (Sonnet 5 กับ Haiku 4.5) - ความถูกต้องและ token ที่ใช้จริงต่อรูป
// รัน: npx tsx scripts/plate-bench.ts <รูป>... (ยิง API จริง เสียเงินเล็กน้อย ต้องมี ANTHROPIC_API_KEY ใน backend/.env)
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { PLATE_READING_PROMPT, PlateReadingSchema } from '../src/plate-photos/plate-reading.js';

process.loadEnvFile?.('.env');
const THB_PER_USD = 35;
// ราคาต่อ 1 ล้าน token (USD)
const MODELS = [
  { id: 'claude-sonnet-5', input: 2, output: 10, effort: true },
  { id: 'claude-haiku-4-5', input: 1, output: 5, effort: false }, // Haiku 4.5 ไม่รับ effort
] as const;

const MIME: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const client = new Anthropic();

for (const file of process.argv.slice(2)) {
  const data = fs.readFileSync(file).toString('base64');
  const mediaType = MIME[path.extname(file).toLowerCase()];
  for (const m of MODELS) {
    const started = Date.now();
    const res = await client.messages.parse({
      model: m.id,
      max_tokens: 4000,
      output_config: { ...(m.effort ? { effort: 'medium' as const } : {}), format: zodOutputFormat(PlateReadingSchema) },
      system: [{ type: 'text', text: PLATE_READING_PROMPT }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: 'อ่านป้ายทะเบียนทุกแผ่นในรูปนี้' },
          ],
        },
      ],
    });
    const u = res.usage;
    const usd = (u.input_tokens * m.input + u.output_tokens * m.output) / 1e6;
    const plates = res.parsed_output?.plates.map((p) => `${p.category} ${p.number} ${p.province ?? ''} [${p.plateType}${p.uncertain ? ' ?' : ''}]`).join(' | ');
    console.log(
      `${path.basename(file)} · ${m.id} · in ${u.input_tokens} out ${u.output_tokens} · ${(usd * THB_PER_USD).toFixed(3)} บาท · ${((Date.now() - started) / 1000).toFixed(1)}s · ${plates ?? res.stop_reason}`,
    );
  }
}

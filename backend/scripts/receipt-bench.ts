// เทียบวิธีอ่านใบเสร็จหลายแบบด้วย Sonnet 5 กับรูปจริง เพื่อหาแบบที่ถูกที่สุดที่ยังอ่านถูกเท่าเดิม
// รัน: npx tsx scripts/receipt-bench.ts          -> บอกแผนกับค่าใช้จ่ายโดยประมาณ ไม่ยิง API ไม่เสียเงิน
//      npx tsx scripts/receipt-bench.ts --run    -> ยิงจริง (เสียเงิน) ต้องมี ANTHROPIC_API_KEY ใน backend/.env
// ตัวเลือก: --limit N (ใช้รูปแค่ N ใบ) --variants low,low-1000 --images <โฟลเดอร์>
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { RECEIPT_READING_PROMPT, ReceiptReadingSchema, checkReading, type ReceiptReading } from '../src/receipts/receipt-extraction.js';

const MODEL = 'claude-sonnet-5';
// ราคา Sonnet 5 ต่อ 1 ล้าน token (USD) - cache write 1.25x, cache read 0.1x, Batch API ลดครึ่งทุกช่อง
const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
const THB_PER_USD = 35;
const CONCURRENCY = 4;

interface Variant {
  name: string;
  note: string;
  effort: 'low' | 'medium' | 'high';
  maxEdge: number | null; // null = ใช้รูปตามที่อัปมา
  cachePrompt: boolean; // true = ย้าย prompt ไป system + cache_control
  batch: boolean; // true = ส่งผ่าน Batch API (ลด 50% แต่ไม่ได้ผลทันที)
}

const VARIANTS: Variant[] = [
  { name: 'current', note: 'แบบที่ใช้อยู่ตอนนี้ (effort medium, รูปเต็ม)', effort: 'medium', maxEdge: null, cachePrompt: false, batch: false },
  { name: 'low', note: 'ลด effort เป็น low อย่างเดียว', effort: 'low', maxEdge: null, cachePrompt: false, batch: false },
  { name: 'low-1000', note: 'effort low + ย่อรูปด้านยาวเหลือ 1000px', effort: 'low', maxEdge: 1000, cachePrompt: false, batch: false },
  { name: 'low-800', note: 'effort low + ย่อรูปด้านยาวเหลือ 800px', effort: 'low', maxEdge: 800, cachePrompt: false, batch: false },
  { name: 'medium-1000', note: 'effort medium + ย่อรูปเหลือ 1000px', effort: 'medium', maxEdge: 1000, cachePrompt: false, batch: false },
  { name: 'cached', note: 'effort low + ย้าย prompt ไป system แล้ว cache ไว้', effort: 'low', maxEdge: null, cachePrompt: true, batch: false },
  { name: 'batch-low', note: 'effort low ส่งผ่าน Batch API (ถูกลงครึ่งหนึ่ง แต่ต้องรอ)', effort: 'low', maxEdge: null, cachePrompt: false, batch: true },
];

// ---------- อ่าน .env ของ backend เอง (สคริปต์นี้ไม่ได้ผ่าน Nest) ----------
function loadEnv(): void {
  const file = path.resolve('.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

// ---------- รูป ----------
function findImages(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jpe?g|png|webp)$/i.test(e.name)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

// อ่านความกว้าง/สูงจาก header ของ JPEG - ใช้ประเมิน image token ก่อนยิงจริง (ราคาคิดจากพิกเซล ไม่ใช่ขนาดไฟล์)
function jpegDimensions(buf: Buffer): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const imageTokens = (w: number, h: number, maxEdge: number | null): number => {
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(w, h)) : 1;
  return Math.round((w * scale * (h * scale)) / 750);
};

// sharp ติดมากับ frontend (Next.js) - สคริปต์ทดสอบยืมมาใช้ ไม่ต้องลงเพิ่มใน backend
interface SharpPipeline {
  resize(o: object): SharpPipeline;
  jpeg(o: object): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}
function loadSharp(): ((input: Buffer) => SharpPipeline) | null {
  const req = createRequire(import.meta.url);
  for (const base of ['sharp', path.resolve('../frontend/node_modules/sharp')]) {
    try {
      return req(base) as (input: Buffer) => SharpPipeline;
    } catch {
      /* ลองที่ถัดไป */
    }
  }
  return null;
}

// ---------- ประกอบ request ----------
const imageBlock = (data: Buffer, mimeType: string) =>
  ({ type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType as 'image/jpeg', data: data.toString('base64') } });

function buildParams(v: Variant, image: Buffer, mimeType: string): Record<string, unknown> {
  const format = zodOutputFormat(ReceiptReadingSchema);
  if (v.cachePrompt) {
    // prompt = ส่วนที่ซ้ำทุก request -> ย้ายไป system แล้ว cache; รูปที่เปลี่ยนทุกใบอยู่หลัง breakpoint
    return {
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: v.effort, format },
      system: [{ type: 'text', text: RECEIPT_READING_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [imageBlock(image, mimeType), { type: 'text', text: 'อ่านใบเสร็จใบนี้' }] }],
    };
  }
  return {
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: v.effort, format },
    messages: [{ role: 'user', content: [imageBlock(image, mimeType), { type: 'text', text: RECEIPT_READING_PROMPT }] }],
  };
}

interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const ZERO: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

const readUsage = (u: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): Usage => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
});

function costUsd(u: Usage, batch: boolean): number {
  const full = (u.input * PRICE.input + u.output * PRICE.output + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead) / 1_000_000;
  return batch ? full / 2 : full;
}

interface Row {
  file: string;
  ok: boolean;
  error?: string;
  reading?: ReceiptReading;
  usage: Usage;
  ms: number;
}

interface Img {
  file: string;
  buf: Buffer;
  mime: string;
}

// ---------- ยิงทีละใบ (ทุกแบบยกเว้น batch) ----------
async function runLive(client: Anthropic, v: Variant, images: Img[]): Promise<Row[]> {
  const rows: Row[] = new Array<Row>(images.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= images.length) return;
      const img = images[i];
      const started = Date.now();
      try {
        const res = await client.messages.parse(buildParams(v, img.buf, img.mime) as never);
        const usage = readUsage(res.usage);
        rows[i] =
          res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens' || !res.parsed_output
            ? { file: img.file, ok: false, error: `stop_reason=${res.stop_reason}`, usage, ms: Date.now() - started }
            : { file: img.file, ok: true, reading: res.parsed_output as ReceiptReading, usage, ms: Date.now() - started };
      } catch (err) {
        rows[i] = { file: img.file, ok: false, error: err instanceof Error ? err.message : String(err), usage: ZERO, ms: Date.now() - started };
      }
      process.stdout.write('.');
    }
  };
  // แบบที่ใช้ cache ต้องยิงทีละใบ ไม่งั้นใบแรกๆ วิ่งพร้อมกันแล้วต่างคนต่างเขียน cache แทนที่จะอ่านของกัน
  const lanes = v.cachePrompt ? 1 : Math.min(CONCURRENCY, images.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  return rows;
}

// ---------- ยิงผ่าน Batch API แล้วรอผล (วัดทั้งราคาและเวลารอจริง) ----------
async function runBatch(client: Anthropic, v: Variant, images: Img[]): Promise<Row[]> {
  const started = Date.now();
  const batch = await client.messages.batches.create({
    requests: images.map((img, i) => ({ custom_id: `r${i}`, params: buildParams(v, img.buf, img.mime) as never })),
  });
  process.stdout.write(`\n  ส่ง batch ${batch.id} แล้ว รอผล`);
  for (;;) {
    const state = await client.messages.batches.retrieve(batch.id);
    if (state.processing_status === 'ended') break;
    await new Promise((r) => setTimeout(r, 15_000));
    process.stdout.write('.');
  }
  const ms = Date.now() - started;
  const rows: Row[] = images.map((img) => ({ file: img.file, ok: false, error: 'ไม่มีผลกลับมา', usage: ZERO, ms }));
  for await (const result of await client.messages.batches.results(batch.id)) {
    const i = Number(result.custom_id.slice(1));
    if (result.result.type !== 'succeeded') {
      rows[i] = { ...rows[i], error: result.result.type };
      continue;
    }
    const message = result.result.message;
    const usage = readUsage(message.usage);
    const text = message.content.find((b) => b.type === 'text');
    const parsed = text ? ReceiptReadingSchema.safeParse(JSON.parse(text.text)) : null;
    rows[i] = parsed?.success
      ? { file: images[i].file, ok: true, reading: parsed.data, usage, ms }
      : { file: images[i].file, ok: false, error: 'แปลงผลเป็น JSON ไม่ได้', usage, ms };
  }
  return rows;
}

// ---------- เทียบผลทีละช่อง ----------
const FIELDS = ['receiptNo', 'date', 'plateCategory', 'plateNumber', 'chassis', 'weightKg', 'total', 'items'] as const;
const fieldValue = (r: ReceiptReading, f: string): string =>
  f === 'items' ? JSON.stringify(r.items) : String((r as unknown as Record<string, unknown>)[f] ?? 'null');

function diffAgainstBase(base: Row[], other: Row[]): { file: string; field: string; base: string; other: string }[] {
  const out: { file: string; field: string; base: string; other: string }[] = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i]?.reading;
    const b = other[i]?.reading;
    if (!a || !b) continue;
    for (const f of FIELDS) {
      const va = fieldValue(a, f);
      const vb = fieldValue(b, f);
      if (va !== vb) out.push({ file: path.basename(base[i].file), field: f, base: va, other: vb });
    }
  }
  return out;
}

// ---------- main ----------
async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const doRun = argv.includes('--run');
  const limit = Number(arg('limit') ?? '0');
  const imagesDir = path.resolve(arg('images') ?? 'uploads/backup-1/receipt-files');
  const pick = arg('variants')?.split(',');
  const variants = pick ? VARIANTS.filter((v) => pick.includes(v.name)) : VARIANTS;

  let files = findImages(imagesDir);
  if (limit > 0) files = files.slice(0, limit);
  if (files.length === 0) {
    console.error(`ไม่พบรูปใน ${imagesDir}`);
    process.exit(1);
  }

  const sharp = loadSharp();
  const originals = files.map((file) => {
    const buf = fs.readFileSync(file);
    const lower = file.toLowerCase();
    const mime = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return { file, buf, mime, dim: jpegDimensions(buf) };
  });

  console.log(`\nรูปที่ใช้ทดสอบ: ${files.length} ใบ จาก ${imagesDir}`);
  const dims = originals[0].dim;
  if (dims) console.log(`ขนาดรูปใบแรก: ${dims.w}x${dims.h} = ~${imageTokens(dims.w, dims.h, null)} image tokens`);
  if (!sharp) console.log('! ไม่พบ sharp - แบบที่ต้องย่อรูปจะถูกข้าม');

  // ประเมินคร่าวๆ ก่อนยิงจริง: prompt+schema ~900 token, output เดาที่ low=700 / medium=1100 / high=1800
  let estimate = 0;
  console.log('\nแบบที่จะทดสอบ');
  for (const v of variants) {
    if (v.maxEdge && !sharp) {
      console.log(`  - ${v.name.padEnd(12)} ข้าม (ต้องใช้ sharp)`);
      continue;
    }
    const cost = originals.reduce((sum, o) => {
      const img = o.dim ? imageTokens(o.dim.w, o.dim.h, v.maxEdge) : 2200;
      const out = v.effort === 'low' ? 700 : v.effort === 'medium' ? 1100 : 1800;
      return sum + costUsd({ ...ZERO, input: img + 900, output: out }, v.batch);
    }, 0);
    estimate += cost;
    console.log(`  - ${v.name.padEnd(12)} ${v.note}  ~${(cost * THB_PER_USD).toFixed(2)} บาท`);
  }
  console.log(`\nรวมโดยประมาณ ~${(estimate * THB_PER_USD).toFixed(2)} บาท ($${estimate.toFixed(3)}) - ตัวเลขจริงดูในตารางผล`);

  if (!doRun) {
    console.log('\nยังไม่ได้ยิง API (ไม่เสียเงิน) - ใส่ --run เมื่อพร้อม เช่น');
    console.log('  npx tsx scripts/receipt-bench.ts --limit 5 --run   (ลองน้อยๆ ก่อน)');
    console.log('  npx tsx scripts/receipt-bench.ts --run             (ครบทุกใบ)');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nไม่มี ANTHROPIC_API_KEY ใน backend/.env - ใส่คีย์ก่อน');
    process.exit(1);
  }

  // คีย์ที่ไม่ได้ผูกกับ workspace ต้องส่ง workspace id มาด้วย (ไม่ใช่ความลับ ใส่ใน .env ได้)
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {});
  const results = new Map<string, Row[]>();
  for (const v of variants) {
    if (v.maxEdge && !sharp) continue;
    const images: Img[] = await Promise.all(
      originals.map(async (o) => ({
        file: o.file,
        mime: v.maxEdge ? 'image/jpeg' : o.mime,
        buf:
          v.maxEdge && sharp
            ? await sharp(o.buf).resize({ width: v.maxEdge, height: v.maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
            : o.buf,
      })),
    );
    process.stdout.write(`\n${v.name} `);
    results.set(v.name, v.batch ? await runBatch(client, v, images) : await runLive(client, v, images));
  }

  console.log('\n\n=== สรุปต่อแบบ (เฉลี่ยต่อใบ) ===');
  console.log('แบบ           อ่านได้   input  output  cacheRead  บาท/ใบ  วินาที  ผ่าน checks ครบ');
  const summary: Record<string, number> = {};
  for (const [name, rows] of results) {
    const v = variants.find((x) => x.name === name)!;
    const n = rows.length;
    const okRows = rows.filter((r) => r.ok);
    // เฉลี่ยเฉพาะใบที่อ่านสำเร็จ - ถ้าหารด้วยจำนวนใบทั้งหมด แบบที่อ่านพังบ่อยจะดูถูกกว่าความจริง
    const basis = okRows.length || 1;
    const avg = (f: (r: Row) => number): number => Math.round(okRows.reduce((s, r) => s + f(r), 0) / basis);
    const perImageThb = (okRows.reduce((s, r) => s + costUsd(r.usage, v.batch), 0) / basis) * THB_PER_USD;
    const allChecks = okRows.filter((r) => Object.values(checkReading(r.reading!)).every(Boolean)).length;
    summary[name] = perImageThb;
    console.log(
      [
        name.padEnd(13),
        `${String(okRows.length).padStart(3)}/${n}`,
        String(avg((r) => r.usage.input)).padStart(6),
        String(avg((r) => r.usage.output)).padStart(6),
        String(avg((r) => r.usage.cacheRead)).padStart(9),
        perImageThb.toFixed(3).padStart(7),
        (avg((r) => r.ms) / 1000).toFixed(1).padStart(6),
        `  ${allChecks}/${okRows.length}`,
      ].join('  '),
    );
  }

  // ช่องที่อ่านต่างจากแบบปัจจุบัน - เปิดรูปดูเองว่าฝั่งไหนถูก (นี่คือตัวตัดสินว่าลดได้จริงไหม)
  const base = results.get('current');
  if (base) {
    console.log('\n=== ช่องที่อ่านต่างจาก current (เปิดรูปเทียบว่าฝั่งไหนถูก) ===');
    for (const [name, rows] of results) {
      if (name === 'current') continue;
      const diffs = diffAgainstBase(base, rows);
      console.log(`\n${name}: ต่างกัน ${diffs.length} ช่อง`);
      for (const d of diffs.slice(0, 25)) console.log(`  ${d.file}  ${d.field}: current=${d.base}  ${name}=${d.other}`);
      if (diffs.length > 25) console.log(`  ... และอีก ${diffs.length - 25} ช่อง (ดูในไฟล์ผลดิบ)`);
    }
    const cur = summary['current'];
    if (cur) {
      console.log('\n=== ถูกลงกี่ % เทียบกับ current ===');
      for (const [name, thb] of Object.entries(summary)) {
        if (name === 'current') continue;
        console.log(`  ${name.padEnd(13)} ลดลง ${(((cur - thb) / cur) * 100).toFixed(0)}%  (${thb.toFixed(3)} บาท/ใบ)`);
      }
    }
  }

  const outFile = path.resolve('scripts/out', `receipt-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ model: MODEL, imagesDir, results: Object.fromEntries(results) }, null, 2));
  console.log(`\nผลดิบ: ${path.relative(process.cwd(), outFile)}`);
}

await main();

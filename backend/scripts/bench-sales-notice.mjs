// Benchmark: อ่านใบแจ้งจำหน่าย (Toyota/Lexus, Honda, Yamaha) ด้วย Claude Sonnet 5
// ใช้: node scripts/bench-sales-notice.mjs [dir] (ค่าเริ่มต้น uploads/sales-notice-samples)
// เทียบกับ ground truth ที่ถอดจากรูปด้วยมือ - ไม่แตะฐานข้อมูล
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

// โหลด ANTHROPIC_API_KEY จาก .env ถ้ายังไม่มีใน env
if (!process.env.ANTHROPIC_API_KEY && fs.existsSync('.env')) {
  const m = fs.readFileSync('.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m);
  if (m) process.env.ANTHROPIC_API_KEY = m[1].trim();
}

const MODEL = 'claude-sonnet-5';
const dir = process.argv[2] ?? 'uploads/sales-notice-samples';

const Schema = z.object({
  vehicleKind: z.enum(['car', 'motorcycle']).describe('รถยนต์ หรือ รถจักรยานยนต์ (ดูจากหัวเรื่อง "แจ้งการจำหน่ายรถยนต์" / "รถจักรยานยนต์")'),
  brand: z.string().describe('ยี่ห้อรถ เช่น โตโยต้า, เลกซัส, ฮอนด้า, ยามาฮ่า'),
  model: z.string().describe('แบบ/รุ่น ตามที่พิมพ์หลังคำว่า "แบบ" เช่น FORTUNER, SCOOPY, SG576'),
  chassis: z.string().describe('เลขตัวถัง/เลขตัวรถ 17 ตัว ตัวพิมพ์ใหญ่ ไม่มีช่องว่าง (มีพิมพ์ซ้ำใต้บาร์โค้ดด้วย ใช้ตรวจทานกัน)'),
  engine: z.string().describe('เลขเครื่องยนต์ หรือเลขมอเตอร์ (รถไฟฟ้า) ตามที่พิมพ์ทุกตัวอักษร รวมขีด'),
  bodyText: z.string().nullable().describe('ข้อความช่อง "ลักษณะ" ตามที่พิมพ์ เช่น นั่งสามตอน, เก๋งสองตอน, กระบะบรรทุก (มอเตอร์ไซค์ไม่มี = null)'),
  cylinders: z.number().nullable().describe('จำนวนสูบ (ไม่มี = null)'),
  cc: z.number().nullable().describe('ความจุกระบอกสูบ/ขนาด ซีซี เป็นตัวเลข (รถไฟฟ้าไม่มี = null)'),
  horsepower: z.number().nullable().describe('แรงม้า (ไม่มี = null)'),
  kilowatt: z.number().nullable().describe('กำลังกิโลวัตต์ สำหรับรถไฟฟ้า (ไม่มี = null)'),
  weightKg: z.number().nullable().describe('น้ำหนักรถ กก. (มอเตอร์ไซค์มักไม่มี = null)'),
  fuelText: z.string().nullable().describe('ชนิดเชื้อเพลิงตามที่พิมพ์ เช่น เบนซิน, ดีเซล, เบนซิน-ไฟฟ้า, ไฟฟ้า'),
  colorText: z.string().describe('สีตามที่พิมพ์ ตัดรหัสในวงเล็บออก เช่น "ขาว/ดำ", "ขาว" (ไม่ใช่ "ขาว (010C)")'),
  dealerName: z.string().describe('ชื่อผู้ซื้อ/ดีลเลอร์ในบรรทัด "ให้แก่" ตามที่พิมพ์'),
  dealerCode: z.string().nullable().describe('รหัสดีลเลอร์ที่พิมพ์: Toyota = ตัวเลขหลัง CUSTOMER, Yamaha = ตัวเลขในวงเล็บหลัง ผู้สั่ง (ไม่มี = null)'),
  documentNo: z.string().nullable().describe('เลขที่หนังสือ (ช่อง "ที่" ของ Toyota) หรือ ใบกำกับภาษีเลขที่ (Yamaha); ไม่มี = null'),
  documentDate: z.string().nullable().describe('วันที่ออกหนังสือ (บรรทัด "วันที่" ใต้หัวกระดาษ) แบบ พ.ศ. ตามที่พิมพ์ เช่น "23 กรกฎาคม 2569"'),
  registrationProvince: z.string().nullable().describe('จังหวัดที่จะจดทะเบียน จากส่วนเฉพาะเจ้าหน้าที่ด้านล่าง (เรียน นายทะเบียนจังหวัด ...) ถ้ามีหลายจังหวัดให้ใช้ช่องที่มีวันที่ล่าสุด; อ่านไม่ออก = null'),
  uncertainFields: z.array(z.string()).describe('ชื่อช่อง (key ด้านบน) ที่อ่านไม่ชัดหรือไม่มั่นใจ'),
});

const PROMPT = `คุณอ่านรูป "หนังสือแจ้งจำหน่ายและการรับรองหลักฐานการส่งบัญชีรับและจำหน่ายรถ" ของผู้ผลิตรถในไทย เพื่อกรอกข้อมูลรถจดทะเบียนใหม่
มี 3 แบบฟอร์มหลัก:
- Toyota/Lexus (บริษัท โตโยต้า มอเตอร์ ประเทศไทย): มีช่อง ที่, เลขตัวถัง, เลขเครื่องยนต์, ลักษณะ, จำนวน..สูบ, ความจุกระบอกสูบ..ซีซี, ..แรงม้า, น้ำหนักรถ..กก., ชนิดเชื้อเพลิง, สี, ให้แก่, CUSTOMER <รหัส>, MODEL <รหัส>
  รถไฟฟ้าจะมี "ชนิดมอเตอร์", "เลขมอเตอร์" และ "กำลัง .. กิโลวัตต์" แทนซีซี
- Honda (บริษัท ไทยฮอนด้า): รถจักรยานยนต์ มี เลขตัวถัง, เลขเครื่องยนต์, สี, ขนาด..ซี.ซี., จำนวน..สูบ, ชนิดเชื้อเพลิง, ให้แก่
- Yamaha (บริษัท ไทยยามาฮ่ามอเตอร์): รถจักรยานยนต์ มี แบบ <รหัสรุ่น>, สี <ชื่อ> (<รหัส>), เลขตัวรถ, เลขเครื่องยนต์, จำนวน..สูบ ขนาด..ซี.ซี., ใบกำกับภาษีเลขที่, ให้แก่, ผู้สั่ง (<รหัส>) <ชื่อดีลเลอร์> ที่มุมขวาบน
กติกา:
- คัดลอกตัวอักษรตามที่พิมพ์ทุกตัว ห้ามเดา ห้ามแก้ให้ดูสมเหตุสมผล เลขตัวถังต้อง 17 ตัวและตรงกับที่พิมพ์ใต้บาร์โค้ด
- bodyText ใช้เฉพาะข้อความหลังคำว่า "ลักษณะ" ของฟอร์ม Toyota/Lexus เท่านั้น ฟอร์ม Honda/Yamaha ไม่มีช่องนี้ ให้ใส่ null เสมอ (คำว่า FAMILY หรือชื่อรุ่นเช่น "FAZZIO : EL/Disc/CW" ไม่ใช่ลักษณะรถ)
- colorText ตัดรหัสในวงเล็บทิ้งเสมอ เช่น "น้ำเงิน (010F)" ให้ตอบ "น้ำเงิน"
- fuelText ใช้เฉพาะข้อความหลัง "ชนิดเชื้อเพลิง" ถ้าฟอร์มไม่พิมพ์ช่องนี้ (Yamaha) ให้ใส่ null คำว่า "Electric" ในชื่อรุ่น Yamaha หมายถึงสตาร์ทไฟฟ้า ไม่ใช่รถไฟฟ้า ห้ามนำมาเป็นเชื้อเพลิง
- รถไฟฟ้าที่มีเลขมอเตอร์ 2 ชุดพิมพ์ติดกัน ให้คัดลอกทั้งหมดตามที่พิมพ์ในบรรทัดเดียว ไม่ต้องตัด
- ระวังคู่ที่คล้ายกัน: 0/O, 1/I, 8/B, 5/S, 2/Z, G/6 — เลขตัวถังมาตรฐานไม่มี I, O, Q
- ส่วน "เฉพาะเจ้าหน้าที่" ด้านล่างเป็นตรายาง/ลายมือ อ่านยาก ถ้าไม่ชัดให้ใส่ null และใส่ชื่อช่องใน uncertainFields
- ช่องไหนอ่านไม่ชัดให้ใส่ชื่อช่องใน uncertainFields เสมอ`;

// ground truth ถอดด้วยมือจากรูป 20 ใบ (2026-09-22)
const TRUTH = {
  1: { chassis: 'MR0AB3GS002606296', engine: '2GDD598437', model: 'FORTUNER', bodyText: 'นั่งสามตอน', cc: 2393, weightKg: 1950, fuelText: 'ดีเซล', colorText: 'ขาว/ดำ', dealerCode: '12146', vehicleKind: 'car' },
  2: { chassis: 'JTMADDFB30J009374', engine: '2XM600B25L001173XM401B25K24821', model: 'BZ4X', bodyText: 'นั่งสองตอนแวน', cc: null, weightKg: 2000, fuelText: 'ไฟฟ้า', colorText: 'เทา/ดำ', dealerCode: '12146', vehicleKind: 'car' },
  3: { chassis: 'MR2A78BF904093599', engine: '2NR6225864', model: 'YARIS CROSS', bodyText: 'นั่งสองตอนแวน', cc: 1496, weightKg: 1250, fuelText: 'เบนซิน-ไฟฟ้า', colorText: 'ขาว', dealerCode: '11023', vehicleKind: 'car' },
  4: { chassis: 'MR2BD8A3100201791', engine: '3NR6257506', model: 'YARIS ATIV', bodyText: 'เก๋งสองตอน', cc: 1197, weightKg: 1050, fuelText: 'เบนซิน', colorText: 'เทา', dealerCode: '11023', vehicleKind: 'car' },
  5: { chassis: 'MHFAB1BY600119909', engine: '2NRY658695', model: 'VELOZ', bodyText: 'นั่งสามตอน', cc: 1496, weightKg: 1150, fuelText: 'เบนซิน', colorText: 'เทา', dealerCode: '11023', vehicleKind: 'car' },
  6: { chassis: 'MLHJK0435T5733071', engine: 'JK04E-3733072', model: 'SCOOPY', bodyText: null, cc: 109.51, weightKg: null, fuelText: 'เบนซิน', colorText: 'ขาว-น้ำเงิน', dealerCode: null, vehicleKind: 'motorcycle' },
  7: { chassis: 'JH2RH21T7TK100990', engine: 'RH21E-5045731', model: 'X-ADV', bodyText: null, cc: 745, weightKg: null, fuelText: 'เบนซิน', colorText: 'ขาว-ดำ', dealerCode: null, vehicleKind: 'motorcycle' },
  8: { chassis: 'MH3SG576111028638', engine: 'G3V5E-0916339', model: 'SG576', bodyText: null, cc: 155, weightKg: null, fuelText: null, colorText: 'ขาว', dealerCode: '3031200', vehicleKind: 'motorcycle' },
  9: { chassis: 'MLESEK51111274901', engine: 'E34SE-378161', model: 'SEK51', bodyText: null, cc: 125, weightKg: null, fuelText: null, colorText: 'ดำ', dealerCode: '3001000', vehicleKind: 'motorcycle' },
  10: { chassis: 'MLESEK52111386256', engine: 'E34SE-379062', model: 'SEK52', bodyText: null, cc: 125, weightKg: null, fuelText: null, colorText: 'น้ำเงิน', dealerCode: '3023100', vehicleKind: 'motorcycle' },
  11: { chassis: 'MH3SG577111014156', engine: 'G3V4E-0184869', model: 'SG577', bodyText: null, cc: 155, weightKg: null, fuelText: null, colorText: 'เทา/ดำ', dealerCode: '3023100', vehicleKind: 'motorcycle' },
  12: { chassis: 'RLCUE425111032015', engine: 'E34NE-095022', model: 'UE425', bodyText: null, cc: 114, weightKg: null, fuelText: null, colorText: 'น้ำตาล', dealerCode: '3004400', vehicleKind: 'motorcycle' },
  13: { chassis: 'MLEUE368111006277', engine: 'E35NE-016431', model: 'UE368', bodyText: null, cc: 115, weightKg: null, fuelText: null, colorText: 'ดำ', dealerCode: '3040600', vehicleKind: 'motorcycle' },
  14: { chassis: 'MLESEJ86111089453', engine: 'E33XE-0138634', model: 'SEJ86', bodyText: null, cc: 125, weightKg: null, fuelText: null, colorText: 'แดง', dealerCode: '3018900', vehicleKind: 'motorcycle' },
  15: { chassis: 'MH3SH222111058274', engine: 'H345E-0186084', model: 'SH22A/03', bodyText: null, cc: 300, weightKg: null, fuelText: null, colorText: 'ดำ/เทา', dealerCode: '3041000', vehicleKind: 'motorcycle' },
  16: { chassis: 'MLESEJ87111176966', engine: 'E33XE-0137058', model: 'SEJ87', bodyText: null, cc: 125, weightKg: null, fuelText: null, colorText: 'เทา/เหลือง', dealerCode: '3013200', vehicleKind: 'motorcycle' },
  17: { chassis: 'MLEUE367111007111', engine: 'E35NE-015347', model: 'UE367', bodyText: null, cc: 115, weightKg: null, fuelText: null, colorText: 'เทา', dealerCode: '3010100', vehicleKind: 'motorcycle' },
  18: { chassis: 'MR1AX3AJ002004530', engine: '2TRB431725', model: 'LAND CRUISER FJ', bodyText: 'นั่งสองตอนแวน', cc: 2694, weightKg: 1900, fuelText: 'เบนซิน', colorText: 'ขาว', dealerCode: '11023', vehicleKind: 'car' },
  19: { chassis: 'MR0CA8LB800103075', engine: '1GD1947588', model: 'HILUX REVO', bodyText: 'กระบะบรรทุก', cc: 2755, weightKg: 1700, fuelText: 'ดีเซล', colorText: 'ขาว', dealerCode: '12104', vehicleKind: 'car' },
  20: { chassis: 'JTJCLCAA302041611', engine: 'A25A3H12717', model: 'RX350H', bodyText: 'นั่งสองตอนแวน', cc: 2487, weightKg: 1990, fuelText: 'เบนซิน-ไฟฟ้า', colorText: 'ขาว', dealerCode: '11346', vehicleKind: 'car' },
};

const client = new Anthropic();
const norm = (v) => (v == null ? null : typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : v);

async function readOne(file) {
  const image = fs.readFileSync(file);
  const t0 = Date.now();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: 'medium', format: zodOutputFormat(Schema) },
    system: [{ type: 'text', text: PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } },
          { type: 'text', text: 'อ่านใบแจ้งจำหน่ายใบนี้' },
        ],
      },
    ],
  });
  return { reading: response.parsed_output, usage: response.usage, ms: Date.now() - t0, stop: response.stop_reason };
}

const files = fs.readdirSync(dir).filter((f) => /^\d+\.jpe?g$/i.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
// ใบแรกยิงเดี่ยวเพื่อสร้าง cache ก่อน ที่เหลือยิงพร้อมกันทีละ 4
const results = {};
results[files[0]] = await readOne(path.join(dir, files[0]));
for (let i = 1; i < files.length; i += 4) {
  const batch = files.slice(i, i + 4);
  const out = await Promise.all(batch.map((f) => readOne(path.join(dir, f))));
  batch.forEach((f, k) => (results[f] = out[k]));
}

const fields = Object.keys(TRUTH[1]);
const fieldErrors = Object.fromEntries(fields.map((f) => [f, 0]));
let totalIn = 0, totalOut = 0, totalCached = 0, perfect = 0;
const rows = [];
for (const f of files) {
  const n = parseInt(f);
  const { reading: r, usage, ms } = results[f];
  const truth = TRUTH[n];
  const wrong = [];
  for (const k of fields) {
    if (norm(r[k]) !== norm(truth[k])) { wrong.push(`${k}: ได้ "${r[k]}" ควรเป็น "${truth[k]}"`); fieldErrors[k]++; }
  }
  if (!wrong.length) perfect++;
  totalIn += usage.input_tokens; totalOut += usage.output_tokens; totalCached += usage.cache_read_input_tokens ?? 0;
  rows.push({ n, ms, wrong, uncertain: r.uncertainFields, province: r.registrationProvince, dealer: r.dealerName, brand: r.brand, date: r.documentDate, docNo: r.documentNo });
  console.log(`#${n} ${wrong.length ? 'ผิด ' + wrong.length : 'ถูกทุกช่อง'} (${ms} ms) uncertain=[${r.uncertainFields.join(',')}] province=${r.registrationProvince} dealer=${r.dealerName}`);
  for (const w of wrong) console.log('   - ' + w);
}
console.log('\nสรุป');
console.log(`ถูกทุกช่อง ${perfect}/${files.length} ใบ`);
for (const k of fields) console.log(`  ${k.padEnd(12)} ผิด ${fieldErrors[k]}`);
const inCost = (totalIn * 2 + totalCached * 0.2) / 1e6, outCost = (totalOut * 10) / 1e6;
console.log(`tokens: input ${totalIn} (cached ${totalCached}) output ${totalOut}`);
console.log(`ค่าใช้จ่ายรวม ~$${(inCost + outCost).toFixed(4)} = ~$${((inCost + outCost) / files.length).toFixed(4)}/ใบ`);
fs.writeFileSync(path.join(dir, 'bench-result.json'), JSON.stringify({ model: MODEL, rows, results }, null, 2));

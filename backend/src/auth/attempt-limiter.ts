import type { Request } from 'express';

// นับจำนวนครั้งต่อ key ในช่วงเวลาหนึ่ง (พบ 2026-09-27: ล็อกอินผิด/สมัครได้ไม่จำกัดครั้ง) - เก็บในหน่วยความจำ
// พอสำหรับ backend เครื่องเดียวบน Render; รีสตาร์ตแล้วนับใหม่ (ยอมรับได้)
// ช่วงเวลาเริ่มนับจากครั้งแรก: ครบ max ครั้งแล้วต้องรอจนหมดช่วงนั้น
const MAX_KEYS = 50_000; // กัน Map โตไม่จำกัดถ้ามีคนยิงมาจากหลาย IP

export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  // ต้องรออีกกี่ ms ก่อนลองใหม่ได้ (0 = ยังไม่ถูกจำกัด)
  blockedFor(key: string): number {
    const entry = this.current(key);
    return entry && entry.count >= this.max ? entry.resetAt - this.now() : 0;
  }

  hit(key: string) {
    const entry = this.current(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    this.prune();
    this.hits.set(key, { count: 1, resetAt: this.now() + this.windowMs });
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private current(key: string) {
    const entry = this.hits.get(key);
    if (entry && entry.resetAt <= this.now()) {
      this.hits.delete(key);
      return undefined;
    }
    return entry;
  }

  // ลบรายการที่หมดช่วงแล้ว ถ้ายังเกินเพดานให้ลบรายการเก่าสุดทิ้ง (Map เรียงตามลำดับที่เพิ่ม)
  private prune() {
    if (this.hits.size < MAX_KEYS) return;
    const now = this.now();
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    for (const key of this.hits.keys()) {
      if (this.hits.size < MAX_KEYS) break;
      this.hits.delete(key);
    }
  }
}

type IpRequest = Pick<Request, 'headers' | 'socket'>;

// IP ของผู้ใช้สำหรับนับครั้ง (พบ 2026-09-27: ถ้าได้ IP ของ proxy ที่ใช้ร่วมกัน คนแปลกหน้าล็อกบัญชีคนอื่นหรือปิดการสมัครทั้งระบบได้)
// 1. CF-Connecting-IP: onrender.com อยู่หลัง Cloudflare ซึ่งเขียนค่านี้ทับด้วย IP ที่ต่อเข้ามาจริงทุกคำขอ ผู้ใช้ปลอมไม่ได้
//    (ถ้าย้าย backend ไปที่ไม่ผ่าน Cloudflare ต้องเลิกเชื่อ header นี้ ไม่งั้นผู้ใช้ส่งค่าปลอมมาเปลี่ยน IP ได้เรื่อยๆ)
// 2. ไม่มี: X-Forwarded-For ตัวที่ TRUSTED_PROXY_HOPS จากท้าย (ค่าเริ่ม 1 = proxy ชั้นเดียว) เพราะค่าหน้าๆ ผู้ใช้ปลอมเองได้
// 3. ไม่มีทั้งคู่ = ต่อตรง (เครื่อง dev)
export function clientIp(req: IpRequest, hops = trustedProxyHops()): string {
  const cf = headerValues(req, 'cf-connecting-ip')[0];
  if (cf) return networkOf(cf);
  const forwarded = headerValues(req, 'x-forwarded-for');
  const ip = forwarded.at(-Math.min(hops, forwarded.length)) ?? req.socket?.remoteAddress ?? '';
  return ip && networkOf(ip);
}

function trustedProxyHops(): number {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS);
  return Number.isInteger(hops) && hops > 0 ? hops : 1;
}

function headerValues(req: IpRequest, name: string): string[] {
  const header = req.headers[name];
  return (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

// IPv6 นับทั้ง /64: บ้านหรือออฟฟิศหนึ่งได้ที่อยู่ใน /64 ของตัวเองไม่จำกัด เปลี่ยนที่อยู่ไปเรื่อยๆ ก็ลองได้ไม่จำกัด (เหมือน NAT ของ IPv4)
// IPv4 (รวมแบบ ::ffff:1.2.3.4 และแบบมี :port) ใช้ตัว IP ตรงๆ
function networkOf(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => (Number.parseInt(group, 16) || 0).toString(16)).join(':')}::/64`;
}

// บอกรูปแบบ header ของ proxy ใน log ครั้งเดียว (ไม่มีตัว IP) ไว้ตรวจบน Render ว่า clientIp เลือกถูกชั้น
export function describeIpHeaders(req: IpRequest): string {
  const cf = headerValues(req, 'cf-connecting-ip')[0];
  const forwarded = headerValues(req, 'x-forwarded-for');
  const position = cf ? forwarded.indexOf(cf) : -1;
  return [
    `cf-connecting-ip: ${cf ? 'มี' : 'ไม่มี'}`,
    `true-client-ip: ${headerValues(req, 'true-client-ip').length ? 'มี' : 'ไม่มี'}`,
    `x-forwarded-for: ${forwarded.length} ค่า`,
    cf ? `cf-connecting-ip อยู่ใน x-forwarded-for ตำแหน่ง ${position < 0 ? '-' : `${position + 1} จากหน้า`}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export function waitMinutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

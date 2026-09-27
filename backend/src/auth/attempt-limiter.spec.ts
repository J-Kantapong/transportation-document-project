import { afterEach, describe, expect, it } from 'vitest';
import { AttemptLimiter, clientIp, describeIpHeaders, waitMinutes } from './attempt-limiter.js';

describe('AttemptLimiter - นับครั้งต่อ key ในช่วงเวลา (พบ 2026-09-27)', () => {
  function setup(max = 3, windowMs = 1000) {
    const clock = { t: 0 };
    return { limiter: new AttemptLimiter(max, windowMs, () => clock.t), clock };
  }

  it('ครบจำนวนแล้วต้องรอจนหมดช่วง แล้วนับใหม่', () => {
    const { limiter, clock } = setup();
    limiter.hit('a');
    limiter.hit('a');
    expect(limiter.blockedFor('a')).toBe(0);
    limiter.hit('a');
    clock.t = 400;
    expect(limiter.blockedFor('a')).toBe(600);
    clock.t = 1000;
    expect(limiter.blockedFor('a')).toBe(0);
    limiter.hit('a');
    expect(limiter.blockedFor('a')).toBe(0);
  });

  it('แยก key กัน และ reset ล้างเฉพาะ key นั้น', () => {
    const { limiter } = setup(1);
    limiter.hit('a');
    limiter.hit('b');
    expect(limiter.blockedFor('a')).toBeGreaterThan(0);
    limiter.reset('a');
    expect(limiter.blockedFor('a')).toBe(0);
    expect(limiter.blockedFor('b')).toBeGreaterThan(0);
    expect(limiter.blockedFor('c')).toBe(0);
  });
});

describe('clientIp - IP ของผู้ใช้หลัง Cloudflare + Render (พบ 2026-09-27)', () => {
  type Req = Parameters<typeof clientIp>[0];
  const req = (forwarded: string | string[] | undefined, remote = '10.0.0.1', cf?: string) =>
    ({ headers: { 'x-forwarded-for': forwarded, 'cf-connecting-ip': cf }, socket: { remoteAddress: remote } }) as unknown as Req;

  afterEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
  });

  it('มี CF-Connecting-IP ใช้ค่านั้น ไม่สน X-Forwarded-For ที่ต่อท้ายด้วย IP ของ proxy ร่วมกัน', () => {
    expect(clientIp(req('203.0.113.9, 172.70.1.1, 10.1.2.3', '10.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(req('6.6.6.6, 203.0.113.9, 172.70.1.1', '10.0.0.1', ' 203.0.113.9 '))).toBe('203.0.113.9');
  });

  it('ไม่มี CF-Connecting-IP: ใช้ X-Forwarded-For ตัวท้ายสุด ไม่เชื่อค่าหน้าๆ ที่ผู้ใช้ปลอมมาได้', () => {
    expect(clientIp(req('1.1.1.1, 203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(req(['1.1.1.1', '203.0.113.9 ']))).toBe('203.0.113.9');
    expect(clientIp(req('203.0.113.9'))).toBe('203.0.113.9');
  });

  it('TRUSTED_PROXY_HOPS = จำนวน proxy ที่ต่อท้าย X-Forwarded-For (ค่าผิดใช้ 1)', () => {
    expect(clientIp(req('1.1.1.1, 203.0.113.9, 172.70.1.1'), 2)).toBe('203.0.113.9');
    expect(clientIp(req('203.0.113.9'), 3)).toBe('203.0.113.9');
    process.env.TRUSTED_PROXY_HOPS = '2';
    expect(clientIp(req('1.1.1.1, 203.0.113.9, 172.70.1.1'))).toBe('203.0.113.9');
    process.env.TRUSTED_PROXY_HOPS = 'abc';
    expect(clientIp(req('1.1.1.1, 203.0.113.9, 172.70.1.1'))).toBe('172.70.1.1');
  });

  it('ไม่มี header = IP ที่ต่อเข้ามาตรง', () => {
    expect(clientIp(req(undefined))).toBe('10.0.0.1');
    expect(clientIp(req(' , '))).toBe('10.0.0.1');
    expect(clientIp(req(undefined, '::ffff:127.0.0.1'))).toBe('127.0.0.1');
  });

  it('IPv6 นับทั้ง /64 (เปลี่ยนที่อยู่ในวงเดียวกันไม่ช่วยให้ลองได้เพิ่ม) - IPv4 ตัด ::ffff: และ :port ออก', () => {
    const net = '2001:db8:abcd:12::/64';
    expect(clientIp(req(undefined, '10.0.0.1', '2001:db8:abcd:12:1:2:3:4'))).toBe(net);
    expect(clientIp(req(undefined, '10.0.0.1', '2001:DB8:ABCD:0012::99'))).toBe(net);
    expect(clientIp(req('2001:db8:abcd:12:ffff::1'))).toBe(net);
    expect(clientIp(req(undefined, '10.0.0.1', '2001:db8::1'))).toBe('2001:db8:0:0::/64');
    expect(clientIp(req(undefined, '::1'))).toBe('0:0:0:0::/64');
    expect(clientIp(req('203.0.113.9:4567'))).toBe('203.0.113.9');
  });
});

describe('describeIpHeaders', () => {
  it('บอกแค่รูปแบบ header ไม่มีตัว IP ใน log', () => {
    const text = describeIpHeaders({
      headers: { 'x-forwarded-for': '203.0.113.9, 172.70.1.1', 'cf-connecting-ip': '203.0.113.9' },
      socket: {},
    } as unknown as Parameters<typeof describeIpHeaders>[0]);
    expect(text).toBe('cf-connecting-ip: มี, true-client-ip: ไม่มี, x-forwarded-for: 2 ค่า, cf-connecting-ip อยู่ใน x-forwarded-for ตำแหน่ง 1 จากหน้า');
    expect(text).not.toContain('203.0.113.9');
  });
});

describe('waitMinutes', () => {
  it('ปัดขึ้นเป็นนาที อย่างน้อย 1 นาที', () => {
    expect(waitMinutes(1)).toBe(1);
    expect(waitMinutes(60_001)).toBe(2);
    expect(waitMinutes(15 * 60_000)).toBe(15);
  });
});

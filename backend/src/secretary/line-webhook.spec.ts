import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLineSignature } from './line-webhook.js';

const secret = 'test-channel-secret';
const body = Buffer.from(JSON.stringify({ destination: 'Uxxxx', events: [] }));
const sign = (raw: Buffer, key = secret) => createHmac('sha256', key).update(raw).digest('base64');

describe('verifyLineSignature', () => {
  it('รับลายเซ็นที่ถูกต้อง', () => {
    expect(verifyLineSignature(body, sign(body), secret)).toBe(true);
  });

  it('ปฏิเสธเมื่อ body ถูกแก้ ลายเซ็นผิด ใช้ secret อื่น หรือไม่มีลายเซ็น', () => {
    expect(verifyLineSignature(Buffer.from('{"events":[1]}'), sign(body), secret)).toBe(false);
    expect(verifyLineSignature(body, 'AAAA', secret)).toBe(false);
    expect(verifyLineSignature(body, sign(body, 'other-secret'), secret)).toBe(false);
    expect(verifyLineSignature(body, undefined, secret)).toBe(false);
    expect(verifyLineSignature(body, '', secret)).toBe(false);
  });

  it('ไม่ตั้ง secret = ปฏิเสธทุกคำขอ (ห้ามยอมรับลายเซ็นของ secret ว่าง)', () => {
    expect(verifyLineSignature(body, sign(body, ''), '')).toBe(false);
  });
});

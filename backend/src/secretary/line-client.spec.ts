import { describe, expect, it, vi } from 'vitest';
import { LineConfigError, lineConfigFromEnv, pushLine, pushLineText, replyLine } from './line-client.js';

const USER_ID = `U${'a1'.repeat(16)}`;
const config = { token: 'test-token', userId: USER_ID };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('lineConfigFromEnv', () => {
  it('อ่านค่าจาก env และตัดช่องว่างหัวท้าย', () => {
    expect(lineConfigFromEnv({ LINE_CHANNEL_ACCESS_TOKEN: ' tok ', LINE_USER_ID: ` ${USER_ID} ` })).toEqual({
      token: 'tok',
      userId: USER_ID,
    });
  });

  it('บอกชื่อค่าที่ขาดทั้งสองตัว', () => {
    expect(() => lineConfigFromEnv({})).toThrow(/LINE_CHANNEL_ACCESS_TOKEN และ LINE_USER_ID/);
    expect(() => lineConfigFromEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'tok' })).toThrow(/LINE_USER_ID/);
  });

  it('ปฏิเสธ user id ที่รูปแบบผิด', () => {
    expect(() => lineConfigFromEnv({ LINE_CHANNEL_ACCESS_TOKEN: 'tok', LINE_USER_ID: 'abc' })).toThrow(LineConfigError);
  });
});

describe('replyLine', () => {
  it('ส่งไปที่ reply endpoint พร้อม replyToken', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await replyLine('reply-token-1', [{ type: 'text', text: 'ตอบ' }], config, fetchMock);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.line.me/v2/bot/message/reply');
    expect(JSON.parse(init.body as string)).toEqual({ replyToken: 'reply-token-1', messages: [{ type: 'text', text: 'ตอบ' }] });
  });

  it('error จาก LINE มีข้อความอธิบายแต่ไม่มี token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { message: 'Invalid reply token' }));
    const error = await replyLine('x', [{ type: 'text', text: 'a' }], config, fetchMock).catch((e: Error) => e);
    expect((error as Error).message).toBe('LINE ตอบกลับ 400: Invalid reply token');
    expect((error as Error).message).not.toContain('test-token');
  });
});

describe('pushLine', () => {
  it('ส่ง POST พร้อม Bearer token และปลายทาง', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await pushLineText('สวัสดี', config, fetchMock);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body as string)).toEqual({ to: USER_ID, messages: [{ type: 'text', text: 'สวัสดี' }] });
  });

  it('error จาก LINE มีสถานะและข้อความ แต่ไม่มี token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { message: 'Authentication failed' }));
    const error = await pushLineText('x', config, fetchMock).catch((e: Error) => e);
    expect((error as Error).message).toBe('LINE ตอบกลับ 401: Authentication failed');
    expect((error as Error).message).not.toContain('test-token');
  });

  it('error ที่ไม่ใช่ JSON ก็ยังบอกสถานะ', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));
    await expect(pushLineText('x', config, fetchMock)).rejects.toThrow('LINE ตอบกลับ 502');
  });

  it('ปฏิเสธจำนวนข้อความผิดและข้อความที่ยาวเกิน โดยไม่เรียก LINE', async () => {
    const fetchMock = vi.fn();
    await expect(pushLine([], config, fetchMock)).rejects.toThrow('1-5');
    await expect(pushLineText('ก'.repeat(5001), config, fetchMock)).rejects.toThrow('ยาวเกิน');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { menuCardFor, replyFor } from './customer-line.service.js';
import { cardMessage, cardTextMessage, findMenuCard, MENU_CARDS, WELCOME_CARD } from './customer-menu.js';
import { RICH_MENU_KEYWORDS, RICH_MENU_NAME, richMenuDefinition, syncRichMenu } from './rich-menu.js';
import { isTaxQuestion } from './tax-check.js';
import { isTroQuestion } from './tro-check.js';

const today = '2026-10-09';
const text = (value: string) => ({ type: 'message', message: { type: 'text', text: value } });
const idOf = (value: string) => findMenuCard(value)?.id;

describe('เมนูเอกสารในไลน์ลูกค้า', () => {
  it('คำสำคัญตรงตัว = การ์ดของเรื่องนั้น ไม่สนช่องว่างและตัวพิมพ์', () => {
    expect(idOf('เอกสาร')).toBe('documents');
    expect(idOf('จดใหม่')).toBe('new');
    expect(idOf(' จดใหม่  บุคคลสด ')).toBe('new-person-cash');
    expect(idOf('โอน')).toBe('transfer');
    expect(idOf('MENU')).toBe('welcome');
  });

  it('คำสำคัญอยู่ในประโยค = เอาคำที่ยาวที่สุด แต่คำสั้นต้องตรงตัว', () => {
    expect(idOf('ขอเอกสารจดใหม่ บุคคลไฟแนนซ์หน่อยครับ')).toBe('new-person-finance');
    expect(idOf('อยากโอนรถต้องใช้อะไรบ้าง')).toBe('transfer');
    expect(idOf('โอนเงินแล้วครับ')).toBeUndefined();
    expect(idOf('')).toBeUndefined();
  });

  it('ข้อความที่ไม่รู้จักและการเพิ่มเพื่อน = การ์ดทักทาย · เรื่อง ตรอ. ยังเป็นของบอท ตรอ.', () => {
    expect(menuCardFor(text('ราคาเท่าไหร่'))).toBe(WELCOME_CARD);
    expect(menuCardFor({ type: 'follow' })).toBe(WELCOME_CARD);
    expect(menuCardFor({ type: 'message', message: { type: 'sticker' } })).toBeNull();
    expect(replyFor(text('เอกสาร'), today)).toMatchObject({ type: 'flex', altText: 'เอกสารแต่ละงาน' });
    expect(replyFor(text('ตรอ'), today)?.type).toBe('text');
  });

  it('ปุ่มทุกปุ่มที่ส่งข้อความ พาไปการ์ดที่มีจริงหรือไปบอท ตรอ.', () => {
    for (const card of MENU_CARDS) {
      expect(card.buttons.length).toBeGreaterThan(0);
      for (const button of card.buttons) {
        expect(button.label.length).toBeLessThanOrEqual(40);
        if ('uri' in button) expect(button.uri).toMatch(/^(https:\/\/|tel:)/);
        else expect(isTroQuestion(button.text) || isTaxQuestion(button.text) || findMenuCard(button.text, true) !== null).toBe(true);
      }
    }
  });

  it('คำสำคัญไม่ซ้ำกันระหว่างการ์ด และไม่มีคำไหนถูกบอท ตรอ. แย่งไป', () => {
    const seen = new Map<string, string>();
    for (const card of MENU_CARDS) {
      for (const keyword of card.keywords) {
        expect(seen.get(keyword) ?? card.id).toBe(card.id);
        seen.set(keyword, card.id);
        expect(isTroQuestion(keyword) || isTaxQuestion(keyword)).toBe(false);
        expect(findMenuCard(keyword)).toBe(card);
      }
    }
  });

  it('การ์ดไม่มีราคา และมีข้อความล้วนสำรองที่บอกคำที่ต้องพิมพ์', () => {
    for (const card of MENU_CARDS) {
      const flex = JSON.stringify(cardMessage(card));
      expect(flex).not.toMatch(/บาท|฿/);
      expect(card.body.trim()).not.toBe('');
    }
    const fallback = cardTextMessage(WELCOME_CARD);
    expect(fallback.type === 'text' && fallback.text).toContain('พิมพ์ เอกสาร = เอกสารแต่ละงาน');
  });
});

describe('แถบเมนูด้านล่างแชต', () => {
  it('9 ช่องเต็มรูปพอดี ไม่ทับกัน และทุกช่องพาไปการ์ดที่มีจริง', () => {
    const { size, areas } = richMenuDefinition();
    expect(areas).toHaveLength(9);
    expect(areas.reduce((sum, area) => sum + area.bounds.width * area.bounds.height, 0)).toBe(size.width * size.height);
    for (const keyword of RICH_MENU_KEYWORDS) expect(findMenuCard(keyword, true)).not.toBeNull();
  });

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const image = new Uint8Array([1, 2, 3]);

  it('ยังไม่มีเมนู = สร้าง อัปโหลดรูป ตั้งเป็นค่าเริ่มต้น แล้วลบรุ่นเก่าของตัวเอง', async () => {
    const calls: string[] = [];
    const result = await syncRichMenu('token', image, async (url, init) => {
      calls.push(`${init.method} ${url.replace(/^https:\/\/[^/]+\/v2\/bot/, '')}`);
      if (url.endsWith('/richmenu/list')) return json({ richmenus: [{ richMenuId: 'old', name: 'jitkusol-main-v0' }, { richMenuId: 'other', name: 'promo' }] });
      if (url.endsWith('/richmenu')) return json({ richMenuId: 'new' });
      return json({});
    });
    expect(result).toBe('created');
    expect(calls).toEqual(['GET /richmenu/list', 'POST /richmenu', 'POST /richmenu/new/content', 'POST /user/all/richmenu/new', 'DELETE /richmenu/old']);
  });

  it('มีเมนูรุ่นนี้และเป็นค่าเริ่มต้นแล้ว = ไม่ทำอะไร', async () => {
    const calls: string[] = [];
    const result = await syncRichMenu('token', image, async (url, init) => {
      calls.push(String(init.method));
      return url.endsWith('/richmenu/list') ? json({ richmenus: [{ richMenuId: 'now', name: RICH_MENU_NAME }] }) : json({ richMenuId: 'now' });
    });
    expect(result).toBe('unchanged');
    expect(calls).toEqual(['GET', 'GET']);
  });

  it('อัปโหลดรูปไม่สำเร็จ = ลบเมนูที่เพิ่งสร้างทิ้ง ไม่ค้างเมนูไม่มีรูป', async () => {
    const calls: string[] = [];
    const run = syncRichMenu('token', image, async (url, init) => {
      calls.push(`${init.method} ${url.replace(/^https:\/\/[^/]+\/v2\/bot/, '')}`);
      if (url.endsWith('/richmenu/list')) return json({ richmenus: [] });
      if (url.endsWith('/richmenu')) return json({ richMenuId: 'new' });
      if (url.endsWith('/content')) return json({ message: 'bad image' }, 400);
      return json({});
    });
    await expect(run).rejects.toThrow('อัปโหลดรูปเมนู: LINE ตอบกลับ 400: bad image');
    expect(calls.at(-1)).toBe('DELETE /richmenu/new');
  });
});

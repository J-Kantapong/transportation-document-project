import { describe, expect, it } from 'vitest';
import { replyFor } from './customer-line.service.js';
import { checkTro, inspectionAgeYears, isTroQuestion, parseTroPostback } from './tro-check.js';

describe('เช็ก ตรอ. ในไลน์ลูกค้า', () => {
  it('จำนวนปีต่างกันตามประเภทรถ: รถยนต์ 7 ปี มอเตอร์ไซค์ 5 ปี', () => {
    expect(inspectionAgeYears('car')).toBe(7);
    expect(inspectionAgeYears('moto')).toBe(5);
  });

  it('รถยนต์: ก่อนครบ 7 ปีหนึ่งวันยังไม่ต้องตรวจ ครบ 7 ปีพอดีต้องตรวจ', () => {
    expect(checkTro('car', '2019-10-10', '2026-10-09')).toMatchObject({ required: false, requiredFrom: '2026-10-10', ageYears: 7 });
    expect(checkTro('car', '2019-10-09', '2026-10-09')).toMatchObject({ required: true, requiredFrom: '2026-10-09' });
  });

  it('มอเตอร์ไซค์: รถอายุ 5 ปีต้องตรวจ ทั้งที่รถยนต์อายุเท่ากันยังไม่ต้อง', () => {
    expect(checkTro('moto', '2021-10-09', '2026-10-09')?.required).toBe(true);
    expect(checkTro('moto', '2021-10-10', '2026-10-09')?.required).toBe(false);
    expect(checkTro('car', '2021-10-09', '2026-10-09')?.required).toBe(false);
  });

  it('จดทะเบียน 29 ก.พ. ครบรอบในปีที่ไม่มี 29 ก.พ. ใช้วันสุดท้ายของเดือน', () => {
    expect(checkTro('moto', '2020-02-29', '2025-02-27')).toMatchObject({ required: false, requiredFrom: '2025-02-28' });
    expect(checkTro('moto', '2020-02-29', '2025-02-28')?.required).toBe(true);
  });

  it('วันที่ผิดรูปแบบ ไม่มีจริง หรืออยู่ในอนาคต = ไม่มีผล', () => {
    expect(checkTro('car', '', '2026-10-09')).toBeNull();
    expect(checkTro('car', '2026-02-30', '2026-10-09')).toBeNull();
    expect(checkTro('car', '2026-10-10', '2026-10-09')).toBeNull();
  });

  it('จับคำถามเรื่อง ตรอ. แม้มีจุดหรือช่องว่าง และไม่จับข้อความอื่น', () => {
    expect(isTroQuestion('ตรอ')).toBe(true);
    expect(isTroQuestion('เช็ค ตรอ.')).toBe(true);
    expect(isTroQuestion('ต้องตรวจ ต.ร.อ. ไหม')).toBe(true);
    expect(isTroQuestion('เอกสาร')).toBe(false);
    expect(isTroQuestion(undefined)).toBe(false);
  });

  it('postback ที่ไม่ใช่ของ ตรอ. ถูกเมิน', () => {
    expect(parseTroPostback('tro:car')).toBe('car');
    expect(parseTroPostback('tro:moto')).toBe('moto');
    expect(parseTroPostback('tro:truck')).toBeNull();
    expect(parseTroPostback('other')).toBeNull();
  });
});

describe('replyFor', () => {
  const today = '2026-10-09';

  it('พิมพ์ ตรอ = ถามประเภทรถด้วยปุ่มเปิดปฏิทิน เลือกได้ไม่เกินวันนี้', () => {
    const reply = replyFor({ type: 'message', message: { type: 'text', text: 'เช็ก ตรอ' } }, today);
    expect(reply?.quickReply?.items.map((item) => item.action)).toEqual([
      { type: 'datetimepicker', label: 'รถยนต์', data: 'tro:car', mode: 'date', max: today },
      { type: 'datetimepicker', label: 'มอเตอร์ไซค์', data: 'tro:moto', mode: 'date', max: today },
    ]);
  });

  it('เลือกวันจดทะเบียนแล้วตอบผลเป็น พ.ศ.', () => {
    const due = replyFor({ type: 'postback', postback: { data: 'tro:moto', params: { date: '2021-03-15' } } }, today);
    expect(due).toMatchObject({ type: 'text' });
    expect(due && 'text' in due ? due.text : '').toContain('ผล: ต้องตรวจ ตรอ. ก่อนต่อภาษี');
    expect(due && 'text' in due ? due.text : '').toContain('มอเตอร์ไซค์ จดทะเบียนวันที่ 15/03/2564');

    const notYet = replyFor({ type: 'postback', postback: { data: 'tro:car', params: { date: '2021-03-15' } } }, today);
    expect(notYet && 'text' in notYet ? notYet.text : '').toContain('ผล: ยังไม่ต้องตรวจ ตรอ.');
    expect(notYet && 'text' in notYet ? notYet.text : '').toContain('15/03/2571');
  });

  it('พิมพ์วันที่ พ.ศ. พร้อมประเภทรถ = ตอบผลเลย · ไม่บอกประเภท = ตอบทั้งสองประเภท · วันที่ผิด = บอกรูปแบบ', () => {
    const textOf = (text: string) => {
      const reply = replyFor({ type: 'message', message: { type: 'text', text } }, today);
      return reply && 'text' in reply ? reply.text : '';
    };
    expect(textOf('ตรอ มอเตอร์ไซค์ 15/03/2564')).toContain('ผล: ต้องตรวจ ตรอ. ก่อนต่อภาษี');
    expect(textOf('ตรอ รถยนต์ 15/03/2564')).toContain('ผล: ยังไม่ต้องตรวจ ตรอ.');
    expect(textOf('เช็ค ตรอ. มอไซค์ 5-3-64')).toContain('มอเตอร์ไซค์ จดทะเบียนวันที่ 05/03/2564');
    const both = textOf('ตรอ 15/03/2564');
    expect(both).toContain('ถ้าเป็นรถยนต์: ยังไม่ต้องตรวจ ตรอ.');
    expect(both).toContain('ถ้าเป็นมอเตอร์ไซค์: ต้องตรวจ ตรอ. ก่อนต่อภาษี');
    expect(textOf('ตรอ รถยนต์ 15/03/2580')).toContain('วันจดทะเบียนไม่ถูกต้อง');
    expect(textOf('ตรอ 31/02/2562')).toContain('วันจดทะเบียนไม่ถูกต้อง');
    expect(textOf('ตรอ 15/03/256')).toContain('วันจดทะเบียนไม่ถูกต้อง');
  });

  it('ข้อความอื่นและ postback อื่นไม่ตอบ ปล่อยให้เจ้าหน้าที่/ข้อความอัตโนมัติของ LINE ตอบ', () => {
    expect(replyFor({ type: 'message', message: { type: 'text', text: 'เอกสาร' } }, today)).toBeNull();
    expect(replyFor({ type: 'message', message: { type: 'image' } }, today)).toBeNull();
    expect(replyFor({ type: 'postback', postback: { data: 'menu:1' } }, today)).toBeNull();
    expect(replyFor({ type: 'follow' }, today)).toBeNull();
  });

  it('postback ของ ตรอ. ที่ไม่มีวันที่ = บอกให้เริ่มใหม่', () => {
    const reply = replyFor({ type: 'postback', postback: { data: 'tro:car' } }, today);
    expect(reply && 'text' in reply ? reply.text : '').toContain('วันจดทะเบียนไม่ถูกต้อง');
  });
});

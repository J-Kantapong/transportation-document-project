import { describe, expect, it } from 'vitest';
import { GovTaxFuelGroup, GovTaxVehicleFamily } from '../generated/prisma/enums.js';
import type { LineEvent } from '../secretary/line-webhook.js';
import type { VehicleTaxRuleSet } from '../tax-renewal/vehicle-tax-calculator.js';
import { routeEvent } from './customer-line.service.js';
import { answerTax, isTaxQuestion, nextAnniversary, parseTaxKind, startTax, type TaxKind, type TaxSession } from './tax-check.js';

const today = '2026-10-09';

// อัตราตามกฎหมายชุดย่อ พอสำหรับทดสอบ (ของจริงอ่านจากตาราง GovernmentTax*) - ไม่มีอัตรามอเตอร์ไซค์ไฟฟ้า เหมือนฐานข้อมูลตอนนี้
const rules: VehicleTaxRuleSet = {
  ccBrackets: [
    { fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 0, ccTo: 600, ratePerCc: 0.5 },
    { fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 600, ccTo: 1800, ratePerCc: 1.5 },
    { fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 1800, ccTo: null, ratePerCc: 4 },
  ],
  weightBrackets: [
    { vehicleFamily: GovTaxVehicleFamily.RY1, fuelGroup: GovTaxFuelGroup.BEV, weightFrom: 1500, weightTo: 1750, amount: 1300 },
    { vehicleFamily: GovTaxVehicleFamily.RY3, fuelGroup: null, weightFrom: 1500, weightTo: 1750, amount: 1050 },
  ],
  evIncentives: [],
  motorcycleFlat: [{ fuelGroup: GovTaxFuelGroup.ICE, amount: 100 }],
};

const bodyOf = (message: unknown): string => {
  const m = message as { type: string; text?: string; contents?: { body: { contents: Array<{ text: string }> } } };
  return m.type === 'flex' ? m.contents!.body.contents[0].text : (m.text ?? '');
};

function run(kind: TaxKind, answers: string[]) {
  let step = startTax(kind, today, rules);
  for (const typed of answers) step = answerTax(step.session as TaxSession, { typed }, today, rules);
  return { done: step.session === null, text: bodyOf(step.message) };
}

describe('เช็กค่าภาษีในไลน์ลูกค้า', () => {
  it('จับคำถามเรื่องค่าภาษี แต่ "ต่อภาษี" เฉยๆ เป็นเรื่องเอกสาร', () => {
    expect(isTaxQuestion('เช็กภาษี')).toBe(true);
    expect(isTaxQuestion('ค่าภาษีรถเท่าไหร่')).toBe(true);
    expect(isTaxQuestion('ภาษี กระบะ')).toBe(true);
    expect(isTaxQuestion('ต่อภาษี')).toBe(false);
    expect(isTaxQuestion('เอกสาร')).toBe(false);
  });

  it('อ่านประเภทรถจากข้อความ รวมรถไฟฟ้า', () => {
    expect(parseTaxKind('ภาษี เก๋ง')).toBe('car');
    expect(parseTaxKind('ภาษี รถไฟฟ้า')).toBe('ev');
    expect(parseTaxKind('ภาษี กระบะ')).toBe('pickup');
    expect(parseTaxKind('ภาษี มอเตอร์ไซค์')).toBe('moto');
    expect(parseTaxKind('ภาษี มอเตอร์ไซค์ไฟฟ้า')).toBe('emoto');
    expect(parseTaxKind('เช็กภาษี')).toBeNull();
  });

  it('รถเก๋งบุคคล 1496 ซีซี ปีที่ 9 ลด 40% · นิติบุคคลเป็นสองเท่า', () => {
    // 600 x 0.5 + 896 x 1.5 = 1,644 -> ลด 40% = 986.40
    const person = run('car', ['1496', 'บุคคลธรรมดา', '15/03/2562', 'ยังไม่ขาด']);
    expect(person.done).toBe(true);
    expect(person.text).toContain('ภาษีประจำปี 986.40 บาท (รถปีที่ 9 ลด 40% แล้ว)');
    expect(person.text).toContain('ครบกำหนดครั้งถัดไปประมาณ 15/03/2570');
    expect(person.text).toContain('ตรอ.: ต้องตรวจสภาพก่อนต่อภาษี');

    const company = run('car', ['1,496 cc', 'นิติบุคคล', '15/03/2562', 'ยังไม่ขาด']);
    expect(company.text).toContain('ภาษีประจำปี 1,972.80 บาท');
    expect(company.text).toContain('นิติบุคคล ภาษีเป็นสองเท่า');
  });

  it('รถยนต์ไฟฟ้าคิดตามน้ำหนัก ไม่มีส่วนลดอายุรถ', () => {
    const ev = run('ev', ['1750', 'บุคคลธรรมดา', '20/01/2567', 'ยังไม่ขาด']);
    expect(ev.text).toContain('รถยนต์ไฟฟ้า (EV) 1,750 กก.');
    expect(ev.text).toContain('ภาษีประจำปี 1,300.00 บาท');
    expect(ev.text).toContain('ตรอ.: ยังไม่ต้องตรวจสภาพ');
  });

  it('กระบะและมอเตอร์ไซค์ไม่ถามเจ้าของ · ขาดต่อคิดเงินเพิ่มเดือนละ 1%', () => {
    expect(run('pickup', ['1600', '10/10/2560', 'ยังไม่ขาด']).text).toContain('ภาษีประจำปี 1,050.00 บาท');
    const late = run('moto', ['05/05/2565', '05/05/2569']);
    expect(late.text).toContain('เงินเพิ่มล่าช้า 6 เดือน 6.00 บาท');
    expect(late.text).toContain('รวมชำระกรมการขนส่ง 106.00 บาท');
  });

  it('ค้างหลายปี แสดงทีละงวดและยอดรวม', () => {
    const text = run('car', ['2393', 'บุคคลธรรมดา', '01/06/2558', '01/06/2567']).text;
    expect(text).toContain('ค้างภาษี 3 ปี');
    expect(text).toContain('รวมชำระกรมการขนส่ง 7,848.36 บาท');
  });

  it('คำตอบผิดรูปแบบ = ถามข้อเดิมซ้ำพร้อมบอกสาเหตุ ไม่ข้ามข้อ', () => {
    let step = startTax('car', today, rules);
    step = answerTax(step.session!, { typed: 'ไม่รู้' }, today, rules);
    expect(step.session).toEqual({ kind: 'car' });
    expect(bodyOf(step.message)).toContain('อ่านขนาดเครื่องยนต์ไม่ได้');
    step = answerTax(step.session!, { typed: '1500' }, today, rules);
    step = answerTax(step.session!, { typed: 'ครับ' }, today, rules);
    expect(bodyOf(step.message)).toContain('กรุณากดเลือก');
    step = answerTax(step.session!, { typed: 'บุคคลธรรมดา' }, today, rules);
    step = answerTax(step.session!, { typed: '15/03/2575' }, today, rules);
    expect(bodyOf(step.message)).toContain('วันจดทะเบียนต้องไม่เกินวันนี้');
    step = answerTax(step.session!, { pickedDate: '2019-03-15' }, today, rules);
    expect(step.session).toEqual({ kind: 'car', amount: 1500, owner: 'person', registered: '2019-03-15' });
    step = answerTax(step.session!, { typed: '01/01/2560' }, today, rules);
    expect(bodyOf(step.message)).toContain('วันสิ้นอายุภาษีต้องอยู่หลังวันจดทะเบียน');
  });

  it('รถที่ยังไม่มีอัตราในระบบ (มอเตอร์ไซค์ไฟฟ้า) บอกตั้งแต่แรก ไม่ถามต่อ', () => {
    const step = startTax('emoto', today, rules);
    expect(step.session).toBeNull();
    expect(bodyOf(step.message)).toContain('ยังคำนวณภาษีของมอเตอร์ไซค์ไฟฟ้า');
  });

  it('วันครบกำหนดครั้งถัดไป = วันครบรอบวันจดทะเบียนที่ยังไม่ผ่าน', () => {
    expect(nextAnniversary('2019-03-15', today)).toBe('2027-03-15');
    expect(nextAnniversary('2019-10-09', today)).toBe('2026-10-09');
    expect(nextAnniversary('2026-10-09', today)).toBe('2027-10-09');
    expect(nextAnniversary('2020-02-29', '2026-03-01')).toBe('2027-02-28');
  });
});

describe('ทางเดินของข้อความระหว่างเช็กค่าภาษี', () => {
  const text = (value: string): LineEvent => ({ type: 'message', message: { type: 'text', text: value } });
  const session: TaxSession = { kind: 'car' };

  it('เช็กภาษี = การ์ดเลือกประเภทรถ · เลือกแล้วเริ่มถาม', () => {
    expect(routeEvent(text('เช็กภาษี'), today, null, rules)).toMatchObject({ session: null, message: { type: 'flex', altText: expect.stringContaining('เช็กค่าภาษี') } });
    expect(routeEvent(text('ภาษี เก๋ง'), today, null, rules).session).toEqual({ kind: 'car' });
  });

  it('ระหว่างถาม ตัวเลขคือคำตอบ · กดแถบเมนู ถาม ตรอ. หรือยกเลิก = ออกจากการเช็ก', () => {
    expect(routeEvent(text('1496'), today, session, rules).session).toEqual({ kind: 'car', amount: 1496 });
    expect(routeEvent(text('โอนรถ'), today, session, rules)).toMatchObject({ session: null, message: { altText: 'เอกสารโอนรถ' } });
    expect(routeEvent(text('ตรอ'), today, session, rules).session).toBeNull();
    expect(bodyOf(routeEvent(text('ยกเลิก'), today, session, rules).message)).toContain('ยกเลิกการเช็กค่าภาษีแล้ว');
    expect(routeEvent({ type: 'message', message: { type: 'sticker' } }, today, session, rules)).toEqual({ message: null, session });
  });

  it('ไม่ได้ค้างการเช็กอยู่ ตัวเลขเฉยๆ ได้การ์ดทักทาย · ปฏิทินที่หมดเวลาแล้วบอกให้เริ่มใหม่', () => {
    expect(routeEvent(text('1496'), today, null, null)).toMatchObject({ session: null, message: { altText: expect.stringContaining('Jitkusol Auto') } });
    const expired = routeEvent({ type: 'postback', postback: { data: 'tax:date', params: { date: '2019-03-15' } } }, today, null, rules);
    expect(bodyOf(expired.message)).toContain('พิมพ์ เช็กภาษี เพื่อเริ่มใหม่');
  });

  it('โหลดอัตราภาษีไม่ได้ = ขออภัย ไม่เดายอด', () => {
    expect(bodyOf(routeEvent(text('1496'), today, session, null).message)).toContain('เช็กค่าภาษีไม่ได้ชั่วคราว');
  });
});

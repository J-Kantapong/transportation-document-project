import { describe, expect, it } from 'vitest';
import {
  affectedSteps,
  changedStepFields,
  impactConfirmKey,
  isImpactConfirmed,
  needsTaxPreview,
  ownerNameChanged,
  ownerTaxChanged,
  type VehicleStepState,
} from './vehicle-edit-impact.js';

// แก้ข้อมูลรถหลังขั้นตอนถัดไปใช้ข้อมูลเดิมไปแล้ว (ผู้ใช้ 2026-09-27): เตือนอย่างเดียว ไม่คิดใหม่ให้อัตโนมัติ

const base = {
  registrationProvince: 'กรุงเทพมหานคร',
  ownerProvince: 'กรุงเทพมหานคร',
  body: 'รย.1-เก๋ง 2 ตอน',
  brandId: 'b1',
  fuel: 'เบนซิน',
  cc: '1598.00',
  weight: null,
  customerId: 'c1',
};

const nothingDone: VehicleStepState = {
  transferDone: false,
  inspectionSent: false,
  submissionStatus: null,
  delivered: false,
  billed: false,
};

describe('changedStepFields', () => {
  it('CC/น้ำหนักเทียบเป็นตัวเลข ช่องที่ไม่ใช้ในขั้นตอนถัดไปไม่นับ', () => {
    expect(changedStepFields(base, { ...base, cc: '1598' }, false)).toEqual([]);
    expect(changedStepFields(base, { ...base, cc: '2598' }, false)).toEqual(['cc']);
    expect(changedStepFields(base, { ...base, weight: '' }, false)).toEqual([]);
    expect(changedStepFields(base, { ...base, registrationProvince: 'นนทบุรี', customerId: 'c2' }, true)).toEqual([
      'registrationProvince',
      'owner',
      'customerId',
    ]);
    // ชื่อเจ้าของนับแยกจากส่วนที่มีผลกับภาษี (ผู้ใช้ 2026-09-27 รอบตรวจ)
    expect(changedStepFields(base, base, false, true)).toEqual(['ownerName']);
    expect(changedStepFields(base, base, true, true)).toEqual(['owner', 'ownerName']);
  });
});

describe('ownerNameChanged', () => {
  it('ชื่อผู้ถือกรรมสิทธิ์/ไฟแนนซ์ หรือชื่อผู้ครอบครองเปลี่ยน = เปลี่ยน ช่องว่างกับ null เท่ากัน', () => {
    const owner = { name: 'นายเอ', hirerName: null };
    expect(ownerNameChanged(owner, { name: 'นายเอ', hirerName: '' })).toBe(false);
    expect(ownerNameChanged(owner, { name: 'นายบี', hirerName: null })).toBe(true);
    expect(ownerNameChanged({ name: 'ลีสซิ่ง ก', hirerName: 'นายเอ' }, { name: 'ลีสซิ่ง ก', hirerName: 'นายบี' })).toBe(true);
    expect(ownerNameChanged(null, { name: null, hirerName: null })).toBe(false);
    expect(ownerNameChanged(null, owner)).toBe(true);
  });
});

describe('ownerTaxChanged', () => {
  const individual = { ownerType: 'INDIVIDUAL', isHirePurchaseBusiness: false, hirerType: null };
  it('นับเฉพาะส่วนที่มีผลกับภาษี ไม่มีเจ้าของเดิม = เปลี่ยน', () => {
    expect(ownerTaxChanged(individual, { ...individual })).toBe(false);
    expect(ownerTaxChanged(individual, { ownerType: 'JURISTIC', isHirePurchaseBusiness: false, hirerType: null })).toBe(true);
    expect(ownerTaxChanged(individual, { ownerType: 'JURISTIC', isHirePurchaseBusiness: true, hirerType: 'INDIVIDUAL' })).toBe(true);
    expect(ownerTaxChanged(null, individual)).toBe(true);
  });
});

describe('affectedSteps', () => {
  it('ยังไม่มีขั้นตอนไหนใช้ข้อมูล = แก้ได้เลยไม่ต้องเตือน', () => {
    expect(affectedSteps(['registrationProvince', 'body', 'customerId'], nothingDone, base, base)).toEqual([]);
  });

  it('แจ้งย้าย/ตัดบัญชีเสร็จแล้ว เปลี่ยนจังหวัดจนขั้นตอนเปลี่ยน บอกว่าเป็นของขั้นตอนเดิม และชี้ไป ✎ แก้', () => {
    const [step] = affectedSteps(['registrationProvince'], { ...nothingDone, transferDone: true }, base, {
      ...base,
      registrationProvince: 'นนทบุรี',
    });
    expect(step.step).toBe('transfer');
    expect(step.fields).toEqual(['จังหวัดที่จดทะเบียน']);
    expect(step.note).toContain('ขั้นตอนเปลี่ยนจากตัดบัญชีเป็นแจ้งย้าย');
    expect(step.note).toContain('แก้หรือยกเลิกสถานะได้ที่หน้าแจ้งย้าย/ตัดบัญชี (✎ แก้)');
  });

  it('ส่งตรวจแล้ว: ยกเลิกสถานะแจ้งย้ายไม่ได้ และถ้ายังรอผลชี้ไปแก้การส่งตรวจเพื่อคิดค่าตรวจใหม่', () => {
    const state = { ...nothingDone, transferDone: true, inspectionSent: true, inspectionResultPending: true };
    const steps = affectedSteps(['body'], state, base, { ...base, body: 'รย.1-เก๋ง 4 ตอน' });
    expect(steps.map((s) => s.step)).toEqual(['transfer', 'inspection']);
    expect(steps[0].note).toContain('ส่งตรวจแล้วจึงยกเลิกสถานะไม่ได้');
    expect(steps[1].label).toBe('ตรวจรถ (ส่งตรวจแล้ว รอผล)');
    expect(steps[1].note).toContain('"แก้การส่งตรวจ"');

    const withResult = affectedSteps(['body'], { ...state, inspectionResultPending: false }, base, { ...base, body: 'รย.1-เก๋ง 4 ตอน' });
    expect(withResult[1].note).toBe('ค่าตรวจรถที่บันทึกไว้คิดจากข้อมูลเดิม ระบบไม่คิดใหม่ให้');
  });

  it('รายการยื่นรอใบเสร็จ: ชี้ให้ยกเลิกแล้วยื่นใหม่ที่หน้า ดูข้อมูลที่ยื่นแล้ว พร้อมวันที่ยื่น', () => {
    const state = { ...nothingDone, transferDone: true, inspectionSent: true, submissionStatus: 'PENDING', submitDate: '2026-09-20' };
    const steps = affectedSteps(['cc'], state, base, base);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      step: 'submission',
      label: 'ยื่นเอกสาร (รอใบเสร็จ)',
      fields: ['ขนาด CC'],
      submissionStatus: 'PENDING',
      submitDate: '2026-09-20',
    });
    expect(steps[0].note).toContain('(ยื่นวันที่ 20/09/2026)');
    expect(steps[0].note).toContain('ยกเลิกรายการยื่นแล้วยื่นใหม่ที่หน้า ดูข้อมูลที่ยื่นแล้ว');
  });

  it('ได้ใบเสร็จแล้ว / เปลี่ยนรถยนต์เป็นจักรยานยนต์ / เปลี่ยนลูกค้า บอกผลแต่ละอย่าง', () => {
    const state = { ...nothingDone, transferDone: true, inspectionSent: true, submissionStatus: 'RECEIPT_RECEIVED' };
    const [step] = affectedSteps(['body', 'customerId'], state, base, { ...base, body: 'รย.12-รถจักรยานยนต์' }).filter(
      (s) => s.step === 'submission',
    );
    expect(step.label).toBe('ยื่นเอกสาร (ได้ใบเสร็จแล้ว)');
    expect(step.note).toContain('ยกเลิกรายการยื่นไม่ได้แล้ว');
    expect(step.note).toContain('รถจะย้ายไปอยู่คิวและใบส่งงานของอีกประเภท');
    expect(step.note).toContain('รายการยื่นจะไปอยู่ใต้ลูกค้าใหม่');
  });

  it('เปลี่ยนลูกค้าอย่างเดียวตอนรอใบเสร็จ ไม่บอกว่าค่าธรรมเนียม/ภาษีผิด และไม่ชี้ให้ยกเลิกแล้วยื่นใหม่ (repriceable = false)', () => {
    const state = { ...nothingDone, transferDone: true, submissionStatus: 'PENDING' };
    const [step] = affectedSteps(['customerId'], state, base, base);
    expect(step.note).toBe('รายการยื่นจะไปอยู่ใต้ลูกค้าใหม่ ใบส่งงานที่พิมพ์ไปแล้วยังเป็นชื่อเดิม');
    expect(step.repriceable).toBe(false);
    expect(affectedSteps(['cc'], state, base, base)[0].repriceable).toBe(true);
    // ได้ใบเสร็จแล้วยกเลิกไม่ได้ = ไม่ชี้ไปยกเลิกเสมอ
    expect(affectedSteps(['cc'], { ...state, submissionStatus: 'RECEIPT_RECEIVED' }, base, base)[0].repriceable).toBe(false);
  });

  // ใบส่งงานอ่านข้อมูลรถตอนพิมพ์ (ผู้ใช้ 2026-09-27 รอบตรวจ): รถยนต์พิมพ์ยี่ห้อ จักรยานยนต์พิมพ์ชื่อเจ้าของ
  it('ยื่นแล้วแก้ยี่ห้อรถยนต์ / ชื่อเจ้าของจักรยานยนต์: เตือนว่าใบส่งงานพิมพ์ใหม่ไม่ตรง แต่ไม่ชี้ให้ยกเลิกแล้วยื่นใหม่', () => {
    const state = { ...nothingDone, submissionStatus: 'PENDING', submitDate: '2026-09-20' };
    const [car] = affectedSteps(['brandId'], state, base, base);
    expect(car).toMatchObject({ step: 'submission', fields: ['ยี่ห้อ'], repriceable: false });
    expect(car.note).toBe('ใบส่งงานที่พิมพ์ใหม่จะแสดงข้อมูลใหม่ ไม่ตรงกับใบที่ยื่นไปแล้ว');

    const moto = { ...base, body: 'รย.12-รถจักรยานยนต์' };
    const [bike] = affectedSteps(['ownerName'], state, moto, moto);
    expect(bike).toMatchObject({ step: 'submission', fields: ['ชื่อเจ้าของรถ'], repriceable: false });
    expect(bike.note).toContain('ใบส่งงานที่พิมพ์ใหม่จะแสดงข้อมูลใหม่');
  });

  it('ยื่นแล้วแก้ช่องที่ใบส่งงานของรถคันนั้นไม่ได้พิมพ์ (ชื่อเจ้าของรถยนต์ / ยี่ห้อจักรยานยนต์) = ไม่เตือนขั้นยื่นเอกสาร', () => {
    const state = { ...nothingDone, submissionStatus: 'PENDING' };
    expect(affectedSteps(['ownerName'], state, base, base)).toEqual([]);
    const moto = { ...base, body: 'รย.12-รถจักรยานยนต์' };
    expect(affectedSteps(['brandId'], state, moto, moto)).toEqual([]);
  });

  it('ส่งงานแล้ว / วางบิลแล้ว / ปิดงาน - วางบิลนอกระบบ: เตือนเมื่อเปลี่ยนลูกค้า (และชื่อเจ้าของสำหรับใบส่งงาน)', () => {
    const state = { ...nothingDone, transferDone: true, submissionStatus: 'RECEIPT_RECEIVED', delivered: true, billed: true };
    expect(affectedSteps(['cc'], state, base, base).map((s) => s.step)).toEqual(['submission']);
    expect(affectedSteps(['customerId'], state, base, base).map((s) => s.step)).toEqual(['submission', 'delivery', 'billing']);
    const closed = affectedSteps(['customerId'], { ...state, billed: false, billingClosed: true }, base, base).find((s) => s.step === 'billing');
    expect(closed?.label).toBe('วางบิล (ปิดงาน - วางบิลนอกระบบ)');
    // ชื่อเจ้าของในใบส่งงาน (Delivery) อ่านตอนพิมพ์ - รถยนต์ไม่มีชื่อในใบส่งงานยื่นเอกสาร จึงเตือนแค่ขั้นส่งงาน
    const [delivery] = affectedSteps(['ownerName'], state, base, base);
    expect(delivery).toMatchObject({ step: 'delivery', fields: ['ชื่อเจ้าของรถ'] });
    expect(delivery.note).toBe('ใบส่งงานที่พิมพ์ซ้ำจะแสดงชื่อเจ้าของใหม่ ไม่ตรงกับใบที่ลูกค้าเซ็นรับไปแล้ว');
  });
});

describe('needsTaxPreview', () => {
  it('เฉพาะรายการยื่นที่รอใบเสร็จ และช่องที่ใช้คิดภาษีเปลี่ยน', () => {
    const pending = { ...nothingDone, submissionStatus: 'PENDING' };
    expect(needsTaxPreview(['cc'], pending)).toBe(true);
    expect(needsTaxPreview(['owner'], pending)).toBe(true);
    expect(needsTaxPreview(['customerId', 'registrationProvince'], pending)).toBe(false);
    expect(needsTaxPreview(['cc'], { ...pending, submissionStatus: 'RECEIPT_RECEIVED' })).toBe(false);
  });
});

describe('isImpactConfirmed', () => {
  const affected = affectedSteps(['cc'], { ...nothingDone, submissionStatus: 'PENDING' }, base, base);
  const keys = affected.map((a) => a.confirmKey);

  it('ไม่มีผลกระทบ = ผ่าน / มีผลกระทบต้องส่ง confirm: true', () => {
    expect(isImpactConfirmed([], undefined, undefined)).toBe(true);
    expect(isImpactConfirmed(affected, undefined, undefined)).toBe(false);
    expect(isImpactConfirmed(affected, 'true', keys)).toBe(false);
    expect(isImpactConfirmed(affected, true, undefined)).toBe(true);
  });

  it('มีขั้นตอนที่กระทบเพิ่มจากที่ผู้ใช้เห็นในคำเตือน = ต้องเตือนใหม่', () => {
    expect(isImpactConfirmed(affected, true, keys)).toBe(true);
    expect(isImpactConfirmed(affected, true, ['transfer'])).toBe(false);
    // ส่งแค่ชื่อขั้นตอนแบบเดิมไม่พอแล้ว ต้องเป็น confirmKey ของคำเตือนที่เห็น
    expect(isImpactConfirmed(affected, true, ['submission'])).toBe(false);
  });

  it('สถานะของขั้นตอนเดิมเปลี่ยนระหว่างนั้น (รอใบเสร็จ -> ได้ใบเสร็จแล้ว) = คีย์ไม่ตรง ต้องเตือนใหม่ (ผู้ใช้ 2026-09-27 รอบตรวจ)', () => {
    const received = affectedSteps(['cc'], { ...nothingDone, submissionStatus: 'RECEIPT_RECEIVED' }, base, base);
    expect(received.map((a) => a.step)).toEqual(['submission']);
    expect(isImpactConfirmed(received, true, keys)).toBe(false);
    // ข้อมูลชุดเดียวกัน = คีย์เดิม (คำนวณซ้ำได้ตรงกัน)
    expect(affectedSteps(['cc'], { ...nothingDone, submissionStatus: 'PENDING' }, base, base)[0].confirmKey).toBe(keys[0]);
    expect(keys[0]).toBe(impactConfirmKey(affected[0]));
    expect(keys[0]).toMatch(/^submission:[0-9a-f]{16}$/);
  });
});

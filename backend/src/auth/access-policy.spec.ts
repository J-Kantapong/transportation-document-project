import { accessFor, isAllowed } from './access-policy.js';

// Express จับ route แบบไม่สนตัวพิมพ์ - ตารางสิทธิ์ต้องเทียบแบบเดียวกัน ไม่งั้นพิมพ์ URL ตัวใหญ่แล้วข้ามการตรวจได้
describe('access policy path matching', () => {
  it('applies the same rule whatever the letter case of the path', () => {
    expect(accessFor('/API/admin/users', 'GET')).toEqual(['ADMIN']);
    expect(isAllowed(accessFor('/api/Admin/users/x', 'PATCH'), ['STAFF_ENTRY'])).toBe(false);
    expect(isAllowed(accessFor('/api/Overview', 'GET'), ['STAFF_CAR'])).toBe(false);
    expect(isAllowed(accessFor('/Api/Vehicles', 'GET'), null)).toBe(false);
  });

  it('ignores repeated and trailing slashes and percent-encoding', () => {
    expect(accessFor('/api//admin/users/', 'GET')).toEqual(['ADMIN']);
    expect(accessFor('/api/%61dmin/users', 'GET')).toEqual(['ADMIN']);
    expect(accessFor('/api/%E0%A4%A', 'GET')).toEqual(['ADMIN']);
  });

  it('keeps login, register and the health check public and closes everything else by default', () => {
    expect(accessFor('/api/auth/login', 'POST')).toBe('PUBLIC');
    expect(accessFor('/API/AUTH/REGISTER', 'POST')).toBe('PUBLIC');
    expect(accessFor('/', 'GET')).toBe('PUBLIC');
    expect(accessFor('/API', 'GET')).not.toBe('PUBLIC');
    expect(accessFor('/something-else', 'GET')).toEqual(['ADMIN']);
  });
});

describe('access policy step 4-8 rules', () => {
  it('lets accounting read a vehicle tax calculation but not the step 1-3 writes', () => {
    expect(isAllowed(accessFor('/api/vehicles/v1/tax-calculations', 'GET'), ['ACCOUNTANT'])).toBe(true);
    expect(isAllowed(accessFor('/api/vehicles/v1/tax-calculations', 'GET'), ['DELIVERY'])).toBe(false);
    expect(isAllowed(accessFor('/api/vehicles/v1/inspection-result', 'PATCH'), ['STAFF_CAR'])).toBe(false);
  });

  // ใบส่งงาน: DELIVERY อ่านได้ แต่แก้ / ยกเลิก / ส่งป้ายตามไปไม่ได้ (ผู้ใช้ 2026-09-26)
  it('keeps slip changes to ADMIN / STAFF_CAR / STAFF_MOTO', () => {
    expect(isAllowed(accessFor('/api/delivery/slips/s1', 'GET'), ['DELIVERY'])).toBe(true);
    expect(isAllowed(accessFor('/api/delivery/slips/s1/add-plate', 'POST'), ['DELIVERY'])).toBe(false);
    expect(isAllowed(accessFor('/api/delivery/slips/s1/cancel', 'POST'), ['DELIVERY'])).toBe(false);
    expect(isAllowed(accessFor('/api/delivery/slips/s1/add-plate', 'POST'), ['STAFF_MOTO'])).toBe(true);
    expect(isAllowed(accessFor('/api/delivery', 'POST'), ['DELIVERY'])).toBe(true);
  });

  // ผู้ใช้ 2026-09-27: บัญชีอ่านรายงานส่งงาน (ใบส่งงาน + ป้ายค้างส่ง) ได้ แต่ไม่เห็นคิว Delivery และบันทึก/แก้/ยกเลิกไม่ได้
  // ผู้ใช้ 2026-10-08 (ตัวช่วยกันลืม ชั้น 2): บัญชีอ่านคิวส่งงานและบันทึกส่งงานที่พนักงานลืมได้จากหน้าวางบิล แต่แก้/ยกเลิกใบไม่ได้
  it('lets accounting read the delivery report, read the queue and record a delivery, but not change a slip', () => {
    const accountant: ['ACCOUNTANT'] = ['ACCOUNTANT'];
    expect(isAllowed(accessFor('/api/delivery/slips', 'GET'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/delivery/slips/s1', 'GET'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/delivery/plate-pending', 'GET'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/delivery/queue', 'GET'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/delivery/recent', 'GET'), accountant)).toBe(false);
    expect(isAllowed(accessFor('/api/delivery', 'POST'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/delivery/slips/s1', 'PATCH'), accountant)).toBe(false);
    expect(isAllowed(accessFor('/api/delivery/slips/s1/cancel', 'POST'), accountant)).toBe(false);
    expect(isAllowed(accessFor('/api/delivery/slips/s1/add-plate', 'POST'), accountant)).toBe(false);
    // บทบาทเดิมยังเหมือนเดิม
    expect(isAllowed(accessFor('/api/delivery/plate-pending', 'GET'), ['DELIVERY'])).toBe(true);
    expect(isAllowed(accessFor('/api/delivery/plate-pending', 'GET'), ['STAFF_ENTRY'])).toBe(false);
    expect(isAllowed(accessFor('/api/delivery/queue', 'GET'), ['STAFF_MOTO'])).toBe(true);
  });
});

// ผู้ใช้ 2026-09-27: แก้ข้อมูลลูกค้า และตั้งรหัสผ่านชั่วคราวให้ผู้ใช้ - ADMIN เท่านั้น
describe('access policy admin corrections', () => {
  it('keeps customer edits and temporary passwords to ADMIN', () => {
    expect(accessFor('/api/customers/c1', 'PATCH')).toEqual(['ADMIN']);
    expect(isAllowed(accessFor('/api/customers', 'GET'), ['ACCOUNTANT'])).toBe(true);
    expect(isAllowed(accessFor('/api/customers/c1', 'PATCH'), ['ACCOUNTANT'])).toBe(false);
    expect(isAllowed(accessFor('/api/customers/c1', 'PATCH'), ['STAFF_ENTRY'])).toBe(false);
    // ประวัติการแก้ไขลูกค้า: ADMIN เท่านั้น (รายการลูกค้าทั้งหมดยังเปิดให้พนักงานทุกฝ่ายอ่าน)
    expect(accessFor('/api/customers/c1/history', 'GET')).toEqual(['ADMIN']);
    expect(isAllowed(accessFor('/api/customers/c1/history', 'GET'), ['ACCOUNTANT'])).toBe(false);
    expect(accessFor('/api/admin/users/u1/password', 'PATCH')).toEqual(['ADMIN']);
    expect(isAllowed(accessFor('/API/Admin/Users/u1/password', 'PATCH'), ['STAFF_CAR'])).toBe(false);
  });
});

// ผู้ใช้ 2026-09-27: บัญชีแก้บิล / ยกเลิกการรับเงิน / ปิดงาน - วางบิลนอกระบบได้ แต่เปิดงานที่ปิดไว้กลับได้เฉพาะ ADMIN
describe('access policy billing corrections', () => {
  it('lets ADMIN and ACCOUNTANT correct invoices and close billing, and keeps reopening to ADMIN', () => {
    const accountant: ['ACCOUNTANT'] = ['ACCOUNTANT'];
    expect(isAllowed(accessFor('/api/billing/invoices/i1', 'PATCH'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/billing/invoices/i1/unpay', 'PATCH'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/billing/invoices/i1/history', 'GET'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/billing/vehicles/v1/close', 'POST'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/billing/vehicles/closed', 'GET'), accountant)).toBe(true);
    expect(isAllowed(accessFor('/api/billing/vehicles/v1/reopen', 'POST'), accountant)).toBe(false);
    expect(isAllowed(accessFor('/API/Billing/Vehicles/v1/Reopen/', 'POST'), accountant)).toBe(false);
    expect(isAllowed(accessFor('/api/billing/vehicles/v1/reopen', 'POST'), ['ADMIN'])).toBe(true);
    expect(isAllowed(accessFor('/api/billing/invoices/i1/unpay', 'PATCH'), ['STAFF_CAR'])).toBe(false);
  });
});

// ผู้ใช้ 2026-09-27: "✎ แก้" แจ้งย้าย/ตัดบัญชีที่ดำเนินการแล้ว สิทธิ์เดียวกับการบันทึก (ENTRY + STAFF_MOTO ที่ service กรองจักรยานยนต์)
describe('access policy transfer-notice correction', () => {
  it('uses the transfer-notice write rule for /correct', () => {
    const correct = accessFor('/api/vehicles/v1/transfer-notice/correct', 'PATCH');
    expect(correct).toEqual(accessFor('/api/vehicles/v1/transfer-notice', 'PATCH'));
    expect(isAllowed(correct, ['STAFF_ENTRY'])).toBe(true);
    expect(isAllowed(correct, ['STAFF_MOTO'])).toBe(true);
    expect(isAllowed(correct, ['STAFF_CAR'])).toBe(false);
    expect(isAllowed(correct, ['ACCOUNTANT'])).toBe(false);
    expect(isAllowed(accessFor('/API/Vehicles/v1/Transfer-Notice/Correct/', 'PATCH'), ['STAFF_CAR'])).toBe(false);
  });
});

// ผู้ใช้ 2026-09-27: แก้/ยกเลิกงานได้เฉพาะพนักงานเจ้าของงาน + ADMIN (ขอบเขตประเภทรถกรองใน service) - ACCOUNTANT อ่านอย่างเดียว
describe('access policy tax renewal / Yamaha / plate swap corrections', () => {
  it('keeps tax-renewal edit and cancel to ADMIN / STAFF_CAR / STAFF_MOTO', () => {
    for (const [path, method] of [
      ['/api/tax-renewals/r1', 'PATCH'],
      ['/api/tax-renewals/r1/cancel', 'POST'],
    ] as const) {
      const access = accessFor(path, method);
      expect(isAllowed(access, ['STAFF_CAR'])).toBe(true);
      expect(isAllowed(access, ['STAFF_MOTO'])).toBe(true);
      expect(isAllowed(access, ['ACCOUNTANT'])).toBe(false);
      expect(isAllowed(access, ['STAFF_ENTRY'])).toBe(false);
    }
  });

  it('keeps Yamaha relocation edit and cancel to ADMIN / STAFF_ENTRY', () => {
    for (const [path, method] of [
      ['/api/yamaha-relocation/e1', 'PATCH'],
      ['/api/yamaha-relocation/e1/cancel', 'POST'],
    ] as const) {
      const access = accessFor(path, method);
      expect(isAllowed(access, ['STAFF_ENTRY'])).toBe(true);
      expect(isAllowed(access, ['ADMIN'])).toBe(true);
      expect(isAllowed(access, ['STAFF_CAR'])).toBe(false);
      expect(isAllowed(access, ['ACCOUNTANT'])).toBe(false);
    }
  });

  it('keeps plate-swap edit, undo-return and cancel off the read-only roles', () => {
    for (const [path, method] of [
      ['/api/plate-swaps/s1', 'PATCH'],
      ['/api/plate-swaps/s1/undo-return', 'POST'],
      ['/api/plate-swaps/s1/cancel', 'POST'],
    ] as const) {
      const access = accessFor(path, method);
      expect(isAllowed(access, ['STAFF_CAR'])).toBe(true);
      expect(isAllowed(access, ['ACCOUNTANT'])).toBe(false);
      expect(isAllowed(access, ['STAFF_ENTRY'])).toBe(false);
    }
  });
});

// ฝ่ายบุคคล / เงินเดือน (ผู้ใช้ 2026-10-05): ข้อมูลส่วนบุคคลและเงินเดือนเห็นได้เฉพาะ ADMIN - กฎ GET ท้ายตารางเปิดให้พนักงานทุกกลุ่มอ่าน จึงต้องมีกฎเฉพาะ
describe('access policy HR / payroll', () => {
  it('keeps every /api/hr route to ADMIN, reads included', () => {
    for (const role of ['STAFF_ENTRY', 'STAFF_CAR', 'STAFF_MOTO', 'ACCOUNTANT', 'DELIVERY', 'CUSTOMER'] as const) {
      expect(isAllowed(accessFor('/api/hr/employees', 'GET'), [role])).toBe(false);
      expect(isAllowed(accessFor('/api/hr/payroll/runs/r1', 'GET'), [role])).toBe(false);
      expect(isAllowed(accessFor('/api/hr/payroll/runs/r1/approve', 'POST'), [role])).toBe(false);
      expect(isAllowed(accessFor('/api/hr/wht', 'GET'), [role])).toBe(false);
      expect(isAllowed(accessFor('/api/hr/suppliers', 'GET'), [role])).toBe(false);
      expect(isAllowed(accessFor('/api/hr/wht/employee-year', 'POST'), [role])).toBe(false);
    }
    expect(isAllowed(accessFor('/api/hr/employees', 'GET'), ['ADMIN'])).toBe(true);
    expect(isAllowed(accessFor('/API/HR/Payroll/runs', 'POST'), ['ADMIN'])).toBe(true);
    expect(isAllowed(accessFor('/API/HR/Employees', 'GET'), ['ACCOUNTANT'])).toBe(false);
  });

  // ลายเซ็นบนใบเสนอราคา: อ่านผ่าน /api/billing (ADMIN + ACCOUNTANT) แต่ตั้ง/ลบผ่าน /api/hr (ADMIN เท่านั้น)
  it('lets accounting read the print signature but only ADMIN change it', () => {
    expect(isAllowed(accessFor('/api/billing/print-signature', 'GET'), ['ACCOUNTANT'])).toBe(true);
    expect(isAllowed(accessFor('/api/billing/print-signature', 'GET'), ['STAFF_CAR'])).toBe(false);
    expect(isAllowed(accessFor('/api/hr/payslip-signature', 'PUT'), ['ACCOUNTANT'])).toBe(false);
    expect(isAllowed(accessFor('/api/hr/payslip-signature', 'DELETE'), ['ACCOUNTANT'])).toBe(false);
    expect(isAllowed(accessFor('/api/hr/payslip-signature', 'PUT'), ['ADMIN'])).toBe(true);
  });
});

// เลขาส่วนตัว (ผู้ใช้ 2026-10-07): webhook ของ LINE เปิดสาธารณะ (ตรวจลายเซ็นใน controller) route อื่นใต้ /api/secretary = ADMIN
describe('access policy secretary (LINE webhook)', () => {
  it('opens only the signed LINE webhook to the public', () => {
    expect(accessFor('/api/secretary/webhook', 'POST')).toBe('PUBLIC');
    expect(accessFor('/API/Secretary/Webhook/', 'POST')).toBe('PUBLIC');
    expect(accessFor('/api/secretary/webhook/extra', 'POST')).toEqual(['ADMIN']);
    expect(accessFor('/api/secretary/run', 'POST')).toBe('PUBLIC'); // ตัวตั้งเวลา GitHub Actions - ตรวจกุญแจใน controller
    expect(accessFor('/api/secretary/run/x', 'POST')).toEqual(['ADMIN']);
    expect(accessFor('/api/secretary/anything', 'POST')).toEqual(['ADMIN']);
    expect(isAllowed(accessFor('/api/secretary/anything', 'POST'), ['STAFF_ENTRY'])).toBe(false);
    expect(isAllowed(accessFor('/api/secretary/anything', 'GET'), ['ACCOUNTANT'])).toBe(false);
  });
});

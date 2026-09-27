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

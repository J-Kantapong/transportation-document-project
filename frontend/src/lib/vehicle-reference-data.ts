// Mirrors backend/src/vehicles/vehicle-reference-data.ts, itself ported from
// prototype/sites-reference/shared/vehicle-data.js. Frontend and backend are separate
// deployables here, so this list is intentionally duplicated — keep both in sync.

export const FUEL_TYPES = ['น้ำมัน', 'ดีเซล', 'LPG', 'NGV', 'ไฮบริด', 'ไฟฟ้า'] as const;

export const VEHICLE_TYPES = [
  'รย.12-น้อยกว่า 300cc',
  'รย.12-300-799cc',
  'รย.12-800-999cc',
  'รย.12-1000cc ขึ้นไป',
  'รย.1-เก๋ง 2 ตอน',
  'รย.1-นั่ง 2 ตอน',
  'รย.1-นั่ง 3 ตอน',
  'รย.2-นั่ง 2 แถว',
  'รย.2-นั่ง 4 ตอน',
  'รย.3-กระบะบรรทุก',
  'รย.3-กระบะบรรทุกมีหลังคา',
  'รย.3-กระบะบรรทุกมีหลังคาแหนบ',
  'รย.3-ตู้บรรทุก',
] as const;

// Province names: Ministry of Commerce, referencing DOPA, https://std.moc.go.th/std/group/28
export const PROVINCES = [
  'กรุงเทพมหานคร', 'สมุทรปราการ', 'นนทบุรี', 'ปทุมธานี', 'พระนครศรีอยุธยา', 'อ่างทอง', 'ลพบุรี', 'สิงห์บุรี',
  'ชัยนาท', 'สระบุรี', 'ชลบุรี', 'ระยอง', 'จันทบุรี', 'ตราด', 'ฉะเชิงเทรา', 'ปราจีนบุรี', 'นครนายก', 'สระแก้ว',
  'นครราชสีมา', 'บุรีรัมย์', 'สุรินทร์', 'ศรีสะเกษ', 'อุบลราชธานี', 'ยโสธร', 'ชัยภูมิ', 'อำนาจเจริญ', 'บึงกาฬ',
  'หนองบัวลำภู', 'ขอนแก่น', 'อุดรธานี', 'เลย', 'หนองคาย', 'มหาสารคาม', 'ร้อยเอ็ด', 'กาฬสินธุ์', 'สกลนคร',
  'นครพนม', 'มุกดาหาร', 'เชียงใหม่', 'ลำพูน', 'ลำปาง', 'อุตรดิตถ์', 'แพร่', 'น่าน', 'พะเยา', 'เชียงราย',
  'แม่ฮ่องสอน', 'นครสวรรค์', 'อุทัยธานี', 'กำแพงเพชร', 'ตาก', 'สุโขทัย', 'พิษณุโลก', 'พิจิตร', 'เพชรบูรณ์',
  'ราชบุรี', 'กาญจนบุรี', 'สุพรรณบุรี', 'นครปฐม', 'สมุทรสาคร', 'สมุทรสงคราม', 'เพชรบุรี', 'ประจวบคีรีขันธ์',
  'นครศรีธรรมราช', 'กระบี่', 'พังงา', 'ภูเก็ต', 'สุราษฎร์ธานี', 'ระนอง', 'ชุมพร', 'สงขลา', 'สตูล', 'ตรัง',
  'พัทลุง', 'ปัตตานี', 'ยะลา', 'นราธิวาส',
] as const;

export const VEHICLE_COLUMNS = [
  ['date', 'วันที่'],
  ['customerId', 'ชื่อลูกค้า'],
  ['chassis', 'เลขตัวถัง'],
  ['engine', 'เลขเครื่อง'],
  ['brandId', 'ยี่ห้อ'],
  ['fuel', 'ประเภทเชื้อเพลิง'],
  ['cc', 'ขนาด CC'],
  ['weight', 'น้ำหนักรถ'],
  ['color', 'สี'],
  ['body', 'ประเภทรถ'],
  ['registrationProvince', 'จังหวัดที่จดทะเบียน'],
  ['ownerProvince', 'จังหวัดเจ้าของรถ'],
] as const;

export type VehicleColumnKey = (typeof VEHICLE_COLUMNS)[number][0];

// Status is derived from จังหวัดที่จดทะเบียน, not stored — Bangkok registrations
// go through ตัดบัญชี, every other province goes through แจ้งย้าย.
export function getVehicleStatus(registrationProvince: string): string {
  if (!registrationProvince) return "—";
  return registrationProvince === "กรุงเทพมหานคร" ? "ตัดบัญชี" : "แจ้งย้าย";
}

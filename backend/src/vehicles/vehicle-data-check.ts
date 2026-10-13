// คำเตือน "ข้อมูลรถน่าจะคีย์ผิด" (ผู้ใช้ 2026-10-13: พบยี่ห้อผิด 10 คัน CC/ประเภทรถผิด 5 คัน เลขตัวถังผิดหลัก 2 คัน)
// - เลขตัวถังปกติมี 17 หลัก ไม่มีตัว I O Q
// - "รุ่นที่รู้จัก": รถในระบบที่เลขตัวถัง 8 ตัวแรกเหมือนกัน (ผู้ผลิต + รุ่น + เครื่อง) ควรมียี่ห้อ / CC / ประเภทรถ เดียวกัน
//   ไม่มีตารางรุ่นให้ดูแล - เรียนจากรถที่คีย์ไว้แล้ว และเชื่อเฉพาะค่าที่คนส่วนใหญ่คีย์ตรงกัน (ดู buildKnownModels)
// เป็นคำเตือน ไม่ใช่ข้อผิดพลาด: ระบบเดาผิดได้ (รถนำเข้าเก่า, รุ่นย่อยที่ใช้เลขขึ้นต้นเดียวกัน) พนักงานตรวจกับเอกสารแล้วยืนยันบันทึกได้
// frontend/src/lib/vehicle-data-check.ts มีสำเนาของส่วนเลขตัวถัง (นับหลักให้เห็นตอนพิมพ์)

export const VIN_LENGTH = 17;
export const MODEL_PREFIX_LENGTH = 8;
// เชื่อค่าของรุ่นเมื่อมีรถอย่างน้อย 3 คันที่คีย์ค่าเดียวกัน และค่านั้นเป็นอย่างน้อย 80% ของรุ่น - กันคันแรกคีย์ผิดแล้วพาคันถัดไปผิดตาม
// และกันรุ่นที่ค่าต่างกันได้จริง (เช่น กระบะรุ่นเดียวกัน มีหลังคา / ไม่มีหลังคา) ไม่ให้เตือนมั่ว
export const MODEL_MIN_VEHICLES = 3;
export const MODEL_MIN_SHARE = 0.8;

export type DataWarningCode = 'CHASSIS_LENGTH' | 'CHASSIS_CHARS' | 'MODEL_BRAND' | 'MODEL_CC' | 'MODEL_BODY';

export interface DataWarning {
  code: DataWarningCode;
  message: string;
  short: string; // ข้อความสั้นไม่มีเลขตัวถัง - ใช้ในรายการรายคันของหน้าภาพรวม
  // ใช้ยืนยัน: หน้าจอส่ง key ของคำเตือนที่เห็นกลับมา - ข้อมูลเปลี่ยนจนคำเตือนเปลี่ยน = key ใหม่ ต้องยืนยันอีกครั้ง
  key: string;
}

export interface ModelSample {
  chassis: string;
  brandId: string;
  brandName: string;
  cc: number | null;
  body: string | null;
}

export interface KnownModel {
  prefix: string;
  count: number; // รถในระบบที่เลขตัวถังขึ้นต้นแบบนี้
  brand: { id: string; name: string } | null; // null = ยังไม่มีค่าที่เชื่อได้
  cc: number | null;
  body: string | null;
}

export const normalizeChassis = (chassis: string) => chassis.toUpperCase().replace(/\s+/g, '');

export function modelPrefix(chassis: string): string | null {
  const value = normalizeChassis(chassis);
  return value.length >= MODEL_PREFIX_LENGTH ? value.slice(0, MODEL_PREFIX_LENGTH) : null;
}

export function chassisWarnings(chassisRaw: string): DataWarning[] {
  const chassis = normalizeChassis(chassisRaw);
  if (!chassis) return [];
  const warnings: DataWarning[] = [];
  if (chassis.length !== VIN_LENGTH) {
    warnings.push({
      code: 'CHASSIS_LENGTH',
      message: `เลขตัวถัง ${chassis} มี ${chassis.length} หลัก (ปกติ ${VIN_LENGTH} หลัก)`,
      short: `เลขตัวถัง ${chassis.length} หลัก (ปกติ ${VIN_LENGTH})`,
      key: `CHASSIS_LENGTH:${chassis}`,
    });
  }
  const odd = Array.from(new Set(chassis.match(/[IOQ]|[^A-Z0-9]/g) ?? []));
  if (odd.length) {
    warnings.push({
      code: 'CHASSIS_CHARS',
      message: `เลขตัวถัง ${chassis} มีตัว ${odd.join(' ')} ซึ่งปกติไม่ใช้ในเลขตัวถัง (I O Q มักเป็น 1 หรือ 0)`,
      short: `เลขตัวถังมีตัว ${odd.join(' ')}`,
      key: `CHASSIS_CHARS:${chassis}`,
    });
  }
  return warnings;
}

// ค่าที่คนส่วนใหญ่คีย์ของช่องหนึ่ง - ไม่ถึงเกณฑ์ = null (ไม่เตือนช่องนั้น)
function trusted<T>(values: T[], keyOf: (value: T) => string): T | null {
  const counts = new Map<string, { value: T; n: number }>();
  for (const value of values) {
    const key = keyOf(value);
    const entry = counts.get(key);
    if (entry) entry.n++;
    else counts.set(key, { value, n: 1 });
  }
  let top: { value: T; n: number } | null = null;
  for (const entry of counts.values()) if (!top || entry.n > top.n) top = entry;
  if (!top || top.n < MODEL_MIN_VEHICLES || top.n < values.length * MODEL_MIN_SHARE) return null;
  return top.value;
}

export function buildKnownModels(samples: ModelSample[]): Map<string, KnownModel> {
  const groups = new Map<string, ModelSample[]>();
  for (const sample of samples) {
    const prefix = modelPrefix(sample.chassis);
    if (!prefix) continue;
    const group = groups.get(prefix);
    if (group) group.push(sample);
    else groups.set(prefix, [sample]);
  }
  const models = new Map<string, KnownModel>();
  for (const [prefix, group] of groups) {
    const brand = trusted(
      group.map((s) => ({ id: s.brandId, name: s.brandName })),
      (b) => b.id,
    );
    const cc = trusted(
      group.flatMap((s) => (s.cc !== null && s.cc > 0 ? [s.cc] : [])),
      (value) => String(value),
    );
    const body = trusted(
      group.flatMap((s) => (s.body ? [s.body] : [])),
      (value) => value,
    );
    if (brand || cc !== null || body) models.set(prefix, { prefix, count: group.length, brand, cc, body });
  }
  return models;
}

export interface CheckedVehicle {
  chassis: string;
  brandId: string;
  cc: string | number | null;
  body: string | null;
}

export function modelWarnings(vehicle: CheckedVehicle, model: KnownModel | undefined, brandNameOf: (id: string) => string): DataWarning[] {
  if (!model) return [];
  const chassis = normalizeChassis(vehicle.chassis);
  const same = `รถ ${model.count} คันที่เลขตัวถังขึ้นต้น ${model.prefix}`;
  const warnings: DataWarning[] = [];
  if (model.brand && vehicle.brandId && vehicle.brandId !== model.brand.id) {
    warnings.push({
      code: 'MODEL_BRAND',
      message: `${chassis}: ยี่ห้อ ${brandNameOf(vehicle.brandId)} ไม่ตรงกับ${same} ซึ่งเป็น ${model.brand.name}`,
      short: `ยี่ห้อ ${brandNameOf(vehicle.brandId)} (รุ่นนี้ปกติ ${model.brand.name})`,
      key: `MODEL_BRAND:${chassis}:${vehicle.brandId}:${model.brand.id}`,
    });
  }
  const cc = vehicle.cc === null || vehicle.cc === '' ? null : Number(vehicle.cc);
  if (model.cc !== null && cc !== null && Number.isFinite(cc) && cc > 0 && cc !== model.cc) {
    warnings.push({
      code: 'MODEL_CC',
      message: `${chassis}: CC ${cc} ไม่ตรงกับ${same} ซึ่งเป็น ${model.cc} cc`,
      short: `CC ${cc} (รุ่นนี้ปกติ ${model.cc})`,
      key: `MODEL_CC:${chassis}:${cc}:${model.cc}`,
    });
  }
  if (model.body && vehicle.body && vehicle.body !== model.body) {
    warnings.push({
      code: 'MODEL_BODY',
      message: `${chassis}: ประเภทรถ ${vehicle.body} ไม่ตรงกับ${same} ซึ่งเป็น ${model.body}`,
      short: `ประเภทรถ ${vehicle.body} (รุ่นนี้ปกติ ${model.body})`,
      key: `MODEL_BODY:${chassis}:${vehicle.body}:${model.body}`,
    });
  }
  return warnings;
}

export function dataWarningsFor(vehicle: CheckedVehicle, models: Map<string, KnownModel>, brandNameOf: (id: string) => string): DataWarning[] {
  const prefix = modelPrefix(vehicle.chassis);
  return [...chassisWarnings(vehicle.chassis), ...modelWarnings(vehicle, prefix ? models.get(prefix) : undefined, brandNameOf)];
}

// ยืนยันครบ = key ของคำเตือนทุกข้อที่มีตอนนี้อยู่ในรายการที่หน้าจอส่งมา (ยืนยันของข้อมูลชุดก่อนใช้กับคำเตือนใหม่ไม่ได้)
export function isDataWarningsConfirmed(warnings: DataWarning[], confirmedRaw: unknown): boolean {
  if (warnings.length === 0) return true;
  const confirmed = new Set(Array.isArray(confirmedRaw) ? confirmedRaw.filter((k): k is string => typeof k === 'string') : []);
  return warnings.every((w) => confirmed.has(w.key));
}

// รายงานข้อมูลน่าสงสัยของหน้าภาพรวม (ผู้ใช้ 2026-10-13): สแกนรถทั้งระบบทุกครั้งที่เปิดหน้า เป็นตาข่ายรองรับสิ่งที่หลุดจากคำเตือนตอนคีย์
// (รุ่นที่ตอนคีย์ยังมีไม่ถึง 3 คัน, พนักงานยืนยันข้ามคำเตือน, ข้อมูลที่คีย์ก่อนมีระบบนี้) - รุ่นที่รู้จักสร้างจากรถทุกคัน
// แต่รายงานเฉพาะคันที่ open (ยังไม่วางบิล / ปิดงาน): วางบิลไปแล้วแก้ไปก็ไม่ช่วย และผู้ใช้ให้ข้ามของเก่า
export interface SuspectCandidate extends ModelSample {
  id: string;
  hasOwner: boolean;
  open: boolean;
}

export function findSuspectVehicles<T extends SuspectCandidate>(vehicles: T[], extraNotes: (vehicle: T) => string[] = () => []): Array<{ vehicle: T; notes: string[] }> {
  const models = buildKnownModels(vehicles);
  const brandNames = new Map(vehicles.map((v) => [v.brandId, v.brandName]));
  const brandNameOf = (id: string) => brandNames.get(id) ?? '-';
  const suspects: Array<{ vehicle: T; notes: string[] }> = [];
  for (const vehicle of vehicles) {
    if (!vehicle.open) continue;
    const notes = [
      ...dataWarningsFor(vehicle, models, brandNameOf).map((w) => w.short),
      ...extraNotes(vehicle),
      ...(vehicle.hasOwner ? [] : ['ไม่มีข้อมูลเจ้าของรถ']),
    ];
    if (notes.length) suspects.push({ vehicle, notes });
  }
  return suspects;
}

export const DATA_WARNING_ERROR ='พบข้อมูลที่ควรตรวจอีกครั้ง - เทียบกับเอกสารแล้วกดยืนยันเพื่อบันทึก';

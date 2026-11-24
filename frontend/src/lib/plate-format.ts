// หมวดทะเบียน = ตัวเลขนำ 1 หลัก + พยัญชนะไทย 1-2 ตัว (เช่น "2ฆล") หรือพยัญชนะไทยล้วน 1-3 ตัว (เช่น "กข")
// ต้องตรงกับ PLATE_CATEGORY_RE ใน backend/src/document-submission/document-submission-validation.ts
// พบ 2026-11-20: AI อ่านใบเสร็จได้ "2฿ล" แทน "2ฆล" แล้วบันทึกผ่าน
export const PLATE_CATEGORY_RE = /^(?:\d[ก-ฮ]{1,2}|[ก-ฮ]{1,3})$/;
export const PLATE_CATEGORY_ERROR = "หมวดทะเบียนต้องเป็นตัวเลข 1 หลัก (ถ้ามี) ตามด้วยพยัญชนะไทย เช่น 2ฆล, กข";
export const PLATE_NUMBER_RE = /^\d{1,4}$/;

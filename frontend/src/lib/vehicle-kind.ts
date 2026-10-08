// รถยนต์ = ทุกประเภทยกเว้น รย.12 (มอเตอร์ไซค์) - ตรงกับ isMotorcycle ฝั่ง backend
// มอเตอร์ไซค์ = รย.12 และ รย.17 (จักรยานยนต์สาธารณะ, ผู้ใช้ 2026-10-08) - ตรงกับ isMotorcycleType ใน backend/src/vehicles/vehicle-reference-data.ts
export const MOTORCYCLE_PREFIXES = ["รย.12-", "รย.17-"];
export const isMotorcycleBody = (body: string | null | undefined) => !!body && MOTORCYCLE_PREFIXES.some((prefix) => body.startsWith(prefix));

export interface TaxPreviewDto {
  body: unknown; // ประเภทรถ (VEHICLE_TYPES string)
  fuel: unknown; // ประเภทเชื้อเพลิง (FUEL_TYPES string)
  cc: unknown;
  weight: unknown;
  firstRegistrationDate: unknown; // ค.ศ. YYYY-MM-DD หรือ null
  owner: unknown; // { ownerType, isHirePurchaseBusiness, hirerType } | null - null = ยังไม่ระบุเจ้าของรถ
}

import type { CreateCustomerDto } from './create-customer.dto.js';

// แก้ข้อมูลลูกค้า (ผู้ใช้ 2026-09-27): ส่ง 7 ช่องครบเหมือนตอนเพิ่ม + เหตุผล (บังคับ)
// terms = เงื่อนไขวางบิล ไม่ส่ง = ไม่แก้ (รูปเดียวกับ PATCH /api/billing/customers/:id/terms)
// expectedUpdatedAt = updatedAt ของลูกค้าตอนเปิดหน้าแก้ (บังคับ) - ไม่ตรง = มีคนแก้ไปก่อน ตอบ 409 ไม่ทับค่าของเขา
export interface UpdateCustomerDto extends CreateCustomerDto {
  remark: unknown;
  terms?: unknown;
  expectedUpdatedAt: unknown;
}

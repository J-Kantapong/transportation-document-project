import { Controller, Get } from '@nestjs/common';
import { PayslipSignatureService } from './payslip-signature.service.js';

// ลายเซ็นชุดเดียวกับสลิปเงินเดือน ใช้พิมพ์บนใบเสนอราคา (ผู้ใช้ 2026-10-06) - อ่านอย่างเดียว
// อยู่ใต้ /api/billing เพื่อให้ใช้สิทธิ์งานบัญชีเดิม (ADMIN + ACCOUNTANT ที่พิมพ์ใบเสนอราคาได้) ส่วนการตั้ง/ลบอยู่ที่ /api/hr (ADMIN เท่านั้น)
@Controller('api/billing/print-signature')
export class PrintSignatureController {
  constructor(private readonly signature: PayslipSignatureService) {}

  @Get()
  async get() {
    const s = await this.signature.get();
    return { exists: s.exists, signerName: s.signerName, imageDataUrl: s.imageDataUrl };
  }
}

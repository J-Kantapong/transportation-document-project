import { Controller, Get } from '@nestjs/common';
import { MyWorkService } from './my-work.service.js';

@Controller('api/my-work')
export class MyWorkController {
  constructor(private readonly myWorkService: MyWorkService) {}

  // งานของฉัน: รายการที่ติดขัดและตัวช่วยตรวจ เฉพาะขั้นที่บทบาทของผู้ใช้ทำได้ (พนักงานทุกฝ่าย + ส่งของ ดู access-policy.ts) - ไม่มีราคาของออฟฟิศ
  @Get()
  myWork() {
    return this.myWorkService.myWork();
  }
}

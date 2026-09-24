import { Logger } from '@nestjs/common';
import type { RequestUser } from '../auth/auth.types.js';
import { currentUser, requestContext } from '../auth/request-context.js';

// คิวให้ AI อ่านรูปเบื้องหลัง (ผู้ใช้ 2026-09-25): เลือกหลายรูปจากคลังภาพ -> เก็บรูป (readPending) แล้วตอบทันที
// ใช้กับใบเสร็จ (Step 5) ป้าย (Step 6) และเล่ม (Step 7) - ถ่ายจากกล้องทีละรูปยังอ่านทันทีเหมือนเดิม
// อยู่ในหน่วยความจำของ process เดียว: server รีสตาร์ท -> service ดึงแถวที่ readPending ค้างมาเข้าคิวใหม่ตอนเปิด
export const READ_CONCURRENCY = 3;

export const isBackgroundFlag = (v: unknown) => v === true || v === 'true' || v === '1';

export class BackgroundReads {
  private readonly logger: Logger;
  private readonly queue: Array<{ id: string; user: RequestUser | null }> = [];
  private running = 0;

  // readOne ต้องไม่ถือว่าแถวยังอยู่ - รูปอาจถูกลบระหว่างรออ่าน
  constructor(
    name: string,
    private readonly readOne: (id: string) => Promise<void>,
  ) {
    this.logger = new Logger(name);
  }

  // user = คนที่อัปโหลด (จำกัดประเภทรถตอนจับคู่ให้เหมือนตอนอ่านทันที) · null = ไม่จำกัด เช่นอ่านต่อหลังรีสตาร์ท
  enqueue(id: string, user: RequestUser | null = currentUser()) {
    this.queue.push({ id, user });
    this.pump();
  }

  private pump() {
    while (this.running < READ_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      requestContext
        .run({ user: job.user }, () => this.readOne(job.id))
        .catch((err: unknown) => this.logger.error(`อ่านรูป ${job.id} ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

import { type CallHandler, type ExecutionContext, Injectable, Logger, type NestInterceptor } from '@nestjs/common';
import { type Observable, from, mergeMap } from 'rxjs';
import { OldVehicleJobsService } from './old-vehicle-jobs.service.js';

// ยื่นงานรถเก่าจากหน้าเดิมสำเร็จ (POST สร้างงาน) -> ผูกงานกับแถวรับงานทันที ก่อนส่งคำตอบกลับ
// ไม่รอให้มีคนเปิดหน้ารวม: ผลตรวจรถที่ทำก่อนยื่นต้องถึงงานโอน / ต่อภาษีก่อนที่หน้าของงานนั้นจะโหลดรายการใหม่
// ไม่งั้นงานจะไปขึ้น "รอส่งตรวจ" ในหน้าของงานโอนและถูกบันทึกตรวจซ้ำ
// ทำเป็น interceptor เพื่อไม่ต้องแก้ service ของงานเดิมทั้ง 6 ตัว - ผูกไม่สำเร็จไม่ทำให้การยื่นล้ม (หน้ารวมผูกซ้ำให้ตอนเปิด)
const CREATE_PATHS = /^\/api\/(plate-swaps(\/pair|\/change)?|vehicle-transfers|tax-renewals|vehicle-use-cancellations|vehicle-move-outs|plate-copies)\/?$/i;

@Injectable()
export class OldVehicleJobLinkInterceptor implements NestInterceptor {
  private readonly logger = new Logger(OldVehicleJobLinkInterceptor.name);

  constructor(private readonly jobs: OldVehicleJobsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{ method: string; path?: string; url: string }>();
    const path = (req.path ?? req.url.split('?')[0]) || '';
    if (req.method !== 'POST' || !CREATE_PATHS.test(path)) return next.handle();
    return next.handle().pipe(
      mergeMap((body: unknown) =>
        from(
          this.jobs
            .sync()
            .catch((err: unknown) => this.logger.error(`ผูกงานกับแถวรับงานไม่สำเร็จ: ${String(err)}`))
            .then(() => body),
        ),
      ),
    );
  }
}

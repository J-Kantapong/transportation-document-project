import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewService } from '../overview/overview.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NotesService } from './notes.service.js';
import { SecretaryService } from './secretary.service.js';

function service() {
  const s = new SecretaryService({} as OverviewService, {} as PrismaService, {} as NotesService);
  const morning = vi.spyOn(s, 'sendMorning').mockResolvedValue();
  const evening = vi.spyOn(s, 'sendEvening').mockResolvedValue();
  return { s, morning, evening };
}

afterEach(() => vi.useRealTimers());

describe('SecretaryService.runScheduled', () => {
  it('ส่งรอบที่ขอ และรอบเดียวกันของวันเดียวกันส่งครั้งเดียว (retry ไม่ส่งซ้ำ)', async () => {
    const { s, morning, evening } = service();
    expect(await s.runScheduled('morning')).toEqual({ sent: true });
    expect(await s.runScheduled('morning')).toEqual({ sent: false, skipped: 'already-sent' });
    expect(morning).toHaveBeenCalledTimes(1);
    expect(evening).not.toHaveBeenCalled();
  });

  it('เช้ากับเย็นเป็นคนละรอบ และวันใหม่ส่งได้อีก', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T02:00:00.000Z')); // 09:00 ไทย
    const { s, morning, evening } = service();
    await s.runScheduled('morning');
    vi.setSystemTime(new Date('2026-10-08T09:00:00.000Z')); // 16:00 ไทย วันเดียวกัน
    expect(await s.runScheduled('evening')).toEqual({ sent: true });
    vi.setSystemTime(new Date('2026-10-09T02:00:00.000Z')); // เช้าวันถัดไป
    expect(await s.runScheduled('morning')).toEqual({ sent: true });
    expect(morning).toHaveBeenCalledTimes(2);
    expect(evening).toHaveBeenCalledTimes(1);
  });

  it('ส่งไม่สำเร็จ = ไม่จดว่าส่งแล้ว ลองใหม่ได้', async () => {
    const { s, morning } = service();
    morning.mockRejectedValueOnce(new Error('LINE ตอบกลับ 500'));
    await expect(s.runScheduled('morning')).rejects.toThrow('LINE ตอบกลับ 500');
    expect(await s.runScheduled('morning')).toEqual({ sent: true });
    expect(morning).toHaveBeenCalledTimes(2);
  });
});

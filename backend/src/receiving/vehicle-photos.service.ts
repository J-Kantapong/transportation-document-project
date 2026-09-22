import { BadRequestException, Injectable } from '@nestjs/common';
import { vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';

// ค้นรูปทุกประเภทของรถด้วยเลขตัวถัง (ผู้ใช้ 2026-09-22: ดูรูปในระบบ ไม่ต้องเข้า Cloudflare)
// รูปเก็บแยกโฟลเดอร์ตามประเภท (receipts/ plates/ books/) แต่การผูกกับรถอยู่ในฐานข้อมูล:
// ใบเสร็จ -> DocumentSubmission.receipts (1 คันมีได้หลายใบ/หลายครั้งที่ยื่น)
// ป้าย/เล่ม -> Vehicle.platePhotoId / bookPhotoId (1 รูปมีหลายคัน จึงเป็นรูปที่ใช้ยืนยันการรับของคันนั้น)
// ตัวไฟล์โหลดผ่าน GET /api/receipts/:id/image, /api/plate-photos/:id/image, /api/book-photos/:id/image

const MAX_RESULTS = 10;

export interface VehiclePhotoReceipt {
  id: string;
  createdAt: string;
  submitDate: string; // YYYY-MM-DD
  receiptNo: string | null;
  submissionStatus: string;
}

export interface VehiclePhotoSingle {
  id: string;
  createdAt: string;
  receivedDate: string | null; // YYYY-MM-DD วันที่ยืนยันรับป้าย/เล่ม
}

export interface VehiclePhotos {
  id: string;
  chassis: string;
  date: string;
  customerName: string;
  brandName: string;
  body: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  receipts: VehiclePhotoReceipt[];
  platePhoto: VehiclePhotoSingle | null;
  bookPhoto: VehiclePhotoSingle | null;
}

const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

@Injectable()
export class VehiclePhotosService {
  constructor(private readonly prisma: PrismaService) {}

  // ค้นแบบ contains (พิมพ์ท้ายเลขตัวถังได้) ไม่สนตัวพิมพ์ - คืนไม่เกิน 10 คัน เรียงคันที่บันทึกล่าสุดก่อน
  async searchByChassis(raw: string): Promise<VehiclePhotos[]> {
    const chassis = raw.trim();
    if (!chassis) throw new BadRequestException({ error: 'กรุณาระบุเลขตัวถัง' });
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, chassis: { contains: chassis, mode: 'insensitive' }, ...vehicleTypeWhere() },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_RESULTS,
      select: {
        id: true,
        chassis: true,
        date: true,
        body: true,
        plateCategory: true,
        plateNumber: true,
        plateReceivedDate: true,
        bookReceivedDate: true,
        customer: { select: { name: true } },
        brand: { select: { name: true } },
        platePhoto: { select: { id: true, createdAt: true } },
        bookPhoto: { select: { id: true, createdAt: true } },
        documentSubmissions: {
          orderBy: { submitDate: 'desc' },
          select: {
            submitDate: true,
            status: true,
            receiptNo: true,
            receipts: { orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true } },
          },
        },
      },
    });

    return vehicles.map((v) => ({
      id: v.id,
      chassis: v.chassis,
      date: v.date.toISOString().slice(0, 10),
      customerName: v.customer.name,
      brandName: v.brand.name,
      body: v.body,
      plateCategory: v.plateCategory,
      plateNumber: v.plateNumber,
      receipts: v.documentSubmissions.flatMap((s) =>
        s.receipts.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          submitDate: s.submitDate.toISOString().slice(0, 10),
          receiptNo: s.receiptNo,
          submissionStatus: s.status,
        })),
      ),
      platePhoto: v.platePhoto
        ? { id: v.platePhoto.id, createdAt: v.platePhoto.createdAt.toISOString(), receivedDate: isoDate(v.plateReceivedDate) }
        : null,
      bookPhoto: v.bookPhoto
        ? { id: v.bookPhoto.id, createdAt: v.bookPhoto.createdAt.toISOString(), receivedDate: isoDate(v.bookReceivedDate) }
        : null,
    }));
  }
}

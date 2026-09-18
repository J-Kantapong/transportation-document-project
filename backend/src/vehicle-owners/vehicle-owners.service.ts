// เจ้าของรถตามทะเบียน - แยกจาก Customer (ลูกค้าที่ส่งงานอาจไม่ใช่เจ้าของรถ) ห้ามอนุมานจากกัน
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerType } from '../generated/prisma/enums.js';
import { CreateVehicleOwnerDto } from './dto/create-vehicle-owner.dto.js';

const OWNER_TYPES = [OwnerType.INDIVIDUAL, OwnerType.JURISTIC] as const;

function parseOwnerType(value: unknown, field: string): OwnerType {
  if (!OWNER_TYPES.includes(value as OwnerType)) {
    throw new BadRequestException({ error: `${field} ต้องเป็น INDIVIDUAL หรือ JURISTIC` });
  }
  return value as OwnerType;
}

@Injectable()
export class VehicleOwnersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.vehicleOwner.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  }

  async create(body: CreateVehicleOwnerDto): Promise<{ id: string }> {
    const ownerType = parseOwnerType(body?.ownerType, 'ownerType');
    const isHirePurchaseBusiness = Boolean(body?.isHirePurchaseBusiness);
    const hirerTypeRaw = body?.hirerType;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';

    if (name.length > 250) throw new BadRequestException({ error: 'ชื่อเจ้าของรถยาวเกิน 250 ตัวอักษร' });

    // บุคคลธรรมดาทำธุรกิจเช่าซื้อไม่ได้ - ข้อยกเว้นใน Master Rule ใช้กับ "นิติบุคคลที่ประกอบธุรกิจเช่าซื้อ" เท่านั้น
    if (ownerType === OwnerType.INDIVIDUAL && isHirePurchaseBusiness) {
      throw new BadRequestException({ error: 'บุคคลธรรมดาไม่สามารถระบุว่าประกอบธุรกิจเช่าซื้อได้' });
    }
    if (isHirePurchaseBusiness && hirerTypeRaw == null) {
      throw new BadRequestException({ error: 'กรุณาระบุประเภทผู้เช่าซื้อ (hirerType) เมื่อประกอบธุรกิจเช่าซื้อ' });
    }
    if (!isHirePurchaseBusiness && hirerTypeRaw != null) {
      throw new BadRequestException({ error: 'ระบุผู้เช่าซื้อ (hirerType) ได้เฉพาะกรณีประกอบธุรกิจเช่าซื้อเท่านั้น' });
    }
    const hirerType = hirerTypeRaw == null ? null : parseOwnerType(hirerTypeRaw, 'hirerType');

    const owner = await this.prisma.vehicleOwner.create({
      data: { name: name || null, ownerType, isHirePurchaseBusiness, hirerType },
      select: { id: true },
    });

    return { id: owner.id };
  }
}

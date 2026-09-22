import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { accessFor, isAllowed } from './access-policy.js';
import { authSecret } from './auth-config.js';
import type { RequestUser } from './auth.types.js';
import { verifyToken } from './jwt.js';
import { setCurrentUser } from './request-context.js';

// Global guard (ลงทะเบียนใน AuthModule ผ่าน APP_GUARD): อ่าน "Authorization: Bearer <token>" -> โหลดผู้ใช้สด
// จากฐานข้อมูล -> เทียบกับตารางสิทธิ์ใน access-policy.ts แล้วแนบ req.user ให้ controller
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly secret = authSecret();

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const path = req.path.replace(/\/+$/, '') || '/';
    const access = accessFor(path, req.method);
    if (access === 'PUBLIC') return true;

    const user = await this.resolveUser(req.headers.authorization);
    if (!user) throw new UnauthorizedException({ error: 'กรุณาเข้าสู่ระบบ' });
    if (!isAllowed(access, user.roles)) throw new ForbiddenException({ error: 'บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้' });
    req.user = user;
    setCurrentUser(user); // ให้ service อ่านขอบเขตประเภทรถได้ (vehicle-scope.ts) โดยไม่ต้องส่ง user ต่อเป็นทอดๆ
    return true;
  }

  private async resolveUser(header: string | undefined): Promise<RequestUser | null> {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    const payload = verifyToken(token, this.secret);
    if (!payload) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, roles: true, status: true, customerId: true, name: true, displayName: true },
    });
    if (!user || user.status !== 'APPROVED') return null;
    return { id: user.id, roles: user.roles, customerId: user.customerId, name: user.displayName || user.name };
  }
}

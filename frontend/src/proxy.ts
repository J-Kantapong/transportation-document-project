import { NextResponse, type NextRequest } from 'next/server';
import { canAccessPage, homeFor, PUBLIC_PATHS, rolesFromToken, TOKEN_COOKIE } from '@/lib/auth';

// กันเข้าหน้าโดยไม่ล็อกอิน (Next 16 เรียกไฟล์นี้ว่า proxy แทน middleware) - ตรวจแค่ว่ามี token และ roles ใน
// payload เข้าหน้านั้นได้ไหม ส่วนสิทธิ์ข้อมูลจริง backend ตรวจทุกคำขอ (backend/src/auth/auth.guard.ts)
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(TOKEN_COOKIE)?.value ?? '';
  const roles = token ? rolesFromToken(token) : [];
  const loggedIn = roles.length > 0;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (isPublic) {
    return loggedIn ? NextResponse.redirect(new URL(homeFor(roles), request.url)) : NextResponse.next();
  }
  if (!loggedIn) {
    const login = new URL('/login', request.url);
    if (pathname !== '/') login.searchParams.set('next', pathname + request.nextUrl.search);
    const res = NextResponse.redirect(login);
    if (token) res.cookies.delete(TOKEN_COOKIE); // token หมดอายุ/เสีย
    return res;
  }
  if (!canAccessPage(pathname, roles)) {
    return NextResponse.redirect(new URL(homeFor(roles), request.url));
  }
  return NextResponse.next();
}

export const config = {
  // ไม่ยุ่งกับไฟล์ static/รูป/favicon
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)'],
};

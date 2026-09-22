import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestUser } from './auth.types.js';

// เก็บผู้ใช้ของคำขอปัจจุบันไว้ใน AsyncLocalStorage: main.ts เปิด store ให้ทุกคำขอ (app.use) และ AuthGuard ใส่ user
// ให้ service ใดๆ เรียก currentUser() ได้โดยไม่ต้องส่ง user ผ่าน parameter ทุกชั้น (ดู vehicle-scope.ts)
// นอกคำขอ HTTP (unit test, script) store ว่าง -> currentUser() = null
interface RequestStore {
  user: RequestUser | null;
}

export const requestContext = new AsyncLocalStorage<RequestStore>();

export function runWithRequestContext<T>(fn: () => T): T {
  return requestContext.run({ user: null }, fn);
}

export function setCurrentUser(user: RequestUser) {
  const store = requestContext.getStore();
  if (store) store.user = user;
}

export function currentUser(): RequestUser | null {
  return requestContext.getStore()?.user ?? null;
}

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { auditHref, auditTitle } from './activity.service.js';

// ทุก entity / action ที่โค้ดเขียนลง AuditLog ต้องมีชื่อไทยในหน้าภาพรวมการทำงาน (ผู้ใช้ 2026-10-15: เคยขึ้น "ลูกค้า: update-terms")
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

const auditCalls = sourceFiles(join(__dirname, '..'))
  .map((file) => readFileSync(file, 'utf8'))
  .flatMap((text) => [...text.matchAll(/writeAudit\(\s*\w+\s*,\s*\{([\s\S]*?)\}\s*\)/g)].map((m) => m[1]));
const literals = (key: string) => new Set(auditCalls.flatMap((body) => [...body.matchAll(new RegExp(`${key}: '([A-Za-z-]+)'`, 'g'))].map((m) => m[1])));

describe('activity audit labels', () => {
  it('finds the audit calls in the source', () => {
    expect(auditCalls.length).toBeGreaterThan(20);
  });

  it('every audit entity has a Thai name', () => {
    const missing = [...literals('entity')].filter((e) => auditTitle(e, 'update').startsWith(`${e}:`));
    expect(missing).toEqual([]);
  });

  it('every audit action has a Thai name', () => {
    const missing = [...literals('action')].filter((a) => auditTitle('Customer', a).endsWith(`: ${a}`));
    expect(missing).toEqual([]);
  });

  it('links each edit to the page where it can be checked, not the home page', () => {
    expect(auditTitle('Customer', 'update-terms')).toBe('ลูกค้า: แก้เงื่อนไขวางบิล');
    expect(auditHref('Customer', 'update-terms')).toBe('/customers');
    expect(auditHref('VehicleTransfer', 'billing-close')).toBe('/accounting/billing/jobs');
    expect(auditHref('PlateCopy', 'delivery-cancel')).toBe('/delivery/report');
    expect(auditHref('PlateSwap', 'update')).toBe('/registration/plate-swap');
    for (const entity of literals('entity')) expect(auditHref(entity, 'update')).not.toBe('/');
  });
});

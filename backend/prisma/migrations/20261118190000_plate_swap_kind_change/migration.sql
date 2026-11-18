-- เปลี่ยนเลขทะเบียน (ผู้ใช้ 2026-11-18): งานแบบเดียวกับสลับเลขแต่มีรถคันเดียว เก็บในตาราง PlateSwap ด้วย kind ใหม่
ALTER TYPE "PlateSwapKind" ADD VALUE 'CHANGE';

// รูปที่อ้างด้วย id ของรูปเอง (ReceiptImage / PlatePhoto / BookPhoto) ไฟล์ไม่เคยเปลี่ยน - ให้เบราว์เซอร์จำไว้ 1 วัน (ผู้ใช้ 2026-09-30: รูปขึ้นช้า)
// private = เก็บในเครื่องผู้ใช้เท่านั้น ไม่เก็บที่ proxy/CDN; ไม่ใส่ Vary: Authorization เพราะ /api/auth/me ออก token ใหม่ทุกครั้งที่เปิดหน้า
// (ใส่แล้ว cache ไม่เคยถูกใช้) - URL รูปมีแค่ในหน้าที่ผู้ใช้เห็นได้อยู่แล้ว
// ห้ามใช้กับ URL ที่รูปเปลี่ยนได้ เช่น /api/plate-swaps/:id/plate-photo/image (ถอด/แนบรูปใหม่ได้ใน URL เดิม)
export const IMAGE_CACHE_CONTROL = 'private, max-age=86400';

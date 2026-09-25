// รถยนต์ = ทุกประเภทยกเว้น รย.12 (มอเตอร์ไซค์) - ตรงกับ isMotorcycle ฝั่ง backend
export const isMotorcycleBody = (body: string | null) => Boolean(body?.startsWith("รย.12-"));

// แถบเมนูด้านล่างแชต (Rich Menu) ของบัญชีไลน์ลูกค้า (ผู้ใช้ 2026-10-09) - สร้างผ่าน LINE Messaging API ตอนเซิร์ฟเวอร์เริ่ม
// รูปเมนู = rich-menu.png (วาดจาก rich-menu.html ขนาด 2500x1686) แต่ละช่องกดแล้วส่งคำสำคัญเข้าแชตเหมือนพิมพ์เอง
// แก้รูปหรือช่อง = เปลี่ยน RICH_MENU_VERSION แล้ว deploy: ระบบสร้างเมนูใหม่ ตั้งเป็นค่าเริ่มต้น แล้วลบเมนูรุ่นเก่าของตัวเอง
// เมนูที่สร้างใน LINE Manager ไม่อยู่ในรายการของ API จึงไม่ถูกแตะ (แต่เมนูจาก API จะแสดงทับ)
const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';
const TIMEOUT_MS = 20_000;

export const RICH_MENU_PREFIX = 'jitkusol-main-';
export const RICH_MENU_VERSION = 'v1';
export const RICH_MENU_NAME = `${RICH_MENU_PREFIX}${RICH_MENU_VERSION}`;

const WIDTH = 2500;
const HEIGHT = 1686;
const COLUMNS = [0, 833, 1667, WIDTH];
const ROWS = [0, 600, 1200, HEIGHT];

// ลำดับซ้ายไปขวา บนลงล่าง ต้องตรงกับรูป - คำที่ส่งต้องเป็นคำสำคัญของการ์ดใน customer-menu.ts
export const RICH_MENU_KEYWORDS = ['จดใหม่', 'โอนรถ', 'สลับเลข', 'เปลี่ยนสี', 'ต่อภาษี', 'คัดป้าย', 'แบบฟอร์ม', 'เช็ก', 'ติดต่อเจ้าหน้าที่'];

export function richMenuDefinition() {
  return {
    size: { width: WIDTH, height: HEIGHT },
    selected: true,
    name: RICH_MENU_NAME,
    chatBarText: 'เมนู',
    areas: RICH_MENU_KEYWORDS.map((text, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      return {
        bounds: { x: COLUMNS[column], y: ROWS[row], width: COLUMNS[column + 1] - COLUMNS[column], height: ROWS[row + 1] - ROWS[row] },
        action: { type: 'message', text },
      };
    }),
  };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function call(fetchImpl: FetchLike, token: string, method: string, url: string, body?: BodyInit, contentType?: string): Promise<Response> {
  return fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// ไม่ใส่ token ลงใน error เพราะมักถูก log
async function mustOk(response: Response, step: string): Promise<Response> {
  if (response.ok) return response;
  const detail = await response
    .json()
    .then((payload: { message?: string }) => payload.message ?? '')
    .catch(() => '');
  throw new Error(`${step}: LINE ตอบกลับ ${response.status}${detail ? `: ${detail}` : ''}`);
}

export type RichMenuSync = 'unchanged' | 'default-set' | 'created';

// ทำให้บัญชีมีแถบเมนูรุ่นปัจจุบันเป็นค่าเริ่มต้น - เรียกซ้ำได้ (มีอยู่แล้วไม่สร้างใหม่)
export async function syncRichMenu(token: string, image: Uint8Array, fetchImpl: FetchLike = fetch): Promise<RichMenuSync> {
  const list = (await (await mustOk(await call(fetchImpl, token, 'GET', `${API}/richmenu/list`), 'อ่านรายการเมนู')).json()) as {
    richmenus?: Array<{ richMenuId: string; name: string }>;
  };
  const menus = list.richmenus ?? [];
  const current = menus.find((menu) => menu.name === RICH_MENU_NAME);

  if (current) {
    // 404 = ยังไม่มีเมนูเริ่มต้น
    const defaultResponse = await call(fetchImpl, token, 'GET', `${API}/user/all/richmenu`);
    const defaultId = defaultResponse.ok ? ((await defaultResponse.json()) as { richMenuId?: string }).richMenuId : undefined;
    if (defaultId === current.richMenuId) return 'unchanged';
    await mustOk(await call(fetchImpl, token, 'POST', `${API}/user/all/richmenu/${current.richMenuId}`), 'ตั้งเมนูเริ่มต้น');
    return 'default-set';
  }

  const created = (await (
    await mustOk(await call(fetchImpl, token, 'POST', `${API}/richmenu`, JSON.stringify(richMenuDefinition()), 'application/json'), 'สร้างเมนู')
  ).json()) as { richMenuId: string };
  try {
    await mustOk(await call(fetchImpl, token, 'POST', `${DATA_API}/richmenu/${created.richMenuId}/content`, image as BodyInit, 'image/png'), 'อัปโหลดรูปเมนู');
    await mustOk(await call(fetchImpl, token, 'POST', `${API}/user/all/richmenu/${created.richMenuId}`), 'ตั้งเมนูเริ่มต้น');
  } catch (error) {
    // เมนูที่ไม่มีรูปหรือยังไม่ได้ตั้งใช้ ต้องไม่ค้างไว้ ไม่งั้นรอบหน้าจะเจอชื่อเดิมแล้วเข้าใจว่าเสร็จแล้ว
    await call(fetchImpl, token, 'DELETE', `${API}/richmenu/${created.richMenuId}`).catch(() => undefined);
    throw error;
  }

  // ลบเมนูรุ่นเก่าของบอทนี้ - ลบไม่สำเร็จไม่เป็นไร เมนูใหม่ใช้งานแล้ว
  for (const menu of menus) {
    if (menu.name.startsWith(RICH_MENU_PREFIX)) await call(fetchImpl, token, 'DELETE', `${API}/richmenu/${menu.richMenuId}`).catch(() => undefined);
  }
  return 'created';
}

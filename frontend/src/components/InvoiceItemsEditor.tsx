"use client";

import {
  ITEM_KIND_LABEL,
  type InvoiceItem,
  type InvoiceItemKind,
} from "@/lib/billing-api";
import { formatMoney, round2 } from "@/lib/invoice";

// บรรทัดกำหนดเองของบิล (ผู้ใช้ 2026-09-29) ใช้ร่วม 3 ที่: หน้าบิลกำหนดเอง · หน้ายืนยันออกบิลรถ · หน้าแก้ไขบิลรถ
// ค่าธรรมเนียมราชการ = ไม่มี VAT ไม่หัก · ค่าบริการ = VAT + หัก ณ ที่จ่าย · ขายสินค้า = VAT ไม่หัก
// จำนวน x ราคาต่อหน่วย = ยอด (เช่น ต่อภาษีรถจักรยานยนต์ 100 x 12 คัน) · ต้นทุนต่อหน่วย ไม่พิมพ์บนบิล ใช้คิดกำไร
// แต่ละบรรทัดเป็น 2 แถว ห่อลงบรรทัดใหม่ได้ ไม่ต้องเลื่อนซ้ายขวา (ผู้ใช้ไม่ชอบตารางกว้างเกินจอ)

export interface ItemRow {
  kind: InvoiceItemKind;
  description: string;
  quantityText: string;
  unitPriceText: string;
  costText: string;
}

export const emptyItemRow = (): ItemRow => ({
  kind: "SERVICE",
  description: "",
  quantityText: "1",
  unitPriceText: "",
  costText: "",
});

function parseMoney(text: string): number | null {
  const t = text.replace(/,/g, "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

function parseQuantity(text: string): number | null {
  const t = text.replace(/,/g, "").trim();
  const n = Number(t);
  return t !== "" && Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : null;
}

const lineTotal = (r: ItemRow): number | null => {
  const q = parseQuantity(r.quantityText);
  const u = parseMoney(r.unitPriceText);
  return q === null || u === null ? null : round2(q * u);
};

export const itemRowsFromItems = (items: InvoiceItem[]): ItemRow[] =>
  items.map((it) => ({
    kind: it.kind,
    description: it.description,
    quantityText: String(it.quantity),
    unitPriceText: formatMoney(it.unitPrice),
    costText: it.cost === null ? "" : formatMoney(it.cost),
  }));

export const itemRowsToItems = (rows: ItemRow[]): InvoiceItem[] =>
  rows.map((r) => ({
    kind: r.kind,
    description: r.description.trim(),
    quantity: parseQuantity(r.quantityText) ?? 1,
    unitPrice: parseMoney(r.unitPriceText) ?? 0,
    amount: lineTotal(r) ?? 0,
    cost: r.kind === "FEE" ? null : parseMoney(r.costText),
  }));

// ข้อความผิดของบรรทัดแรกที่ยังไม่ครบ (null = ผ่าน)
export function itemRowsProblem(rows: ItemRow[]): string | null {
  for (const [i, r] of rows.entries()) {
    const n = `บรรทัดกำหนดเองที่ ${i + 1}`;
    if (!r.description.trim()) return `${n}: ใส่รายละเอียดที่จะพิมพ์บนบิล`;
    if (parseQuantity(r.quantityText) === null)
      return `${n}: จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป`;
    const unit = parseMoney(r.unitPriceText);
    if (unit === null || unit <= 0) return `${n}: ใส่ราคาต่อหน่วยมากกว่า 0`;
    if (
      r.kind !== "FEE" &&
      r.costText.trim() !== "" &&
      parseMoney(r.costText) === null
    )
      return `${n}: ต้นทุนไม่ถูกต้อง (เว้นว่างได้ถ้าไม่ทราบ)`;
  }
  return null;
}

// กำไรของบรรทัด = (ราคาต่อหน่วย - ต้นทุนต่อหน่วย) x จำนวน · ค่าธรรมเนียม = 0 เสมอ · ไม่ใส่ต้นทุน = ไม่ทราบ (null)
export function itemRowProfit(row: ItemRow): number | null {
  const total = lineTotal(row);
  if (total === null) return null;
  if (row.kind === "FEE") return 0;
  const cost = parseMoney(row.costText);
  return cost === null
    ? null
    : round2(total - cost * (parseQuantity(row.quantityText) ?? 1));
}

export function itemRowsProfit(rows: ItemRow[]): {
  known: number;
  unknown: number;
} {
  const known = round2(rows.reduce((s, r) => s + (itemRowProfit(r) ?? 0), 0));
  const unknown = rows.filter(
    (r) => itemRowProfit(r) === null && lineTotal(r) !== null,
  ).length;
  return { known, unknown };
}

const PLACEHOLDER: Record<InvoiceItemKind, string> = {
  FEE: "เช่น ค่าธรรมเนียมต่อภาษีรถจักรยานยนต์",
  SERVICE:
    "เช่น ค่าบริการต่อภาษีรถจักรยานยนต์ / ค่าบริการจดทะเบียน 1กข 1234 (งานเก่า)",
  GOODS: "เช่น ขายรถ Toyota Vios 2019 เลขตัวถัง ...",
};

const small = { fontSize: 12 } as const;
// ทุกช่องหน้าตาเดียวกับช่องกรอกอื่นของระบบ (.field input ใน globals.css) สูงเท่ากัน และช่องตัวเลขกว้างเท่ากัน
// หน้าที่อยากได้ช่องเล็กลง (ใบเสนอราคา, ผู้ใช้ 2026-10-01) ตั้ง --item-h / --item-px ที่กล่องครอบ - ไม่ตั้ง = ขนาดเดิม
const CONTROL_HEIGHT = "var(--item-h, 46px)";
const INPUT = {
  height: CONTROL_HEIGHT,
  boxSizing: "border-box",
  border: "1px solid #dce2ec",
  borderRadius: 8,
  background: "white",
  padding: "0 var(--item-px, 13px)",
  color: "#18243c",
  font: "inherit",
} as const;
const NUM_GRID = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
  gap: "8px 10px",
} as const;
const FIELD = { display: "grid", gap: 4, minWidth: 0 } as const;
const BOX = { ...INPUT, width: "100%", textAlign: "right" } as const;
const READONLY = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  background: "#f5f7fb",
  border: "1px solid #e3e8f2",
} as const;

export function InvoiceItemsEditor({
  rows,
  onChange,
  minRows = 0,
  addLabel = "+ เพิ่มบรรทัด",
}: {
  rows: ItemRow[];
  onChange: (rows: ItemRow[]) => void;
  minRows?: number; // หน้าบิลกำหนดเอง = 1 (บิลต้องมีอย่างน้อย 1 บรรทัด)
  addLabel?: string;
}) {
  function patch(i: number, p: Partial<ItemRow>) {
    onChange(
      rows.map((r, n) =>
        n === i
          ? { ...r, ...p, ...(p.kind === "FEE" ? { costText: "" } : {}) }
          : r,
      ),
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {rows.map((r, i) => {
        const total = lineTotal(r);
        const p = itemRowProfit(r);
        const n = i + 1;
        return (
          <div
            key={i}
            style={{
              border: "1px solid #e3e8f2",
              borderRadius: 10,
              padding: "10px 12px",
              display: "grid",
              gap: 8,
              fontSize: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span className="muted" style={small}>
                {n}.
              </span>
              <select
                value={r.kind}
                onChange={(e) =>
                  patch(i, { kind: e.target.value as InvoiceItemKind })
                }
                aria-label={`ประเภท บรรทัดที่ ${n}`}
                style={{ ...INPUT, paddingRight: 8 }}
              >
                {(Object.keys(ITEM_KIND_LABEL) as InvoiceItemKind[]).map(
                  (k) => (
                    <option key={k} value={k}>
                      {ITEM_KIND_LABEL[k]}
                    </option>
                  ),
                )}
              </select>
              <input
                type="text"
                value={r.description}
                onChange={(e) => patch(i, { description: e.target.value })}
                placeholder={PLACEHOLDER[r.kind]}
                style={{ ...INPUT, flex: "1 1 220px", minWidth: 0 }}
                aria-label={`รายละเอียด บรรทัดที่ ${n}`}
              />
              <button
                type="button"
                className="text-button"
                onClick={() => onChange(rows.filter((_, x) => x !== i))}
                disabled={rows.length <= minRows}
                aria-label={`ลบบรรทัดที่ ${n}`}
              >
                ลบ
              </button>
            </div>
            {/* ช่องตัวเลขกว้างเท่ากันทุกช่อง หัวข้ออยู่บนช่อง (ผู้ใช้ 2026-09-29) - ห่อลงบรรทัดใหม่บนจอแคบ */}
            <div style={NUM_GRID}>
              <label style={FIELD}>
                <span className="muted" style={small}>
                  จำนวน
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={r.quantityText}
                  onChange={(e) => patch(i, { quantityText: e.target.value })}
                  style={BOX}
                  aria-label={`จำนวน บรรทัดที่ ${n}`}
                />
              </label>
              <label style={FIELD}>
                <span className="muted" style={small}>
                  ราคาต่อหน่วย (ก่อน VAT)
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={r.unitPriceText}
                  onChange={(e) => patch(i, { unitPriceText: e.target.value })}
                  style={BOX}
                  aria-label={`ราคาต่อหน่วย บรรทัดที่ ${n}`}
                />
              </label>
              <div style={FIELD}>
                <span className="muted" style={small}>
                  รวม
                </span>
                <div style={{ ...BOX, ...READONLY, fontWeight: 600 }}>
                  {total === null ? "—" : formatMoney(total)}
                </div>
              </div>
              <label style={FIELD}>
                <span className="muted" style={small}>
                  ต้นทุนต่อหน่วย
                </span>
                {r.kind === "FEE" ? (
                  <div style={{ ...BOX, ...READONLY }} className="muted">
                    = ยอดเรียกเก็บ
                  </div>
                ) : (
                  <input
                    type="text"
                    inputMode="decimal"
                    value={r.costText}
                    onChange={(e) => patch(i, { costText: e.target.value })}
                    placeholder="ไม่ทราบ"
                    style={BOX}
                    aria-label={`ต้นทุนต่อหน่วย บรรทัดที่ ${n}`}
                  />
                )}
              </label>
              <div style={FIELD}>
                <span className="muted" style={small}>
                  กำไร
                </span>
                <div
                  style={{
                    ...BOX,
                    ...READONLY,
                    color:
                      p === null ? "#bb8527" : p < 0 ? "#c0392b" : undefined,
                  }}
                >
                  {p === null
                    ? total === null
                      ? "—"
                      : "ไม่ทราบ"
                    : formatMoney(p)}
                </div>
              </div>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="text-button"
        style={{ justifySelf: "start" }}
        onClick={() => onChange([...rows, emptyItemRow()])}
      >
        {addLabel}
      </button>
      {rows.length > 0 && (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          ค่าธรรมเนียมราชการ = ไม่มี VAT ไม่หัก ณ ที่จ่าย · ค่าบริการ = VAT 7% +
          หัก ณ ที่จ่าย · ขายสินค้า = VAT 7% ไม่หัก ณ ที่จ่าย ·
          ต้นทุนไม่พิมพ์บนบิล
        </p>
      )}
    </div>
  );
}

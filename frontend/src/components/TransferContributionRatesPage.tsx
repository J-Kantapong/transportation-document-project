"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { getCachedUser } from "@/lib/auth";
import { timestampToDisplayDate } from "@/lib/date";
import { transferContributionRatesApi, type TransferContributionRate } from "@/lib/transfer-contribution-rates-api";
import { toast } from "@/lib/toast";
import { Icon } from "@/components/Icon";
import { BackLink, LoadingState, Notice } from "@/components/ui";

// ลงขันงานโอนรายจังหวัด (ผู้ใช้ 2026-11-18: "โหลดจังหวัดทั่วประเทศ ... ค่าลงขันทำช่องไว้กรอกทีหลัง")
// ครบ 77 จังหวัด 3 ช่อง: โอน (มอเตอร์ไซค์) / โอน (รถยนต์) / โอนย้ายเข้า (มอเตอร์ไซค์) - ช่องว่าง = ยังไม่ได้ตั้งอัตรา
// ใช้เป็นค่าตั้งต้นของช่องลงขันในฟอร์มงานโอน (พนักงานแก้รายงานได้) ไม่กระทบงานที่ยื่นไปแล้ว
// ทุกคนที่เข้าหน้างานโอนดูได้ แก้ได้เฉพาะ ADMIN · เติมช่องว่างครั้งแรกไม่ต้องมีเหตุผล แก้อัตราที่เคยตั้งแล้วต้องมี

type Field = "transferMoto" | "transferCar" | "moveInMoto" | "moveInCar";
const FIELDS: { key: Field; label: string }[] = [
  { key: "transferMoto", label: "โอน (มอเตอร์ไซค์)" },
  { key: "transferCar", label: "โอน (รถยนต์)" },
  { key: "moveInMoto", label: "โอนย้ายเข้า (มอเตอร์ไซค์)" },
  { key: "moveInCar", label: "โอนย้ายเข้า (รถยนต์)" },
];

const money = (n: number | null) => (n === null ? <span className="muted">ยังไม่ตั้ง</span> : n.toLocaleString("th-TH", { maximumFractionDigits: 2 }));
const text = (n: number | null) => (n === null ? "" : String(n));
const AMOUNT = /^\d{1,7}(\.\d{1,2})?$/;

interface Draft {
  transferMoto: string;
  transferCar: string;
  moveInMoto: string;
  moveInCar: string;
  note: string;
  remark: string;
}

// ข้อความหลังกดปุ่ม: สำเร็จ = toast (หายเอง) / ผิดพลาด = เก็บไว้แสดงในหน้า
function useMessage() {
  const [message, setState] = useState<{ text: string; error?: boolean }>({ text: "" });
  function setMessage(next: { text: string; error?: boolean }) {
    if (next.text && !next.error) {
      toast.success(next.text);
      setState({ text: "" });
    } else {
      setState(next);
    }
  }
  return [message, setMessage] as const;
}

export function TransferContributionRatesPage() {
  const [rates, setRates] = useState<TransferContributionRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // จังหวัดที่กำลังแก้
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useMessage();

  async function load() {
    try {
      setRates((await transferContributionRatesApi.list()).rates);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "โหลดอัตราลงขันไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่านบทบาทจาก localStorage และโหลดข้อมูลครั้งแรกหลัง mount
    setIsAdmin(Boolean(getCachedUser()?.roles.includes("ADMIN")));
    void load();
  }, []);

  const isEmpty = (r: TransferContributionRate) => FIELDS.every((f) => r[f.key] === null);
  const shown = useMemo(() => {
    const q = query.trim();
    return rates.filter((r) => (!q || r.province.includes(q)) && (!onlyEmpty || FIELDS.every((f) => r[f.key] === null)));
  }, [rates, query, onlyEmpty]);
  const emptyCount = rates.filter(isEmpty).length;

  function openEdit(rate: TransferContributionRate) {
    setEditing(rate.province);
    setDraft({ transferMoto: text(rate.transferMoto), transferCar: text(rate.transferCar), moveInMoto: text(rate.moveInMoto), moveInCar: text(rate.moveInCar), note: rate.note ?? "", remark: "" });
    setMessage({ text: "" });
  }

  // แก้/ลบอัตราที่เคยตั้งแล้ว = ต้องมีเหตุผล (เติมช่องที่ยังว่างไม่ต้อง) - backend ตรวจซ้ำ
  const overwrites = (rate: TransferContributionRate, d: Draft) => FIELDS.some((f) => rate[f.key] !== null && text(rate[f.key]) !== d[f.key].trim() && Number(d[f.key].trim() || NaN) !== rate[f.key]);

  async function save(rate: TransferContributionRate) {
    if (!draft) return;
    for (const f of FIELDS) {
      const v = draft[f.key].trim();
      if (v && !AMOUNT.test(v)) return setMessage({ text: `ลงขัน${f.label}ต้องเป็นตัวเลขตั้งแต่ 0`, error: true });
    }
    if (overwrites(rate, draft) && !draft.remark.trim()) return setMessage({ text: "แก้อัตราที่เคยตั้งแล้ว - กรุณาระบุเหตุผล", error: true });
    setSaving(true);
    try {
      await transferContributionRatesApi.save({
        province: rate.province,
        transferMoto: draft.transferMoto.trim(),
        transferCar: draft.transferCar.trim(),
        moveInMoto: draft.moveInMoto.trim(),
        moveInCar: draft.moveInCar.trim(),
        note: draft.note.trim(),
        remark: draft.remark.trim(),
        expectedUpdatedAt: rate.updatedAt,
      });
      setEditing(null);
      setDraft(null);
      setMessage({ text: `บันทึกลงขันของ${rate.province}แล้ว - ใช้กับงานโอนที่ยื่นตั้งแต่นี้ไป` });
      await load();
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true });
      if (err instanceof ApiError && err.status === 409) void load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content">
      <BackLink href="/registration/transfer" label="งานโอน" />
      <h1>ลงขันงานโอนรายจังหวัด</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        อัตราลงขันตั้งต้นที่ระบบเติมให้ในฟอร์มงานโอนตามจังหวัดที่ยื่น (พนักงานแก้รายงานได้) ใส่ 0 = จังหวัดนั้นไม่เสียลงขัน เว้นว่าง = ยังไม่ได้ตั้งอัตรา
        {isAdmin ? "" : " - แก้อัตราได้เฉพาะผู้ดูแลระบบ"}
      </p>

      <div className="panel">
        <div className="panel-head">
          <h2>
            ทั้งหมด {rates.length} จังหวัด{emptyCount > 0 ? ` · ยังไม่ได้ตั้ง ${emptyCount} จังหวัด` : ""}
          </h2>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", fontSize: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} />
              เฉพาะที่ยังไม่ได้ตั้ง
            </label>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ค้นหาจังหวัด" aria-label="ค้นหาจังหวัด" className="inspect-input" />
          </div>
        </div>
        <Notice tone="error">{message.error ? message.text : ""}</Notice>
        {loading ? (
          <LoadingState />
        ) : loadError ? (
          <Notice tone="error">{loadError}</Notice>
        ) : shown.length === 0 ? (
          <div className="empty-customers">ไม่พบจังหวัดที่ค้นหา</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">จังหวัด</th>
                  {FIELDS.map((f) => (
                    <th key={f.key} scope="col">
                      {f.label}
                    </th>
                  ))}
                  <th scope="col">หมายเหตุ</th>
                  <th scope="col">แก้ล่าสุด</th>
                  {isAdmin && <th />}
                </tr>
              </thead>
              <tbody>
                {shown.map((rate) =>
                  editing === rate.province && draft ? (
                    <tr key={rate.province}>
                      <td>
                        <strong>{rate.province}</strong>
                      </td>
                      {FIELDS.map((f) => (
                        <td key={f.key}>
                          <input
                            value={draft[f.key]}
                            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value.replace(/[^0-9.]/g, "") })}
                            inputMode="decimal"
                            placeholder="ยังไม่ตั้ง"
                            aria-label={`ลงขัน${f.label} ${rate.province}`}
                            className="inspect-input"
                            style={{ width: 110 }}
                          />
                        </td>
                      ))}
                      <td>
                        <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="หมายเหตุ" aria-label="หมายเหตุ" className="inspect-input" style={{ width: 150 }} />
                      </td>
                      <td>
                        {rate.updatedAt && (
                          <input
                            value={draft.remark}
                            onChange={(e) => setDraft({ ...draft, remark: e.target.value })}
                            placeholder={overwrites(rate, draft) ? "เหตุผลที่แก้ *" : "เหตุผล (ถ้ามี)"}
                            aria-label="เหตุผลที่แก้อัตราลงขัน"
                            className="inspect-input"
                            style={{ width: 150 }}
                          />
                        )}
                      </td>
                      <td>
                        <button type="button" className="text-button" disabled={saving} onClick={() => save(rate)}>
                          {saving ? "กำลังบันทึก…" : "บันทึก"}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={saving}
                          onClick={() => {
                            setEditing(null);
                            setDraft(null);
                            setMessage({ text: "" });
                          }}
                        >
                          ยกเลิก
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={rate.province}>
                      <td>{rate.province}</td>
                      {FIELDS.map((f) => (
                        <td key={f.key}>{money(rate[f.key])}</td>
                      ))}
                      <td style={{ whiteSpace: "normal" }}>{rate.note ?? ""}</td>
                      <td>
                        {rate.updatedAt ? (
                          <span className="sub">
                            {timestampToDisplayDate(rate.updatedAt)}
                            {rate.updatedBy ? ` · ${rate.updatedBy}` : ""}
                          </span>
                        ) : (
                          ""
                        )}
                      </td>
                      {isAdmin && (
                        <td>
                          <button type="button" className="text-button" onClick={() => openEdit(rate)}>
                            <Icon name="pencil" /> {isEmpty(rate) ? "กรอก" : "แก้"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

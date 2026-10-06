"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateInput } from "@/components/DateInput";
import { digits, errorText, HistoryDialog, HrDialog, moneyOf, ReasonDialog } from "@/components/hr/HrDialog";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
import { hrApi, maskId, parseEmployeePaste, type Employee, type EmployeeIdType, type EmployeeInput } from "@/lib/hr-api";
import { formatMoney, round2 } from "@/lib/invoice";

// ทะเบียนพนักงาน (ผู้ใช้ 2026-10-05) - ADMIN เท่านั้น: เพิ่ม / แก้ (ต้องมีเหตุผล + ประวัติ) / ลาออก-รับกลับ / นำเข้าจาก Excel
// ข้อมูลส่วนบุคคลไม่เก็บใน repo - นำเข้าผ่านหน้านี้เท่านั้น

type StatusFilter = "ACTIVE" | "RESIGNED" | "";

export function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ACTIVE");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [resigning, setResigning] = useState<Employee | null>(null);
  const [reinstating, setReinstating] = useState<Employee | null>(null);
  const [history, setHistory] = useState<Employee | null>(null);
  const [showImport, setShowImport] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await hrApi.listEmployees();
      setEmployees(r.employees);
      setError("");
    } catch (err) {
      setError(errorText(err, "โหลดทะเบียนพนักงานไม่สำเร็จ"));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (employees ?? []).filter(
      (e) => (!status || e.status === status) && (!needle || [e.code, e.fullName, e.position ?? ""].some((t) => t.toLowerCase().includes(needle))),
    );
  }, [employees, status, q]);
  const active = (employees ?? []).filter((e) => e.status === "ACTIVE");
  const payroll = round2(active.reduce((s, e) => s + e.baseSalary, 0));

  return (
    <section className="content">
      <div className="heading">
        <div>
          <h1 tabIndex={-1}>ทะเบียนพนักงาน</h1>
          <p>ข้อมูลพนักงานและเงินเดือนปัจจุบัน ใช้เป็นฐานของเงินเดือนแต่ละเดือน เห็นได้เฉพาะผู้ดูแลระบบ</p>
        </div>
        <div className="form-actions">
          <button type="button" onClick={() => setShowImport((v) => !v)}>
            {showImport ? "ปิดการนำเข้า" : "นำเข้าจาก Excel"}
          </button>
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            + เพิ่มพนักงาน
          </button>
        </div>
      </div>

      {showImport && (
        <ImportPanel
          onDone={() => {
            void load();
          }}
        />
      )}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>พนักงาน</h2>
          <span className="muted">
            ทำงานอยู่ {active.length} คน · เงินเดือนรวม {formatMoney(payroll)} บาท/เดือน
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "end", padding: "0 23px 14px" }}>
          <div className="status-chips" style={{ padding: 0 }}>
            {(
              [
                ["ACTIVE", "ทำงานอยู่"],
                ["RESIGNED", "ลาออกแล้ว"],
                ["", "ทั้งหมด"],
              ] as Array<[StatusFilter, string]>
            ).map(([value, label]) => (
              <button key={label} type="button" className={`status-chip${status === value ? " active" : ""}`} onClick={() => setStatus(value)}>
                {label}
              </button>
            ))}
          </div>
          <label className="field" style={{ minWidth: 220 }}>
            ค้นหา
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="รหัส ชื่อ หรือตำแหน่ง" />
          </label>
        </div>
        {error && (
          <p className="customer-message error" role="alert" style={{ padding: "0 23px 14px" }}>
            {error}
          </p>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>รหัส</th>
                <th>ชื่อ-สกุล</th>
                <th>ตำแหน่ง</th>
                <th>เลขประจำตัว</th>
                <th style={{ textAlign: "right" }}>เงินเดือน</th>
                <th>ประกันสังคม</th>
                <th>ภาษี</th>
                <th>สถานะ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {employees === null && (
                <tr>
                  <td colSpan={9} className="muted">
                    กำลังโหลด…
                  </td>
                </tr>
              )}
              {employees !== null && shown.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    {employees.length === 0 ? "ยังไม่มีพนักงาน - กด \"+ เพิ่มพนักงาน\" หรือ \"นำเข้าจาก Excel\"" : "ไม่พบพนักงานตามเงื่อนไข"}
                  </td>
                </tr>
              )}
              {shown.map((e) => (
                <tr key={e.id} style={e.status === "RESIGNED" ? { opacity: 0.6 } : undefined}>
                  <td style={{ fontFamily: "monospace" }}>{e.code}</td>
                  <td>{e.fullName}</td>
                  <td>{e.position ?? ""}</td>
                  <td style={{ fontFamily: "monospace" }}>{maskId(e.idNumber)}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(e.baseSalary)}</td>
                  <td>{e.socialSecurity ? "เข้า" : <span className="muted">ไม่เข้า</span>}</td>
                  <td>{e.withholdTax ? "หัก" : <span className="muted">ไม่หัก</span>}</td>
                  <td>
                    {e.status === "ACTIVE" ? <span className="badge done">ทำงานอยู่</span> : <span className="badge warn">ลาออก {e.resignedDate ? isoToDisplayDate(e.resignedDate) : ""}</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="text-button" onClick={() => setEditing(e)}>
                      แก้
                    </button>
                    {e.status === "ACTIVE" ? (
                      <button type="button" className="text-button danger" onClick={() => setResigning(e)}>
                        ลาออก
                      </button>
                    ) : (
                      <button type="button" className="text-button" onClick={() => setReinstating(e)}>
                        รับกลับ
                      </button>
                    )}
                    <button type="button" className="text-button" onClick={() => setHistory(e)}>
                      ประวัติ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <EmployeeFormDialog
          employee={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void load();
          }}
        />
      )}
      {resigning && (
        <ReasonDialog
          title={`ลาออก: ${resigning.fullName}`}
          description={<p className="muted">พนักงานจะไม่ถูกลบ ประวัติเงินเดือนเดิมยังอยู่ครบ และจะไม่ขึ้นในรอบเงินเดือนของเดือนถัดจากเดือนที่ลาออก</p>}
          withDate={{ label: "วันที่ลาออก" }}
          confirmLabel="ยืนยันลาออก"
          danger
          onClose={() => setResigning(null)}
          onConfirm={async (remark, dateIso) => {
            await hrApi.resignEmployee(resigning.id, dateIso, remark);
            await load();
          }}
        />
      )}
      {reinstating && (
        <ReasonDialog
          title={`รับกลับเข้าทำงาน: ${reinstating.fullName}`}
          confirmLabel="ยืนยัน"
          onClose={() => setReinstating(null)}
          onConfirm={async (remark) => {
            await hrApi.reinstateEmployee(reinstating.id, remark);
            await load();
          }}
        />
      )}
      {history && <HistoryDialog title={`ประวัติ: ${history.fullName}`} load={() => hrApi.employeeHistory(history.id)} onClose={() => setHistory(null)} />}
    </section>
  );
}

// ---------- ฟอร์มเพิ่ม / แก้ไข ----------
const PREFIXES = ["นาย", "นาง", "นางสาว", "Mr.", "Mrs.", "Ms."];

function EmployeeFormDialog({ employee, onClose, onSaved }: { employee: Employee | null; onClose: () => void; onSaved: () => void }) {
  const closeRef = useRef<() => void>(() => {});
  const [code, setCode] = useState(employee?.code ?? "");
  const [prefix, setPrefix] = useState(employee?.prefix ?? "");
  const [firstName, setFirstName] = useState(employee?.firstName ?? "");
  const [lastName, setLastName] = useState(employee?.lastName ?? "");
  const [position, setPosition] = useState(employee?.position ?? "");
  const [idType, setIdType] = useState<EmployeeIdType>(employee?.idType ?? "CITIZEN");
  const [idNumber, setIdNumber] = useState(employee?.idNumber ?? "");
  const [birthText, setBirthText] = useState(employee?.birthDate ? isoToDisplayDate(employee.birthDate) : "");
  const [startText, setStartText] = useState(employee?.startDate ? isoToDisplayDate(employee.startDate) : "");
  const [salaryText, setSalaryText] = useState(employee ? String(employee.baseSalary) : "");
  const [allowanceText, setAllowanceText] = useState(employee && employee.otherAllowance ? String(employee.otherAllowance) : "");
  const [socialSecurity, setSocialSecurity] = useState(employee?.socialSecurity ?? true);
  const [withholdTax, setWithholdTax] = useState(employee?.withholdTax ?? true);
  const [note, setNote] = useState(employee?.note ?? "");
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    const fail = (text: string) => setError(text);
    if (!code.trim()) return fail("ใส่รหัสพนักงาน");
    if (!firstName.trim()) return fail("ใส่ชื่อ");
    if (!idNumber.trim()) return fail("ใส่เลขประจำตัว");
    const salary = moneyOf(salaryText);
    if (salary === null || !Number.isFinite(salary) || salary <= 0) return fail("เงินเดือนไม่ถูกต้อง");
    const allowance = moneyOf(allowanceText) ?? 0;
    if (!Number.isFinite(allowance)) return fail("ค่าลดหย่อนอื่นๆ ไม่ถูกต้อง");
    const birthDate = birthText.trim() ? displayDateToIso(digits(birthText)) : null;
    if (birthText.trim() && !birthDate) return fail("วันเกิดไม่ถูกต้อง");
    const startDate = startText.trim() ? displayDateToIso(digits(startText)) : null;
    if (startText.trim() && !startDate) return fail("วันเริ่มงานไม่ถูกต้อง");
    if (employee && !remark.trim()) return fail("กรุณาระบุเหตุผลที่แก้ข้อมูล");
    const input: EmployeeInput = {
      code: code.trim(),
      prefix: prefix.trim() || null,
      firstName: firstName.trim(),
      lastName: lastName.trim() || null,
      position: position.trim() || null,
      idType,
      idNumber: idNumber.trim(),
      birthDate,
      startDate,
      baseSalary: salary,
      socialSecurity,
      withholdTax,
      otherAllowance: allowance,
      note: note.trim() || null,
    };
    setBusy(true);
    try {
      if (employee) await hrApi.updateEmployee(employee.id, { ...input, remark: remark.trim(), expectedUpdatedAt: employee.updatedAt });
      else await hrApi.createEmployee(input);
      onSaved();
      closeRef.current();
    } catch (err) {
      fail(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <HrDialog title={employee ? `แก้ข้อมูล: ${employee.fullName}` : "เพิ่มพนักงาน"} onClose={onClose} width={680} closeRef={closeRef}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 14 }}>
        <label className="field">
          รหัสพนักงาน *
          <input type="text" value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} placeholder="TI013" />
        </label>
        <label className="field">
          คำนำหน้า
          <input type="text" value={prefix} onChange={(e) => setPrefix(e.target.value)} list="hr-prefixes" maxLength={20} />
          <datalist id="hr-prefixes">
            {PREFIXES.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label className="field">
          ชื่อ *
          <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={100} />
        </label>
        <label className="field">
          นามสกุล
          <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={100} />
        </label>
        <label className="field">
          ตำแหน่ง
          <input type="text" value={position} onChange={(e) => setPosition(e.target.value)} maxLength={100} />
        </label>
        <label className="field">
          ประเภทเลขประจำตัว
          <select value={idType} onChange={(e) => setIdType(e.target.value as EmployeeIdType)}>
            <option value="CITIZEN">บัตรประชาชน 13 หลัก</option>
            <option value="OTHER">เลขอื่น (พาสปอร์ต / บัตรต่างด้าว)</option>
          </select>
        </label>
        <label className="field">
          เลขประจำตัว *
          <input type="text" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} maxLength={30} inputMode="numeric" />
        </label>
        <label className="field">
          วันเกิด
          <DateInput value={birthText} onChange={(v) => setBirthText(formatDateDigitsCe(digits(v)))} placeholder="วว/ดด/ปปปป (พ.ศ. ได้)" />
        </label>
        <label className="field">
          วันเริ่มงาน
          <DateInput value={startText} onChange={(v) => setStartText(formatDateDigitsCe(digits(v)))} placeholder="วว/ดด/ปปปป" />
        </label>
        <label className="field">
          เงินเดือน (บาท) *
          <input type="text" inputMode="decimal" value={salaryText} onChange={(e) => setSalaryText(e.target.value)} placeholder="25,000" />
        </label>
        <label className="field">
          ค่าลดหย่อนอื่นๆ ต่อปี (บาท)
          <input type="text" inputMode="decimal" value={allowanceText} onChange={(e) => setAllowanceText(e.target.value)} placeholder="คู่สมรส บุตร เบี้ยประกัน ฯลฯ" />
        </label>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 22, margin: "14px 0 4px" }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={socialSecurity} onChange={(e) => setSocialSecurity(e.target.checked)} />
          อยู่ในประกันสังคม (หัก 5% ของเงินเดือน เพดานตามปี)
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={withholdTax} onChange={(e) => setWithholdTax(e.target.checked)} />
          หักภาษี ณ ที่จ่าย (ภ.ง.ด.1)
        </label>
      </div>
      <label className="field" style={{ marginTop: 10 }}>
        หมายเหตุ
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
      {employee && (
        <label className="field" style={{ marginTop: 14 }}>
          เหตุผลที่แก้ *
          <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={500} placeholder="เช่น ปรับเงินเดือนประจำปี" />
        </label>
      )}
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions" style={{ marginTop: 14 }}>
        <button type="button" className="primary" disabled={busy} onClick={save}>
          {busy ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </div>
    </HrDialog>
  );
}

// ---------- นำเข้าจาก Excel ----------
function ImportPanel({ onDone }: { onDone: () => void }) {
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const rows = useMemo(() => parseEmployeePaste(pasted), [pasted]);
  const valid = rows.filter((r) => r.input);
  const invalid = rows.length - valid.length;

  async function submit() {
    setBusy(true);
    setMessage({ text: "กำลังนำเข้า…" });
    try {
      const r = await hrApi.importEmployees(valid.map((v) => v.input!));
      const skipped = r.skipped.length ? ` · ข้าม ${r.skipped.length} คน (${r.skipped.map((s) => `${s.code}: ${s.reason}`).join(", ")})` : "";
      setMessage({ text: `นำเข้าแล้ว ${r.created} คน${skipped}` });
      setPasted("");
      onDone();
    } catch (err) {
      setMessage({ text: errorText(err, "นำเข้าไม่สำเร็จ"), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 20, padding: "20px 23px", overflow: "visible" }}>
      <h2 style={{ marginBottom: 10 }}>นำเข้าจาก Excel</h2>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
        คัดลอกแถวพนักงานจาก Excel มาวาง เรียงคอลัมน์: รหัส · คำนำหน้า · ชื่อ-สกุล · ตำแหน่ง · เลขประจำตัว · (คอลัมน์ที่ 6 ไม่ใช้) · วันเกิด · เงินเดือน · ประกันสังคม
        (ช่องประกันสังคมว่าง / &quot;-&quot; = ไม่เข้าประกันสังคม) รหัสหรือเลขประจำตัวที่มีในระบบแล้วจะถูกข้าม ไม่ทับข้อมูลเดิม
      </p>
      <label className="field" style={{ marginTop: 10 }}>
        <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} style={{ fontFamily: "monospace", fontSize: 13 }} placeholder="วางแถวพนักงานที่นี่" />
      </label>
      {rows.length > 0 && (
        <>
          <p style={{ fontSize: 13, marginTop: 10 }}>
            อ่านได้ {valid.length} คน
            {invalid > 0 && <span className="customer-message error"> · มีปัญหา {invalid} แถว (แก้ใน Excel แล้ววางใหม่ - ระบบไม่นำเข้าถ้ายังมีแถวที่มีปัญหา)</span>}
          </p>
          <div className="table-wrap" style={{ maxHeight: 340, overflow: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>แถว</th>
                  <th>รหัส</th>
                  <th>ชื่อ-สกุล</th>
                  <th>ตำแหน่ง</th>
                  <th>เลขประจำตัว</th>
                  <th>วันเกิด</th>
                  <th style={{ textAlign: "right" }}>เงินเดือน</th>
                  <th>ประกันสังคม</th>
                  <th>ตรวจ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td style={{ fontFamily: "monospace" }}>{r.input?.code}</td>
                    <td>{r.input ? [r.input.prefix, r.input.firstName, r.input.lastName].filter(Boolean).join(" ") : ""}</td>
                    <td>{r.input?.position}</td>
                    <td style={{ fontFamily: "monospace" }}>{r.input ? maskId(r.input.idNumber) : ""}</td>
                    <td>{r.input?.birthDate ? isoToDisplayDate(r.input.birthDate) : ""}</td>
                    <td style={{ textAlign: "right" }}>{r.input ? formatMoney(r.input.baseSalary) : ""}</td>
                    <td>{r.input ? (r.input.socialSecurity ? "เข้า" : "ไม่เข้า") : ""}</td>
                    <td>
                      {r.errors.map((t) => (
                        <div key={t} className="customer-message error">
                          {t}
                        </div>
                      ))}
                      {r.warnings.map((t) => (
                        <div key={t} className="muted">
                          {t}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="form-actions" style={{ marginTop: 14 }}>
        <button type="button" className="primary" disabled={busy || valid.length === 0 || invalid > 0} onClick={submit}>
          นำเข้า {valid.length} คน
        </button>
        {message.text && (
          <div className={`customer-message${message.error ? " error" : " success"}`} role="status">
            {message.text}
          </div>
        )}
      </div>
    </section>
  );
}

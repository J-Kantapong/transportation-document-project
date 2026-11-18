// แถบแจ้งในฟอร์มยื่นว่าเติมข้อมูลจากการรับงานของหน้ารวมงานรถเก่าให้แล้ว (คู่กับ lib/use-intake-prefill.ts)
export function IntakeNotice({ state }: { state: { notice: string; error: boolean } }) {
  if (!state.notice) return null;
  return (
    <div className={`customer-message${state.error ? " error" : " success"}`} role="status" style={{ marginBottom: 16 }}>
      {state.notice}
    </div>
  );
}

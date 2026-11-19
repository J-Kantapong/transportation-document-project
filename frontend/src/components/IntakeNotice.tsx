// แถบแจ้งในฟอร์มยื่นว่าเติมข้อมูลจากการรับงานของหน้ารวมงานรถเก่าให้แล้ว (คู่กับ lib/use-intake-prefill.ts)
import { Notice } from "./ui";

export function IntakeNotice({ state }: { state: { notice: string; error: boolean } }) {
  if (!state.notice) return null;
  return (
    <Notice tone={state.error ? "error" : "success"}>{state.notice}</Notice>
  );
}

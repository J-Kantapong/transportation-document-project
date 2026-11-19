# UI patterns (one look, one direction, every page)

User request 2026-11-19: every page must use the same icons, layout, direction and messages, so a user can guess where to go next the same way they can on common websites. User-facing labels stay Thai; nothing about fields or workflows changes.

Building blocks: `frontend/src/components/ui.tsx` (`BackLink`, `PageHeader`, `Notice`, `LoadingState`, `EmptyState`, `Req`), `frontend/src/components/Icon.tsx` (the only icon set), `frontend/src/lib/toast.ts`, `frontend/src/lib/confirm-dialog.ts`. CSS lives in the "รูปแบบกลางของทั้งแอป" block at the end of `app/globals.css`.

Decisions taken with Claude's recommended defaults (the user said "ทำต่อ" without picking, 2026-11-19). Change them here first if the user asks.

## Direction

| Where | Rule |
|---|---|
| Back | `BackLink` / `PageHeader back=` at the top-left above the `h1`. The label is the parent page's name ("วางบิล"), never "กลับไปหน้า…" / "ก่อนหน้า". The topbar breadcrumb stays as well. |
| Page header | `PageHeader`: title + one-line subtitle on the left, page actions on the right. The main action is the right-most one. |
| Form footer | `.form-actions`, right-aligned: **[ยกเลิก] [บันทึก]**. In JSX the cancel (`secondary`) comes first and the `primary` last. Status text goes in `.form-actions-note`, which sits on the left. On a phone the buttons stack with the primary on top. |
| Dialog footer | The same order (`.dialog-actions` or `.form-actions`), and the close button is an icon `x` at the top-right (`<button className="close" aria-label="ปิด"><Icon name="x" /></button>`). |
| Multi-step flow | `.step-actions`: the previous step on the left (`secondary` + `arrow-left`), the next step on the right (`primary` + `arrow-right`). |
| Tables | Row selection checkbox in the first column, row actions in the last column. |
| Menu cards | `ChoiceMenu` style: number on the left, `chevron-right` on the right. |

## Buttons

- `primary`: one per area, for the action that moves the work forward (บันทึก, ถัดไป, ยืนยัน). `primary danger` is for a destructive confirm.
- `secondary`: a bordered button for ยกเลิก, ปิด, and secondary choices next to a primary. `secondary danger` is for a destructive non-final action.
- `text-button`: an in-line link-style action (แก้, ดู, a link in a table row). Never use it for a form's cancel.
- No other button class names.

## Icons

Use `<Icon name=... />` only. No emoji (📷 🧾 🖨 ⏳ …) and no glyphs standing in for icons (← → › ✎ ⚠ × ✕ ✓ ↻ ↗). Each meaning has one icon:

| Meaning | Icon |
|---|---|
| back / previous | `arrow-left` |
| next / go on / open in place | `arrow-right` |
| card or row that opens | `chevron-right` |
| expand / collapse | `chevron-down` / `chevron-up` |
| opens in a new tab | `external-link` |
| close / remove item | `x` |
| done tick (in text) | `tick` |
| edit | `pencil` |
| delete / cancel record | `trash` |
| reload | `refresh` |
| upload / attach photo | `upload` / `camera` / `paperclip` |
| download / PDF / Excel | `download` |
| print | `printer` |
| photo | `image` |
| receipt | `receipt` |
| document | `file-text` |
| registration book | `book` |
| warning | `alert-triangle` |
| error | `alert-circle` |
| info | `info` |
| success | `check-circle` |
| add | `plus` |
| search | `search` |
| date | `calendar` |
| copy | `copy` |
| view | `eye` |

Sizes come from CSS: 20px in general, 18px in `primary` / `secondary`, and 16px in `text-button` / `back-link`.

## Inputs

- `<label className="field">ป้ายชื่อ <Req /><input …/></label>`: the label is above the control.
- A required field has both `required` (or the page's own check) **and** `<Req />`. Do not write a text `*`.
- An optional field gets no marker. "(ถ้ามี)" may stay where it explains something.
- A field-level error is `<p className="field-error">` directly under the control.
- Dates use `DateInput` only.

## Messages

| Situation | Use |
|---|---|
| Error from a load or save | `<Notice tone="error">{error}</Notice>` in the page, near the action, kept until fixed. Never `empty-customers` for an error. |
| Saved / done after a click | `toast.success("บันทึกแล้ว")` (top-right, fades out). |
| Something to watch | `<Notice tone="warn">`, or `badge warn` inside a table. |
| Explanation | `<Notice tone="info">` |
| Confirm before an action | `confirmDialog(...)` (`danger: true` when destructive). Never `window.confirm`. |
| Loading | `<LoadingState />`, with the text "กำลังโหลด…" (always `…`, never `...`). |
| No data | `<EmptyState>ยังไม่มี…</EmptyState>`. Inside a table, use a `td colSpan` with class `muted`. |

## Colours

Semantic colour comes only from the tokens: `--danger`, `--warn`, `--ok`, `--info` and their `-soft` / `-line` variants. Do not use a raw hex such as `#c0392b`, `#c2410c`, `#b45309`, `#a86200` or `#9a4f12` for a meaning.

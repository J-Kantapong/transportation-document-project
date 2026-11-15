# Yamaha relocation (งานแจ้งย้ายยามาฮ่า)

Project documentation for Claude Code and Codex. Moved here unchanged from `CLAUDE.md` on 2026-11-16 to keep that file short; `CLAUDE.md` holds the index. Update this file when the feature changes.

- งานแจ้งย้ายยามาฮ่า (`/registration/yamaha-relocation/{small,large}`): every daily count entry must carry ใบเสร็จ and Report attachments, one or more files each (max 10 per kind; image or PDF, required on both frontend and backend, added 2026-09-22; multiple files 2026-09-30, migration `20260930100000_yamaha_multiple_attachments`). `POST /api/yamaha-relocation` is multipart (`date`, `size`, `count`, files `receipt` + `report`, repeatable). Files live in the shared photo storage (R2 or local disk) under `yamaha-relocation/` and are served by `GET /api/yamaha-relocation/attachments/:id/file`.

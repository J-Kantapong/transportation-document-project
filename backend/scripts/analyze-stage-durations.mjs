// อ่านอย่างเดียว: สถิติระยะเวลาของแต่ละขั้น (วัน) เพื่อกำหนด SLA ของหน้าภาพรวมผู้บริหาร (STAGES ใน src/overview/overview-process.ts)
// ไม่พิมพ์ข้อมูลลูกค้า มีแต่ตัวเลขรวม · ใช้: node --env-file=.env scripts/analyze-stage-durations.mjs
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const DAY = 86400000;
const today = new Date();
const days = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / DAY) : null);
const age = (d) => days(d, today);
const pct = (arr, p) => {
  const s = [...arr].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};

const rows = [];
function stat(stage, values, openAges = []) {
  const v = values.filter((x) => x !== null && x >= 0);
  rows.push({
    stage,
    n: v.length,
    median: pct(v, 0.5),
    p75: pct(v, 0.75),
    p90: pct(v, 0.9),
    max: v.length ? Math.max(...v) : null,
    openNow: openAges.length,
    openMax: openAges.length ? Math.max(...openAges) : null,
  });
}

const vehicles = await prisma.vehicle.findMany({
  where: { deletedAt: null },
  select: {
    date: true,
    transferDone: true,
    transferCompletedDate: true,
    inspectionSentDate: true,
    inspectionResultDate: true,
    plateReceivedDate: true,
    bookReceivedDate: true,
    deliveredDate: true,
    plateDeliveredDate: true,
    documentSubmissions: { orderBy: { createdAt: 'asc' }, select: { status: true, submitDate: true, receiptDate: true, receiptReceivedDate: true } },
    invoiceLines: { where: { invoice: { status: { not: 'VOID' } } }, take: 1, select: { invoice: { select: { issueDate: true, paidDate: true } } } },
  },
});
console.log('vehicles', vehicles.length);

const keys = ['transfer', 'inspectSend', 'inspectResult', 'submit', 'receipt', 'plate', 'book', 'delivery', 'plateDelivery', 'billing', 'toPaid'];
const done = Object.fromEntries(keys.map((k) => [k, []]));
const open = Object.fromEntries(keys.map((k) => [k, []]));
for (const v of vehicles) {
  const subs = v.documentSubmissions;
  const good = subs.filter((s) => s.status !== 'FAILED');
  const last = subs[subs.length - 1];
  const received = good.find((s) => s.status === 'RECEIPT_RECEIVED');
  const receiptDay = received ? (received.receiptDate ?? received.receiptReceivedDate ?? received.submitDate) : null;
  const plateFloor = v.plateReceivedDate && v.deliveredDate ? (v.plateReceivedDate > v.deliveredDate ? v.plateReceivedDate : v.deliveredDate) : null;
  const inv = v.invoiceLines[0]?.invoice;

  done.transfer.push(days(v.date, v.transferCompletedDate));
  done.inspectSend.push(days(v.transferCompletedDate ?? v.date, v.inspectionSentDate));
  done.inspectResult.push(days(v.inspectionSentDate, v.inspectionResultDate));
  done.submit.push(days(v.inspectionResultDate, good[0]?.submitDate));
  done.receipt.push(days(received?.submitDate, receiptDay));
  done.plate.push(days(receiptDay, v.plateReceivedDate));
  done.book.push(days(receiptDay, v.bookReceivedDate));
  done.delivery.push(days(v.bookReceivedDate, v.deliveredDate));
  done.plateDelivery.push(days(plateFloor, v.plateDeliveredDate));
  done.billing.push(days(v.deliveredDate, inv?.issueDate));
  done.toPaid.push(days(inv?.issueDate, inv?.paidDate));

  if (!v.deliveredDate) {
    if (last?.status === 'PENDING') open.receipt.push(age(last.submitDate));
    else if (last?.status === 'RECEIPT_RECEIVED') {
      if (!v.plateReceivedDate) open.plate.push(age(receiptDay));
      if (!v.bookReceivedDate) open.book.push(age(receiptDay));
      if (v.bookReceivedDate) open.delivery.push(age(v.bookReceivedDate));
    } else if (!v.transferDone) open.transfer.push(age(v.date));
    else if (!v.inspectionSentDate) open.inspectSend.push(age(v.transferCompletedDate ?? v.date));
    else if (!v.inspectionResultDate) open.inspectResult.push(age(v.inspectionSentDate));
    else open.submit.push(age(v.inspectionResultDate));
  } else {
    if (v.plateReceivedDate && !v.plateDeliveredDate) open.plateDelivery.push(age(plateFloor));
    if (!inv) open.billing.push(age(v.deliveredDate));
  }
}
for (const k of keys) stat(`new:${k}`, done[k], open[k]);

for (const [model, field] of [['plateSwap', 'returnedDate'], ['taxRenewal', 'paymentDate'], ['vehicleUseCancellation', 'returnedDate'], ['vehicleMoveOut', 'returnedDate'], ['plateCopy', 'returnedDate'], ['vehicleTransfer', 'returnedDate']]) {
  const list = await prisma[model].findMany({ where: { cancelledAt: null } });
  stat(`${model}:submit->${field}`, list.map((r) => days(r.submitDate, r[field])), list.filter((r) => !r[field]).map((r) => age(r.submitDate)));
  if (model === 'plateCopy') stat('plateCopy:submit->plateReceived', list.map((r) => days(r.submitDate, r.plateReceivedDate)), list.filter((r) => !r.plateReceivedDate).map((r) => age(r.submitDate)));
  if (model === 'vehicleTransfer') {
    const t = list.filter((r) => r.transferType === 'INSPECTION');
    stat('transfer:submit->inspectionSent', t.map((r) => days(r.submitDate, r.inspectionSentDate)), t.filter((r) => !r.inspectionSentDate).map((r) => age(r.submitDate)));
    stat('transfer:sent->result', t.map((r) => days(r.inspectionSentDate, r.inspectionResultDate)), t.filter((r) => r.inspectionSentDate && !r.inspectionResultDate).map((r) => age(r.inspectionSentDate)));
  }
}
console.table(rows);
await prisma.$disconnect();

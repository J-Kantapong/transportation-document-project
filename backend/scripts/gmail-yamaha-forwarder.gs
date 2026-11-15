/**
 * Google Apps Script: ส่งเมลแจ้งโอน / PO / Delivery Order ของไทยยามาฮ่าจาก Gmail เข้าเลขา (POST /api/secretary/mail) - ผู้ใช้ 2026-11-16
 *
 * ติดตั้ง (ทำครั้งเดียวในบัญชี Gmail ที่เมลถูกส่งต่อมา):
 *  1. เปิด https://script.google.com > New project > วางไฟล์นี้ทั้งไฟล์
 *  2. Project Settings > Script Properties เพิ่ม 2 ค่า (ห้ามพิมพ์ค่าลงในโค้ด):
 *       BACKEND_URL    = ที่อยู่ backend เช่น https://<ชื่อ>.onrender.com
 *       SECRETARY_KEY  = ค่าเดียวกับ SECRETARY_RUN_KEY บน Render
 *  3. เลือกฟังก์ชัน installTrigger แล้วกด Run หนึ่งครั้ง (Google จะขอสิทธิ์อ่าน Gmail และเรียกเว็บภายนอก)
 *     จากนั้นสคริปต์ทำงานเองทุก 15 นาที
 *
 * ทำงานอย่างไร: หาเมลจากผู้ส่งของยามาฮ่าใน SENDERS (แจ้งโอนเงิน / PO / Delivery Order) ใน 14 วันล่าสุดที่ยังไม่มีป้าย "bot-sent" ส่งหัวเรื่อง + เนื้อความ
 * ให้ backend แล้วติดป้าย "bot-sent" เมื่อ backend ตอบรับ (ส่งไม่สำเร็จ = ไม่ติดป้าย รอบหน้าลองใหม่) ไม่ลบ ไม่แก้ ไม่ตอบเมลใดๆ
 */
// finance = แจ้งวันโอนเงิน · accounting.info = แจ้ง PO · purchasing = แจ้งรับ/ยกเลิก Delivery Order (เพิ่ม 2026-11-16)
// ถ้าสคริปต์อยู่ในกล่องที่รับเมลส่งต่อ ตัวกรองของกล่องต้นทางต้องส่งต่อทั้ง 3 ผู้ส่งนี้
var SENDERS = ['finance@yamaha-motor.co.th', 'accounting.info@yamaha-motor.co.th', 'purchasing@yamaha-motor.co.th'];
var DONE_LABEL = 'bot-sent';
var MAX_PER_RUN = 20;

function forwardYamahaMails() {
  var props = PropertiesService.getScriptProperties();
  var url = (props.getProperty('BACKEND_URL') || '').replace(/\/+$/, '');
  var key = props.getProperty('SECRETARY_KEY') || '';
  if (!url || !key) throw new Error('ยังไม่ได้ตั้ง BACKEND_URL / SECRETARY_KEY ใน Script Properties');

  var label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  var threads = GmailApp.search('from:(' + SENDERS.join(' OR ') + ') newer_than:14d -label:' + DONE_LABEL, 0, MAX_PER_RUN);
  if (threads.length === 0) return;

  var messages = [];
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      messages.push({ id: m.getId(), from: m.getFrom(), subject: m.getSubject(), body: m.getPlainBody() });
    });
  });

  var response = UrlFetchApp.fetch(url + '/api/secretary/mail', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-secretary-key': key },
    payload: JSON.stringify({ messages: messages.slice(0, MAX_PER_RUN) }),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    // ไม่ติดป้าย = รอบถัดไปส่งใหม่ (เช่น backend เพิ่งตื่นจากหลับ)
    throw new Error('backend ตอบ ' + response.getResponseCode());
  }
  threads.forEach(function (thread) {
    thread.addLabel(label);
  });
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'forwardYamahaMails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('forwardYamahaMails').timeBased().everyMinutes(15).create();
  forwardYamahaMails();
}

import {vehicleApi} from './vehicles.js';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const fields=['name','company','branch','address','taxId','phone','email'];
function database(env){if(!env.DB)throw new Error('Database unavailable');return env.DB;}
export default {async fetch(request,env){
 const url=new URL(request.url);
 const asset=typeof SITE_ASSETS!=='undefined'?SITE_ASSETS[url.pathname]:null;
 if(asset&&(request.method==='GET'||request.method==='HEAD'))return new Response(request.method==='HEAD'?null:asset,{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
 const vehicleResponse=await vehicleApi(request,env);if(vehicleResponse)return vehicleResponse;
 if(url.pathname==='/api/customers'){
  try{
   if(request.method==='GET'){
    const result=await database(env).prepare('SELECT id,name,company,branch,address,tax_id AS taxId,phone,email,created_at AS createdAt FROM customers ORDER BY created_at DESC,id DESC').all();
    return json({customers:result.results});
   }
   if(request.method==='POST'){
    if(request.headers.get('Origin')!==url.origin)return json({error:'ไม่สามารถบันทึกจากหน้านี้ได้'},403);
    if(!request.headers.get('Content-Type')?.includes('application/json'))return json({error:'รูปแบบข้อมูลไม่ถูกต้อง'},415);
    const raw=await request.text();if(raw.length>12000)return json({error:'ข้อมูลยาวเกินกำหนด'},413);
    let body;try{body=JSON.parse(raw)}catch{return json({error:'รูปแบบข้อมูลไม่ถูกต้อง'},400)}
    if(!body||typeof body!=='object'||!fields.every(k=>typeof body[k]==='string'))return json({error:'กรุณาตรวจสอบข้อมูลลูกค้า'},400);
    const c=Object.fromEntries(fields.map(k=>[k,body[k].trim()]));
    if(!c.name||fields.some(k=>c[k].length>(k==='address'?2000:250)))return json({error:'กรุณากรอกชื่อลูกค้าและตรวจสอบความยาวข้อมูล'},400);
    if(c.taxId&&!/^\d{13}$/.test(c.taxId))return json({error:'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก'},400);
    if(c.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))return json({error:'กรุณาตรวจสอบอีเมล'},400);
    if(typeof body.id!=='string'||!/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.id))return json({error:'รหัสรายการไม่ถูกต้อง'},400);
    const createdAt=new Date().toISOString();
    await database(env).prepare('INSERT INTO customers (id,name,company,branch,address,tax_id,phone,email,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(body.id,c.name,c.company,c.branch,c.address,c.taxId,c.phone,c.email,createdAt).run();
    return json({id:body.id},201);
   }
   return json({error:'Method not allowed'},405);
  }catch(error){console.error('Customer database error',error);return json({error:'ไม่สามารถเชื่อมต่อฐานข้อมูลได้ กรุณาลองอีกครั้ง'},503)}
 }
 if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
 if(url.pathname!=='/')return new Response('Not found',{status:404});
 return new Response(request.method==='HEAD'?null:HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'}});
}};

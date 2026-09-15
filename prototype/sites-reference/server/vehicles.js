import {normalizeVehicle,vehicleErrors,vehicleColumns} from '../shared/vehicle-data.js';
const vjson=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
function vdatabase(env){if(!env.DB)throw new Error('Database unavailable');return env.DB;}
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export async function vehicleApi(request,env){
 const path=new URL(request.url).pathname;
 if(!['/api/brands','/api/vehicles'].includes(path))return null;
 try{
  const db=vdatabase(env);
  if(request.method==='GET'){
   if(path==='/api/brands')return vjson({brands:(await db.prepare('SELECT id,name FROM brands ORDER BY name').all()).results});
   return vjson({vehicles:(await db.prepare('SELECT v.*,c.name AS customerName,b.name AS brandName FROM vehicles v JOIN customers c ON c.id=v.customer_id JOIN brands b ON b.id=v.brand_id ORDER BY v.created_at DESC,v.id DESC LIMIT 100').all()).results});
  }
  if(request.method!=='POST')return vjson({error:'Method not allowed'},405);
  if(request.headers.get('Origin')!==new URL(request.url).origin)return vjson({error:'ไม่สามารถบันทึกจากหน้านี้ได้'},403);
  if(!request.headers.get('Content-Type')?.includes('application/json'))return vjson({error:'รูปแบบข้อมูลไม่ถูกต้อง'},415);
  const raw=await request.text();if(raw.length>500000)return vjson({error:'ข้อมูลเกินขนาดที่รองรับ'},413);
  let body;try{body=JSON.parse(raw)}catch{return vjson({error:'รูปแบบข้อมูลไม่ถูกต้อง'},400)}
  if(path==='/api/brands'){
   const name=typeof body?.name==='string'?body.name.trim():'';if(!name||name.length>100)return vjson({error:'กรุณากรอกชื่อยี่ห้อไม่เกิน 100 ตัวอักษร'},400);
   const id=crypto.randomUUID();await db.prepare('INSERT INTO brands (id,name) VALUES (?,?) ON CONFLICT(name) DO NOTHING').bind(id,name).run();
   return vjson({brand:await db.prepare('SELECT id,name FROM brands WHERE name=?').bind(name).first()},201);
  }
  if(!Array.isArray(body?.vehicles)||!body.vehicles.length||body.vehicles.length>100)return vjson({error:'รองรับ 1–100 รายการต่อครั้ง'},400);
  const customerIds=new Set((await db.prepare('SELECT id FROM customers').all()).results.map(x=>x.id));
  const brandIds=new Set((await db.prepare('SELECT id FROM brands').all()).results.map(x=>x.id));
  const errors=[],seen=new Set(),ids=new Set(),rows=[];
  for(let i=0;i<body.vehicles.length;i++){
   const input=body.vehicles[i],v=normalizeVehicle(input),e=vehicleErrors(v);
   if(!uuid(input?.id)||ids.has(input?.id))e.push('รหัสรายการไม่ถูกต้องหรือซ้ำ');ids.add(input?.id);
   if(!customerIds.has(v.customerId))e.push('ไม่พบลูกค้าในฐานข้อมูล');if(!brandIds.has(v.brandId))e.push('ไม่พบยี่ห้อในฐานข้อมูล');
   if(seen.has(v.chassis))e.push('เลขตัวถังซ้ำในชุดข้อมูล');seen.add(v.chassis);
   if(e.length)errors.push({row:i+1,errors:e});rows.push({...v,id:input?.id});
  }
  if(errors.length)return vjson({error:'กรุณาแก้ไขข้อมูลก่อนบันทึก',errors},400);
  for(let i=0;i<rows.length;i++){
   const v=rows[i];const existing=await db.prepare('SELECT * FROM vehicles WHERE id=? OR chassis=?').bind(v.id,v.chassis).all();
   for(const old of existing.results){if(old.id!==v.id)return vjson({error:'เลขตัวถัง '+v.chassis+' มีอยู่แล้ว',errors:[{row:i+1,errors:['เลขตัวถังมีอยู่แล้ว']}]},409);
    const map={customerId:'customer_id',brandId:'brand_id',registrationProvince:'registration_province',ownerProvince:'owner_province'};
    if(vehicleColumns.some(([k])=>old[map[k]||k]!==v[k]))return vjson({error:'รายการนี้เคยบันทึกแล้วด้วยข้อมูลต่างกัน กรุณาโหลดใหม่'},409);
   }
  }
  const now=new Date().toISOString();
  await db.batch(rows.map(v=>db.prepare('INSERT INTO vehicles (id,date,customer_id,chassis,engine,brand_id,fuel,cc,weight,color,body,registration_province,owner_province,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(v.id,...vehicleColumns.map(([k])=>v[k]),now)));
  return vjson({count:rows.length},201);
 }catch(error){console.error('Vehicle database error',error);return vjson({error:String(error.message).includes('UNIQUE')?'เลขตัวถังซ้ำกับรายการที่บันทึกแล้ว':'ไม่สามารถบันทึกหรือโหลดข้อมูลได้ กรุณาลองใหม่'},String(error.message).includes('UNIQUE')?409:503)}
}

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const uploadsDir = join(dataDir, 'uploads');
mkdirSync(uploadsDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'registro.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','field')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS equipment (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, brand TEXT NOT NULL, model TEXT NOT NULL, serial TEXT, interval_hours REAL NOT NULL, warning_hours REAL NOT NULL DEFAULT 50, current_hours REAL NOT NULL, last_service_hours REAL NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS readings (id INTEGER PRIMARY KEY, equipment_id INTEGER NOT NULL REFERENCES equipment(id), user_id INTEGER NOT NULL REFERENCES users(id), hours REAL NOT NULL, comments TEXT NOT NULL DEFAULT '', photo_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
for (const column of ['photo1', 'photo2']) {
  if (!db.prepare('PRAGMA table_info(readings)').all().some(row => row.name === column)) db.exec(`ALTER TABLE readings ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
}
db.exec('CREATE TABLE IF NOT EXISTS maintenance_events (id INTEGER PRIMARY KEY, equipment_id INTEGER NOT NULL REFERENCES equipment(id), user_id INTEGER NOT NULL REFERENCES users(id), hours REAL NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');

const initialUser = process.env.ADMIN_USER;
const initialPassword = process.env.ADMIN_PASSWORD;
if (initialUser && initialPassword) {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  if (existingAdmin) {
    db.prepare('UPDATE users SET username=?,password_hash=? WHERE id=?').run(initialUser, hashPassword(initialPassword), existingAdmin.id);
    console.log(`Credenciales de administrador actualizadas: ${initialUser}`);
  } else {
    db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(initialUser, hashPassword(initialPassword), 'admin');
    console.log(`Administrador inicial creado: ${initialUser}`);
  }
}
const sessions = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml' };
function hashPassword(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
function validPassword(password, stored) { const [salt,hex]=stored.split(':'); const actual=scryptSync(password,salt,64); const expected=Buffer.from(hex,'hex'); return actual.length===expected.length && timingSafeEqual(actual,expected); }
function send(res, status, data, headers={}) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers}); res.end(JSON.stringify(data)); }
async function body(req, limit=1_000_000) { let raw=''; for await (const part of req) { raw += part; if(raw.length>limit) throw new Error('Solicitud demasiado grande'); } return raw ? JSON.parse(raw) : {}; }
function userFor(req) { const sid=(req.headers.cookie||'').match(/(?:^|;\s*)sid=([^;]+)/)?.[1]; const session=sid && sessions.get(sid); return session?.expires>Date.now() ? session.user : null; }
function requireUser(req,res,role) { const user=userFor(req); if(!user) { send(res,401,{error:'Inicia sesión para continuar'}); return null; } if(role==='admin'&&user.role!=='admin') { send(res,403,{error:'Acceso exclusivo de administración'}); return null; } return user; }
function equipmentRows() { return db.prepare(`SELECT e.*, COALESCE((SELECT MAX(r.hours) FROM readings r WHERE r.equipment_id=e.id AND r.status!='rejected'),e.current_hours) AS latest_hours FROM equipment e ORDER BY e.code`).all().map(e=>{ const due=e.last_service_hours+e.interval_hours; const remaining=due-e.latest_hours; return {...e,due_hours:due,remaining_hours:remaining,maintenance_state:remaining<0?'urgent':remaining===0?'critical':remaining<=e.warning_hours?'near':'ok'}; }); }

const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/api/session'){ const user=userFor(req); return send(res,200,{user}); }
    if(req.method==='POST'&&url.pathname==='/api/login') { const b=await body(req); const row=db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username||'').trim()); if(!row||!validPassword(String(b.password||''),row.password_hash)) return send(res,401,{error:'Usuario o contraseña incorrectos'}); const sid=randomBytes(32).toString('hex'); sessions.set(sid,{user:{id:row.id,username:row.username,role:row.role},expires:Date.now()+12*60*60*1000}); return send(res,200,{user:{id:row.id,username:row.username,role:row.role}},{'Set-Cookie':`sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`}); }
    if(req.method==='POST'&&url.pathname==='/api/logout') { const sid=(req.headers.cookie||'').match(/(?:^|;\s*)sid=([^;]+)/)?.[1]; if(sid)sessions.delete(sid); return send(res,200,{ok:true},{'Set-Cookie':'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'}); }
    if(url.pathname.startsWith('/api/')) {
      const user=requireUser(req,res); if(!user)return;
      if(req.method==='GET'&&url.pathname==='/api/equipment') return send(res,200,{equipment:equipmentRows()});
      if(req.method==='GET'&&url.pathname==='/api/readings') { const query=`SELECT r.*,e.code,e.brand,e.model,u.username FROM readings r JOIN equipment e ON e.id=r.equipment_id JOIN users u ON u.id=r.user_id ${user.role==='admin'?'':'WHERE r.user_id=?'} ORDER BY r.id DESC LIMIT 500`; const readings=user.role==='admin'?db.prepare(query).all():db.prepare(query).all(user.id); return send(res,200,{readings}); }
      if(req.method==='POST'&&url.pathname==='/api/equipment') { if(user.role!=='admin')return send(res,403,{error:'Solo administración puede registrar equipos'}); const b=await body(req); const code=String(b.code||'').trim(),brand=String(b.brand||'').trim(),model=String(b.model||'').trim(); const interval=Number(b.interval_hours),hours=Number(b.current_hours),warning=Number(b.warning_hours??50); if(!code||!brand||!model||![interval,hours,warning].every(Number.isFinite)||interval<=0||hours<0||warning<0)return send(res,400,{error:'Completa los campos y revisa los valores numéricos'}); try { db.prepare('INSERT INTO equipment(code,brand,model,serial,interval_hours,warning_hours,current_hours,last_service_hours) VALUES(?,?,?,?,?,?,?,?)').run(code,brand,model,String(b.serial||'').trim(),interval,warning,hours,hours); return send(res,201,{ok:true}); } catch(e) { if(String(e.message).includes('UNIQUE'))return send(res,409,{error:'Ya existe un equipo con esa ficha'}); throw e; } }
      if(req.method==='POST'&&url.pathname==='/api/readings') {
        const b=await body(req,28*1024*1024),eid=Number(b.equipment_id),hours=Number(b.hours),photos=b.photos;
        const e=db.prepare('SELECT * FROM equipment WHERE id=?').get(eid);
        if(!e||!Number.isFinite(hours)||hours<e.current_hours)return send(res,400,{error:'Equipo inválido o lectura inferior al horómetro registrado'});
        if(!Array.isArray(photos)||photos.length!==2)return send(res,400,{error:'Debes adjuntar exactamente 2 fotos'});
        const allowed={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
        const saved=[];
        try {
          for(const photo of photos){
            if(!allowed[photo?.type]||typeof photo.data!=='string'||!photo.data.startsWith('data:'+photo.type+';base64,'))throw new Error('Las fotos deben ser JPG, PNG o WEBP');
            const bytes=Buffer.from(photo.data.slice(photo.data.indexOf(',')+1),'base64');
            if(!bytes.length||bytes.length>10*1024*1024)throw new Error('Cada foto debe pesar menos de 10 MB');
            const filename=`eq${eid}-${randomBytes(16).toString('hex')}.${allowed[photo.type]}`;
            const temporary=join(uploadsDir,filename+'.tmp');
            writeFileSync(temporary,bytes,{flag:'wx'}); renameSync(temporary,join(uploadsDir,filename)); saved.push(filename);
          }
          const previous=db.prepare("SELECT photo1,photo2 FROM readings WHERE equipment_id=? AND (photo1 <> '' OR photo2 <> '') ORDER BY id DESC LIMIT 1").get(eid);
          db.exec('BEGIN IMMEDIATE');
          const result=db.prepare('INSERT INTO readings(equipment_id,user_id,hours,comments,photo1,photo2) VALUES(?,?,?,?,?,?)').run(eid,user.id,hours,String(b.comments||'').slice(0,500),saved[0],saved[1]);
          db.prepare('UPDATE equipment SET current_hours=? WHERE id=?').run(hours,eid);
          if(previous)db.prepare("UPDATE readings SET photo1='',photo2='' WHERE equipment_id=? AND photo1=? AND photo2=?").run(eid,previous.photo1,previous.photo2);
          db.exec('COMMIT');
          if(previous)for(const old of [previous.photo1,previous.photo2])if(old)try{unlinkSync(join(uploadsDir,old))}catch{}
          return send(res,201,{ok:true,id:Number(result.lastInsertRowid)});
        } catch(error) {
          try{db.exec('ROLLBACK')}catch{}
          for(const filename of saved)try{unlinkSync(join(uploadsDir,filename))}catch{}
          if(['Las fotos deben ser JPG, PNG o WEBP','Cada foto debe pesar menos de 10 MB'].includes(error.message))return send(res,400,{error:error.message});
          throw error;
        }
      }
      if(req.method==='GET'&&url.pathname.startsWith('/api/photos/')) {
        const filename=decodeURIComponent(url.pathname.slice('/api/photos/'.length));
        if(!/^[a-zA-Z0-9-]+\.(jpg|png|webp)$/.test(filename))return send(res,404,{error:'Foto no encontrada'});
        const ownership=user.role==='admin'?db.prepare('SELECT 1 FROM readings WHERE photo1=? OR photo2=?').get(filename,filename):db.prepare('SELECT 1 FROM readings WHERE user_id=? AND (photo1=? OR photo2=?)').get(user.id,filename,filename);
        const path=join(uploadsDir,filename); if(!ownership||!existsSync(path))return send(res,404,{error:'Foto no encontrada'});
        const ext=extname(filename); res.writeHead(200,{'Content-Type':ext==='.jpg'?'image/jpeg':ext==='.png'?'image/png':'image/webp','Cache-Control':'private, max-age=3600'}); return createReadStream(path).pipe(res);
      }
      if(req.method==='POST'&&/^\/api\/equipment\/\d+\/maintenance$/.test(url.pathname)) {
        if(user.role!=='admin')return send(res,403,{error:'Solo administración puede registrar mantenimientos'});
        const [,id]=url.pathname.match(/^\/api\/equipment\/(\d+)\/maintenance$/),equipment=db.prepare('SELECT * FROM equipment WHERE id=?').get(Number(id));
        if(!equipment)return send(res,404,{error:'Equipo no encontrado'});
        const latest=db.prepare("SELECT MAX(hours) AS hours FROM readings WHERE equipment_id=? AND status!='rejected'").get(Number(id)).hours;
        const hours=latest??equipment.current_hours;
        db.exec('BEGIN IMMEDIATE');
        try{db.prepare('UPDATE equipment SET current_hours=?,last_service_hours=? WHERE id=?').run(hours,hours,Number(id));db.prepare('INSERT INTO maintenance_events(equipment_id,user_id,hours) VALUES(?,?,?)').run(Number(id),user.id,hours);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
        return send(res,200,{ok:true,hours});
      }
      if(req.method==='POST'&&/^\/api\/readings\/\d+\/(confirm|reject)$/.test(url.pathname)) { if(user.role!=='admin')return send(res,403,{error:'Solo administración puede procesar reportes'}); const [,id,action]=url.pathname.match(/^\/api\/readings\/(\d+)\/(confirm|reject)$/); const status=action==='confirm'?'confirmed':'rejected'; const reading=db.prepare('SELECT * FROM readings WHERE id=?').get(Number(id)); if(!reading||reading.status!=='pending')return send(res,409,{error:'Este reporte ya fue procesado o no existe'}); db.prepare('UPDATE readings SET status=? WHERE id=?').run(status,Number(id)); if(status==='rejected') { const latest=db.prepare("SELECT MAX(hours) AS hours FROM readings WHERE equipment_id=? AND status!='rejected'").get(reading.equipment_id).hours; const equipment=db.prepare('SELECT last_service_hours FROM equipment WHERE id=?').get(reading.equipment_id); db.prepare('UPDATE equipment SET current_hours=? WHERE id=?').run(latest??equipment.last_service_hours,reading.equipment_id); } return send(res,200,{ok:true}); }
      if(req.method==='POST'&&url.pathname==='/api/users') { if(user.role!=='admin')return send(res,403,{error:'Solo administración puede crear usuarios'}); const b=await body(req),username=String(b.username||'').trim(),password=String(b.password||''); if(username.length<3||password.length<8)return send(res,400,{error:'El usuario debe tener 3 caracteres y la contraseña al menos 8'}); try {db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,'field')").run(username,hashPassword(password));return send(res,201,{ok:true});}catch(e){if(String(e.message).includes('UNIQUE'))return send(res,409,{error:'Ese usuario ya existe'});throw e;} }
      return send(res,404,{error:'Ruta no encontrada'});
    }
    const pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname); const file=normalize(join(root,'public',pathname)); if(!file.startsWith(join(root,'public')))return send(res,404,{error:'No encontrado'}); if(!existsSync(file))return send(res,404,{error:'No encontrado'}); res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}); createReadStream(file).pipe(res);
  } catch(error) { console.error(error); send(res,500,{error:'Error interno del servidor'}); }
});
const port=Number(process.env.PORT||3000); server.listen(port,'0.0.0.0',()=>console.log(`Registro de Equipos disponible en http://localhost:${port}`));

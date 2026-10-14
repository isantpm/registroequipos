import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { connect as tlsConnect } from 'node:tls';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const uploadsDir = join(dataDir, 'uploads');
mkdirSync(uploadsDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'registro.db'));
db.exec('PRAGMA foreign_keys=ON');
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','field')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS equipment (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, brand TEXT NOT NULL, model TEXT NOT NULL, serial TEXT, interval_hours REAL NOT NULL, warning_hours REAL NOT NULL DEFAULT 50, current_hours REAL NOT NULL, last_service_hours REAL NOT NULL, assigned_user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS readings (id INTEGER PRIMARY KEY, equipment_id INTEGER NOT NULL REFERENCES equipment(id), user_id INTEGER NOT NULL REFERENCES users(id), hours REAL NOT NULL, comments TEXT NOT NULL DEFAULT '', photo_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
if (!db.prepare('PRAGMA table_info(equipment)').all().some(row => row.name === 'assigned_user_id')) db.exec('ALTER TABLE equipment ADD COLUMN assigned_user_id INTEGER REFERENCES users(id)');
for (const column of ['photo1', 'photo2']) {
  if (!db.prepare('PRAGMA table_info(readings)').all().some(row => row.name === column)) db.exec(`ALTER TABLE readings ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
}
db.exec('CREATE TABLE IF NOT EXISTS maintenance_events (id INTEGER PRIMARY KEY, equipment_id INTEGER NOT NULL REFERENCES equipment(id), user_id INTEGER NOT NULL REFERENCES users(id), hours REAL NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
for (const column of ['supplies', 'mechanic']) {
  if (!db.prepare('PRAGMA table_info(maintenance_events)').all().some(row => row.name === column)) db.exec(`ALTER TABLE maintenance_events ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
}
for (const [column, definition] of [['email', "TEXT NOT NULL DEFAULT ''"], ['user_type', "TEXT NOT NULL DEFAULT 'record'"], ['must_change_password', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare('PRAGMA table_info(users)').all().some(row => row.name === column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS password_reset_requests (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'pending')`);

const initialUser = process.env.ADMIN_USER;
const initialPassword = process.env.ADMIN_PASSWORD;
if (initialUser && initialPassword) {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  if (!existingAdmin) {
    db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(initialUser, hashPassword(initialPassword), 'admin');
    console.log(`Administrador inicial creado: ${initialUser}`);
  }
}
const sessions = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml' };
function hashPassword(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
function validPassword(password, stored) { const [salt,hex]=stored.split(':'); const actual=scryptSync(password,salt,64); const expected=Buffer.from(hex,'hex'); return actual.length===expected.length && timingSafeEqual(actual,expected); }
async function sendEmail(to,subject,message){const host=process.env.SMTP_HOST,port=Number(process.env.SMTP_PORT||465),username=process.env.SMTP_USER,password=process.env.SMTP_PASS,from=process.env.SMTP_FROM||username;if(!host||!username||!password||!from)throw new Error('Falta configurar el correo SMTP seguro del sistema');const socket=tlsConnect({host,port,servername:host}),lines=createInterface({input:socket});const replies=[];let wake;lines.on('line',line=>{replies.push(line);if(/^\d{3} /.test(line)){wake?.();wake=null}});const response=async()=>{if(!replies.some(x=>/^\d{3} /.test(x)))await new Promise((resolve,reject)=>{wake=()=>{clearTimeout(timer);resolve()};const timer=setTimeout(()=>reject(new Error('Tiempo agotado al conectar con el correo')),15000);socket.once('error',reject)});const block=replies.splice(0);const code=Number(block.at(-1)?.slice(0,3));if(code>=400)throw new Error('El servidor de correo rechazó la solicitud');return code};const command=async(line,expected)=>{socket.write(line+'\r\n');const code=await response();if(expected&&!expected.includes(code))throw new Error('No se pudo completar el envío de correo');return code};try{await new Promise((resolve,reject)=>{socket.once('secureConnect',resolve);socket.once('error',reject)});await response();await command('EHLO registro-equipos',[250]);await command('AUTH LOGIN',[334]);await command(Buffer.from(username).toString('base64'),[334]);await command(Buffer.from(password).toString('base64'),[235]);await command(`MAIL FROM:<${from}>`,[250]);await command(`RCPT TO:<${to}>`,[250,251]);await command('DATA',[354]);const safeSubject='=?UTF-8?B?'+Buffer.from(subject.replace(/[\r\n]/g,' ')).toString('base64')+'?=',safeFrom=from.replace(/[\r\n<>]/g,'');socket.write(`From: ${safeFrom}\r\nTo: ${to}\r\nSubject: ${safeSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(message,'utf8').toString('base64')}\r\n.\r\n`);await response();await command('QUIT',[221])}finally{lines.close();socket.destroy()}}
function send(res, status, data, headers={}) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers}); res.end(JSON.stringify(data)); }
async function body(req, limit=1_000_000) { let raw=''; for await (const part of req) { raw += part; if(raw.length>limit) throw new Error('Solicitud demasiado grande'); } return raw ? JSON.parse(raw) : {}; }
function userFor(req) { const sid=(req.headers.cookie||'').match(/(?:^|;\s*)sid=([^;]+)/)?.[1]; const session=sid && sessions.get(sid); return session?.expires>Date.now() ? session.user : null; }
function requireUser(req,res,role) { const user=userFor(req); if(!user) { send(res,401,{error:'Inicia sesión para continuar'}); return null; } if(role==='admin'&&user.role!=='admin') { send(res,403,{error:'Acceso exclusivo de administración'}); return null; } return user; }
function equipmentRows(user) { const all=user.role==='admin'||user.user_type==='transfer'; const where=all?'':'WHERE e.assigned_user_id=?'; const query=`SELECT e.*,u.username AS assigned_username,COALESCE((SELECT MAX(r.hours) FROM readings r WHERE r.equipment_id=e.id AND r.status!='rejected'),e.current_hours) AS latest_hours FROM equipment e LEFT JOIN users u ON u.id=e.assigned_user_id ${where} ORDER BY e.code`; const rows=all?db.prepare(query).all():db.prepare(query).all(user.id); return rows.map(e=>{ const due=e.last_service_hours+e.interval_hours; const remaining=due-e.latest_hours; return {...e,due_hours:due,remaining_hours:remaining,maintenance_state:remaining<0?'urgent':remaining===0?'critical':remaining<=e.warning_hours?'near':'ok'}; }); }

const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/api/session'){ const user=userFor(req); return send(res,200,{user}); }
    if(req.method==='POST'&&url.pathname==='/api/login') { const b=await body(req); const row=db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username||'').trim()); if(!row||!validPassword(String(b.password||''),row.password_hash)) return send(res,401,{error:'Usuario o contraseña incorrectos'}); const user={id:row.id,username:row.username,role:row.role,user_type:row.user_type,email:row.email,must_change_password:Boolean(row.must_change_password)}; const sid=randomBytes(32).toString('hex'); sessions.set(sid,{user,expires:Date.now()+12*60*60*1000}); return send(res,200,{user},{'Set-Cookie':`sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`}); }
    if(req.method==='POST'&&url.pathname==='/api/request-password-reset') { const b=await body(req),row=db.prepare('SELECT id,email,role FROM users WHERE username=?').get(String(b.username||'').trim()),matches=row?.email&&row.email.toLowerCase()===String(b.email||'').trim().toLowerCase();if(matches&&row.role==='admin'){const provisional=randomBytes(12).toString('base64url');try{await sendEmail(row.email,'Contraseña provisional - Control de Equipos',`Tu contraseña provisional es: ${provisional}\n\nAl iniciar sesión, el sistema te pedirá crear una contraseña nueva.`);db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?').run(hashPassword(provisional),row.id)}catch(error){return send(res,503,{error:error.message})}}else if(matches)db.prepare("INSERT INTO password_reset_requests(user_id) VALUES(?)").run(row.id);return send(res,200,{ok:true,message:'Si los datos coinciden, recibirás instrucciones en el correo o el administrador atenderá la solicitud.'}); }
    if(req.method==='POST'&&url.pathname==='/api/logout') { const sid=(req.headers.cookie||'').match(/(?:^|;\s*)sid=([^;]+)/)?.[1]; if(sid)sessions.delete(sid); return send(res,200,{ok:true},{'Set-Cookie':'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'}); }
    if(url.pathname.startsWith('/api/')) {
      const user=requireUser(req,res); if(!user)return;
      if(user.must_change_password&&url.pathname!=='/api/password/change')return send(res,403,{error:'Debes cambiar la contraseña provisional antes de continuar'});
      if(req.method==='POST'&&url.pathname==='/api/password/change'){const b=await body(req),password=String(b.password||'');if(password.length<8)return send(res,400,{error:'La contraseña debe tener al menos 8 caracteres'});db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(hashPassword(password),user.id);for(const s of sessions.values())if(s.user.id===user.id)s.user.must_change_password=false;user.must_change_password=false;return send(res,200,{ok:true});}
      if(req.method==='GET'&&url.pathname==='/api/equipment') return send(res,200,{equipment:equipmentRows(user)});
      if(req.method==='GET'&&url.pathname==='/api/users') { if(user.role!=='admin'&&user.user_type!=='transfer')return send(res,403,{error:'Sin permiso para consultar usuarios'}); return send(res,200,{users:db.prepare(user.role==='admin'?"SELECT id,username,email,user_type,created_at FROM users WHERE role='field' ORDER BY username":"SELECT id,username,email,user_type,created_at FROM users WHERE role='field' AND user_type='record' ORDER BY username").all()}); }
      if(req.method==='GET'&&url.pathname==='/api/reset-requests'){if(user.role!=='admin')return send(res,403,{error:'Solo administración puede consultar solicitudes'});return send(res,200,{requests:db.prepare("SELECT p.id,p.created_at,u.id AS user_id,u.username,u.email FROM password_reset_requests p JOIN users u ON u.id=p.user_id WHERE p.status='pending' ORDER BY p.id").all()});}
      if(req.method==='POST'&&/^\/api\/users\/\d+\/reset-password$/.test(url.pathname)){if(user.role!=='admin')return send(res,403,{error:'Solo administración puede restablecer contraseñas'});const [,id]=url.pathname.match(/^\/api\/users\/(\d+)\/reset-password$/),b=await body(req),password=String(b.password||'');if(password.length<8)return send(res,400,{error:'La nueva contraseña debe tener al menos 8 caracteres'});if(!db.prepare("SELECT id FROM users WHERE id=? AND role='field'").get(Number(id)))return send(res,404,{error:'Usuario no encontrado'});db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?').run(hashPassword(password),Number(id));db.prepare("UPDATE password_reset_requests SET status='completed' WHERE user_id=? AND status='pending'").run(Number(id));return send(res,200,{ok:true});}
      if(req.method==='POST'&&/^\/api\/users\/\d+\/email$/.test(url.pathname)){if(user.role!=='admin')return send(res,403,{error:'Solo administración puede actualizar correos'});const [,id]=url.pathname.match(/^\/api\/users\/(\d+)\/email$/),b=await body(req),email=String(b.email||'').trim();if(!/^\S+@\S+\.\S+$/.test(email))return send(res,400,{error:'Ingresa un correo válido'});const result=db.prepare("UPDATE users SET email=? WHERE id=? AND role='field'").run(email,Number(id));if(!result.changes)return send(res,404,{error:'Usuario no encontrado'});return send(res,200,{ok:true});}
      if(req.method==='POST'&&url.pathname==='/api/profile/email'){const b=await body(req),email=String(b.email||'').trim();if(!/^\S+@\S+\.\S+$/.test(email))return send(res,400,{error:'Ingresa un correo electrónico válido'});db.prepare('UPDATE users SET email=? WHERE id=?').run(email,user.id);user.email=email;for(const s of sessions.values())if(s.user.id===user.id)s.user.email=email;return send(res,200,{ok:true});}
      if(req.method==='POST'&&url.pathname==='/api/admin/password-reset-by-email'){if(user.role!=='admin')return send(res,403,{error:'Solo el administrador puede usar esta opción'});const b=await body(req),row=db.prepare("SELECT * FROM users WHERE id=? AND role='admin'").get(user.id),email=String(b.email||'').trim().toLowerCase();if(!row?.email||row.email.toLowerCase()!==email)return send(res,400,{error:'El correo no coincide con el registrado en la cuenta de administrador'});const provisional=randomBytes(12).toString('base64url');try{await sendEmail(email,'Contraseña provisional - Control de Equipos',`Tu contraseña provisional es: ${provisional}\n\nAl iniciar sesión, el sistema te pedirá crear una contraseña nueva.`)}catch(error){return send(res,503,{error:error.message})}db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?').run(hashPassword(provisional),user.id);for(const s of sessions.values())if(s.user.id===user.id)s.user.must_change_password=true;user.must_change_password=true;return send(res,200,{ok:true});}
      if(req.method==='GET'&&url.pathname==='/api/readings') { const query=`SELECT r.*,e.code,e.brand,e.model,u.username FROM readings r JOIN equipment e ON e.id=r.equipment_id JOIN users u ON u.id=r.user_id ${user.role==='admin'?'':'WHERE r.user_id=?'} ORDER BY r.id DESC LIMIT 500`; const readings=user.role==='admin'?db.prepare(query).all():db.prepare(query).all(user.id); return send(res,200,{readings}); }
      if(req.method==='GET'&&url.pathname==='/api/export/readings') { if(user.role!=='admin')return send(res,403,{error:'Solo administración puede exportar registros de toda la flota'});const rows=db.prepare('SELECT r.*,e.code,e.brand,e.model,u.username FROM readings r JOIN equipment e ON e.id=r.equipment_id JOIN users u ON u.id=r.user_id ORDER BY r.id DESC').all();const headers=['Fecha','Ficha','Marca','Modelo','Usuario','Horómetro','Observaciones','Estado','Foto 1','Foto 2'];const cell=value=>'"'+String(value??'').replaceAll('"','""')+'"',base=`${req.socket.encrypted?'https':'http'}://${req.headers.host||'localhost'}`;const csv='\ufeff'+[headers,...rows.map(r=>[r.created_at,r.code,r.brand,r.model,r.username,r.hours,r.comments,r.status,r.photo1?`${base}/api/photos/${encodeURIComponent(r.photo1)}`:'',r.photo2?`${base}/api/photos/${encodeURIComponent(r.photo2)}`:''])].map(row=>row.map(cell).join(',')).join('\r\n');res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="registros_de_horas.csv"','Cache-Control':'no-store'});return res.end(csv); }
      if(req.method==='GET'&&url.pathname==='/api/export/data') { if(user.role!=='admin')return send(res,403,{error:'Solo administración puede exportar registros de toda la flota'});const readings=db.prepare('SELECT r.id,r.created_at,r.hours,r.comments,r.status,r.photo1,r.photo2,e.code,e.brand,e.model,u.username FROM readings r JOIN equipment e ON e.id=r.equipment_id JOIN users u ON u.id=r.user_id ORDER BY r.id DESC').all();return send(res,200,{readings}); }
      if(req.method==='POST'&&url.pathname==='/api/equipment/import') {
        if(user.role!=='admin')return send(res,403,{error:'Solo administración puede importar equipos'});
        const b=await body(req,5*1024*1024),items=b.items;
        if(!Array.isArray(items)||!items.length)return send(res,400,{error:'El archivo no contiene filas de equipos'});
        if(items.length>5000)return send(res,400,{error:'La importación admite hasta 5,000 equipos por archivo'});
        const seen=new Set(),normalized=[],errors=[];
        for(let i=0;i<items.length;i++){
          const x=items[i],code=String(x.code||'').trim(),brand=String(x.brand||'').trim(),model=String(x.model||'').trim();
          const interval=Number(x.interval_hours),hours=Number(x.current_hours),warning=Number(x.warning_hours===''||x.warning_hours==null?50:x.warning_hours);
          const lastHours=Number(x.last_service_hours===''||x.last_service_hours==null?hours:x.last_service_hours);
          if(!code||!brand||!model||![interval,hours,warning,lastHours].every(Number.isFinite)||interval<=0||hours<0||warning<0||lastHours<0||lastHours>hours){errors.push(`Fila ${i+2}: revisa ficha, marca, modelo, intervalo y horómetros`);continue}
          const normalizedCode=code.toLocaleLowerCase();if(seen.has(normalizedCode)){errors.push(`Fila ${i+2}: la ficha ${code} está repetida en el archivo`);continue}seen.add(normalizedCode);
          const username=String(x.assigned_username||'').trim();const assigned=username?db.prepare("SELECT id FROM users WHERE username=? AND role='field' AND user_type='record'").get(username):null;
          if(username&&!assigned){errors.push(`Fila ${i+2}: no existe el usuario de campo ${username}`);continue}
          normalized.push({code,brand,model,serial:String(x.serial||'').trim(),interval,hours,warning,lastHours,userId:assigned?.id??null});
        }
        if(errors.length)return send(res,400,{error:'No se importó ningún equipo. Corrige el archivo y vuelve a intentarlo.',details:errors.slice(0,20)});
        db.exec('BEGIN IMMEDIATE');
        try{const insert=db.prepare('INSERT INTO equipment(code,brand,model,serial,interval_hours,warning_hours,current_hours,last_service_hours,assigned_user_id) VALUES(?,?,?,?,?,?,?,?,?)');for(const x of normalized)insert.run(x.code,x.brand,x.model,x.serial,x.interval,x.warning,x.hours,x.lastHours,x.userId);db.exec('COMMIT');return send(res,201,{ok:true,imported:normalized.length})}
        catch(error){try{db.exec('ROLLBACK')}catch{}if(String(error.message).includes('UNIQUE'))return send(res,409,{error:'No se importó ningún equipo porque una o más fichas ya existen en el inventario'});throw error}
      }
      if(req.method==='POST'&&/^\/api\/equipment\/\d+\/assignment$/.test(url.pathname)) {
        if(user.role!=='admin'&&user.user_type!=='transfer')return send(res,403,{error:'No tienes permiso para transferir equipos'});
        const [,id]=url.pathname.match(/^\/api\/equipment\/(\d+)\/assignment$/),b=await body(req),target=b.user_id?db.prepare("SELECT id FROM users WHERE id=? AND role='field' AND user_type='record'").get(Number(b.user_id)):null;
        if(b.user_id&&!target)return send(res,400,{error:'Selecciona un usuario de campo válido'});
        const result=db.prepare('UPDATE equipment SET assigned_user_id=? WHERE id=?').run(target?.id??null,Number(id));
        if(!result.changes)return send(res,404,{error:'Equipo no encontrado'});return send(res,200,{ok:true});
      }
      if(req.method==='POST'&&url.pathname==='/api/equipment') {
        if(user.role!=='admin')return send(res,403,{error:'Solo administración puede registrar equipos'});
        const b=await body(req),code=String(b.code||'').trim(),brand=String(b.brand||'').trim(),model=String(b.model||'').trim(),interval=Number(b.interval_hours),hours=Number(b.current_hours),warning=Number(b.warning_hours??50),assignedId=b.assigned_user_id?Number(b.assigned_user_id):null;
        if(!code||!brand||!model||![interval,hours,warning].every(Number.isFinite)||interval<=0||hours<0||warning<0)return send(res,400,{error:'Completa los campos y revisa los valores numéricos'});
        if(assignedId&&!db.prepare("SELECT id FROM users WHERE id=? AND role='field' AND user_type='record'").get(assignedId))return send(res,400,{error:'El usuario asignado no es válido'});
        try { db.prepare('INSERT INTO equipment(code,brand,model,serial,interval_hours,warning_hours,current_hours,last_service_hours,assigned_user_id) VALUES(?,?,?,?,?,?,?,?,?)').run(code,brand,model,String(b.serial||'').trim(),interval,warning,hours,hours,assignedId); return send(res,201,{ok:true}); } catch(e) { if(String(e.message).includes('UNIQUE'))return send(res,409,{error:'Ya existe un equipo con esa ficha'}); throw e; }
      }
      if(req.method==='POST'&&url.pathname==='/api/readings') {
        if(user.role!=='admin'&&user.user_type!=='record')return send(res,403,{error:'Tu perfil no permite registrar lecturas'});
        const b=await body(req,28*1024*1024),eid=Number(b.equipment_id),hours=Number(b.hours),photos=b.photos;
        const e=db.prepare('SELECT * FROM equipment WHERE id=?').get(eid);
        if(!e)return send(res,404,{error:'Equipo no encontrado'});
        if(user.role==='field'&&e.assigned_user_id!==user.id)return send(res,403,{error:'No tienes asignado este equipo'});
        if(!Number.isFinite(hours)||hours<e.current_hours)return send(res,400,{error:'Lectura inferior al horómetro registrado'});
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
        const [,id]=url.pathname.match(/^\/api\/equipment\/(\d+)\/maintenance$/),b=await body(req),equipment=db.prepare('SELECT * FROM equipment WHERE id=?').get(Number(id));
        if(!equipment)return send(res,404,{error:'Equipo no encontrado'});
        const latest=db.prepare("SELECT MAX(hours) AS hours FROM readings WHERE equipment_id=? AND status!='rejected'").get(Number(id)).hours;
        const latestHours=latest??equipment.current_hours,hours=Number(b.hours),supplies=String(b.supplies||'').trim(),mechanic=String(b.mechanic||'').trim();
        if(!Number.isFinite(hours)||hours<equipment.last_service_hours||hours>latestHours)return send(res,400,{error:`El horómetro del mantenimiento debe estar entre ${equipment.last_service_hours} y ${latestHours} horas`});
        if(!mechanic||mechanic.length>150||!supplies||supplies.length>4000)return send(res,400,{error:'Indica el mecánico y los insumos utilizados (máximo 4,000 caracteres)'});
        db.exec('BEGIN IMMEDIATE');
        let eventId;
        try{db.prepare('UPDATE equipment SET current_hours=?,last_service_hours=? WHERE id=?').run(latestHours,hours,Number(id));const event=db.prepare('INSERT INTO maintenance_events(equipment_id,user_id,hours,supplies,mechanic) VALUES(?,?,?,?,?)').run(Number(id),user.id,hours,supplies,mechanic);eventId=Number(event.lastInsertRowid);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
        const event=db.prepare('SELECT created_at FROM maintenance_events WHERE id=?').get(eventId);
        return send(res,200,{ok:true,record:{id:eventId,code:equipment.code,brand:equipment.brand,model:equipment.model,serial:equipment.serial,hours,supplies,mechanic,created_at:event.created_at,recorded_by:user.username}});
      }
      if(req.method==='POST'&&/^\/api\/readings\/\d+\/(confirm|reject)$/.test(url.pathname)) { if(user.role!=='admin')return send(res,403,{error:'Solo administración puede procesar reportes'}); const [,id,action]=url.pathname.match(/^\/api\/readings\/(\d+)\/(confirm|reject)$/); const status=action==='confirm'?'confirmed':'rejected'; const reading=db.prepare('SELECT * FROM readings WHERE id=?').get(Number(id)); if(!reading||reading.status!=='pending')return send(res,409,{error:'Este reporte ya fue procesado o no existe'}); db.prepare('UPDATE readings SET status=? WHERE id=?').run(status,Number(id)); if(status==='rejected') { const latest=db.prepare("SELECT MAX(hours) AS hours FROM readings WHERE equipment_id=? AND status!='rejected'").get(reading.equipment_id).hours; const equipment=db.prepare('SELECT last_service_hours FROM equipment WHERE id=?').get(reading.equipment_id); db.prepare('UPDATE equipment SET current_hours=? WHERE id=?').run(latest??equipment.last_service_hours,reading.equipment_id); } return send(res,200,{ok:true}); }
      if(req.method==='POST'&&url.pathname==='/api/users') { if(user.role!=='admin')return send(res,403,{error:'Solo administración puede crear usuarios'}); const b=await body(req),username=String(b.username||'').trim(),password=String(b.password||''),email=String(b.email||'').trim(),userType=String(b.user_type||'record'); if(username.length<3||password.length<8||!/^\S+@\S+\.\S+$/.test(email)||!['record','transfer'].includes(userType))return send(res,400,{error:'Completa usuario, correo, perfil y contraseña temporal válida'}); if(userType==='transfer'&&db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='field' AND user_type='transfer'").get().n>=3)return send(res,409,{error:'Ya existen los 3 encargados de transferencia permitidos'}); try {db.prepare("INSERT INTO users(username,password_hash,role,email,user_type,must_change_password) VALUES(?,?,'field',?,?,1)").run(username,hashPassword(password),email,userType);return send(res,201,{ok:true});}catch(e){if(String(e.message).includes('UNIQUE'))return send(res,409,{error:'Ese usuario ya existe'});throw e;} }
      return send(res,404,{error:'Ruta no encontrada'});
    }
    const pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname); const file=normalize(join(root,'public',pathname)); if(!file.startsWith(join(root,'public')))return send(res,404,{error:'No encontrado'}); if(!existsSync(file))return send(res,404,{error:'No encontrado'}); res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}); createReadStream(file).pipe(res);
  } catch(error) { console.error(error); send(res,500,{error:'Error interno del servidor'}); }
});
const port=Number(process.env.PORT||3000); server.listen(port,'0.0.0.0',()=>console.log(`Registro de Equipos disponible en http://localhost:${port}`));

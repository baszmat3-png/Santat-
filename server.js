const express=require('express'),{Pool}=require('pg'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),cp=require('cookie-parser'),rl=require('express-rate-limit'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const SECRET=process.env.JWT_SECRET;if(!SECRET||!process.env.DATABASE_URL)throw new Error('JWT_SECRET و DATABASE_URL مطلوبان');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)?false:{rejectUnauthorized:false}});
const app=express();app.set('trust proxy',1);app.use(express.json({limit:'20kb'}),cp());
const q=(t,p)=>pool.query(t,p),bad=(m,s=400)=>{const e=new Error(m);e.status=s;throw e};
const W=f=>(req,res)=>f(req,res).catch(e=>{if(e.status)return res.status(e.status).json({error:e.message});console.error(e);res.status(500).json({error:'خطأ في الخادم'})});
async function tx(f){const c=await pool.connect();try{await c.query('BEGIN');const r=await f(c);await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
const cfg=async c=>Object.fromEntries((await(c||pool).query('SELECT key,value FROM config')).rows.map(r=>[r.key,r.value]));
const hs=s=>crypto.createHash('sha256').update(s+SECRET).digest('hex'),num=(x,min=1)=>{x=Math.floor(Number(x));if(!Number.isFinite(x)||x<min)bad('قيمة غير صحيحة');return x};
const auth=async(req,res,next)=>{try{const t=jwt.verify(req.cookies.tok||'',SECRET);const{rows:[u]}=await q('SELECT * FROM users WHERE id=$1',[t.id]);if(!u||u.banned)return res.status(401).json({error:'غير مسموح'});req.u=u;next()}catch(e){res.status(401).json({error:'سجّل الدخول'})}};
const adm=(req,res,next)=>req.u.role==='admin'?next():res.status(403).json({error:'للأدمن فقط'});
const lim=rl({windowMs:15*60e3,max:40,standardHeaders:true,legacyHeaders:false});
const login=(res,id)=>res.cookie('tok',jwt.sign({id},SECRET,{expiresIn:'30d'}),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV!=='development',maxAge:2592e6});
async function mail(to,code){if(!process.env.RESEND_API_KEY){console.log('OTP',to,code);return}
const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.MAIL_FROM||'SNTAT <onboarding@resend.dev>',to:[to],subject:'رمز التحقق SNTAT',html:'<div dir="rtl"><p>رمز التحقق الخاص بك:</p><h2>'+code+'</h2><p>صالح لمدة 5 دقائق.</p></div>'})});if(!r.ok)bad('تعذر إرسال البريد',502)}
async function credit(c,uid,pts,usd,type,note){await c.query('UPDATE wallets SET points=points+$2,usd_cents=usd_cents+$3 WHERE user_id=$1',[uid,pts,usd]);await c.query('INSERT INTO transactions(user_id,type,points,usd_cents,note) VALUES($1,$2,$3,$4,$5)',[uid,type,pts,usd,note||null])}
const lockW=async(c,uid)=>(await c.query('SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE',[uid])).rows[0];
async function settle(c,uid){const{rows:[s]}=await c.query('SELECT * FROM mining_sessions WHERE user_id=$1 AND active FOR UPDATE',[uid]);if(!s)return null;
const now=Date.now(),st=+new Date(s.started_at),en=+new Date(s.ends_at),earned=Math.floor(Number(s.size)*(Math.min(now,en)-st)/864e5),add=earned-Number(s.credited),done=now>=en;
if(add>0)await credit(c,uid,add,0,'mining',done?'اكتملت دورة التعدين':null);await c.query('UPDATE mining_sessions SET credited=$2,active=$3 WHERE id=$1',[s.id,Math.max(earned,Number(s.credited)),!done]);return done?null:s}
// ---------- auth ----------
app.post('/api/signup',lim,W(async(req,res)=>{const{name,email,password,invite}=req.body,e=String(email||'').toLowerCase().trim();
if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e))bad('بيانات غير صحيحة');if(String(password||'').length<6)bad('كلمة المرور قصيرة');
if((await q('SELECT 1 FROM users WHERE email=$1',[e])).rowCount)bad('هذا البريد مسجل مسبقاً');
if((await q("SELECT 1 FROM otp_codes WHERE email=$1 AND created_at>now()-interval '30 seconds'",[e])).rowCount)bad('انتظر 30 ثانية قبل إعادة الإرسال',429);
const code=String(crypto.randomInt(0,1e6)).padStart(6,'0');
await q("INSERT INTO otp_codes(email,code_hash,payload,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",[e,hs(e+code),{name:String(name).slice(0,40),pw:await bcrypt.hash(String(password),10),invite:invite||null}]);
await mail(e,code);res.json({ok:true})}));
app.post('/api/verify',lim,W(async(req,res)=>{const e=String(req.body.email||'').toLowerCase().trim(),code=String(req.body.code||'');
const{rows:[o]}=await q('SELECT * FROM otp_codes WHERE email=$1 AND used=false ORDER BY id DESC LIMIT 1',[e]);
if(!o||o.expires_at<new Date())bad('الرمز منتهي، أعد الإرسال');if(o.attempts>=5)bad('محاولات كثيرة، أعد إرسال رمز جديد');
if(o.code_hash!==hs(e+code)){await q('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1',[o.id]);bad('الرمز غير صحيح')}
const id=await tx(async c=>{const p=o.payload,k=await cfg(c);if((await c.query('SELECT 1 FROM users WHERE email=$1',[e])).rowCount)bad('هذا البريد مسجل مسبقاً');
const{rows:[u]}=await c.query("INSERT INTO users(email,name,password_hash,invite_code,verified,role) VALUES($1,$2,$3,$4,true,CASE WHEN $1=$5 THEN 'admin' ELSE 'user' END) RETURNING id",[e,p.name,p.pw,crypto.randomBytes(4).toString('hex').toUpperCase(),(process.env.ADMIN_EMAIL||'').toLowerCase()]);
await c.query('INSERT INTO wallets(user_id) VALUES($1)',[u.id]);await c.query('UPDATE otp_codes SET used=true WHERE id=$1',[o.id]);
if(p.invite){const{rows:[r]}=await c.query('SELECT id FROM users WHERE invite_code=$1',[String(p.invite).toUpperCase()]);if(r){await c.query('UPDATE users SET referred_by=$2 WHERE id=$1',[u.id,r.id]);await credit(c,r.id,Number(k.referral_bonus)||0,0,'referral','مكافأة دعوة '+p.name);await c.query('INSERT INTO friends VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING',[u.id,r.id])}}
return u.id});login(res,id);res.json({ok:true})}));
app.post('/api/login',lim,W(async(req,res)=>{const e=String(req.body.email||'').toLowerCase().trim(),{rows:[u]}=await q('SELECT * FROM users WHERE email=$1',[e]);
if(!u||!(await bcrypt.compare(String(req.body.password||''),u.password_hash)))bad('البريد أو كلمة المرور غير صحيحة',401);if(u.banned)bad('الحساب محظور',403);login(res,u.id);res.json({ok:true})}));
app.post('/api/logout',(req,res)=>{res.clearCookie('tok');res.json({ok:true})});
app.post('/api/name',auth,W(async(req,res)=>{const n=String(req.body.name||'').trim().slice(0,40);if(!n)bad('الاسم فارغ');await q('UPDATE users SET name=$2 WHERE id=$1',[req.u.id,n]);res.json({ok:true})}));
// ---------- app ----------
app.get('/api/me',auth,W(async(req,res)=>{const o=await tx(async c=>({s:await settle(c,req.u.id),w:(await c.query('SELECT * FROM wallets WHERE user_id=$1',[req.u.id])).rows[0],t:(await c.query('SELECT type,points,usd_cents,note,created_at FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 15',[req.u.id])).rows,c:await cfg(c)})),u=req.u;
res.json({user:{name:u.name,email:u.email,role:u.role,invite:u.invite_code},wallet:{points:+o.w.points,usd:o.w.usd_cents/100,size:+o.w.counter_size},session:o.s&&{start:o.s.started_at,end:o.s.ends_at},config:o.c,tx:o.t})}));
app.post('/api/mine',auth,W(async(req,res)=>{await tx(async c=>{if((await cfg(c)).maintenance===true)bad('التطبيق تحت الصيانة');const w=await lockW(c,req.u.id);if(await settle(c,req.u.id))bad('العداد يعمل بالفعل');
await c.query("INSERT INTO mining_sessions(user_id,ends_at,size) VALUES($1,now()+interval '24 hours',$2)",[req.u.id,w.counter_size])});res.json({ok:true})}));
app.post('/api/bonus',auth,W(async(req,res)=>{await tx(async c=>{const w=await lockW(c,req.u.id),k=await cfg(c);if((await c.query('SELECT $1::date=current_date AS t',[w.last_bonus])).rows[0].t)bad('استلمت مكافأة اليوم');
await credit(c,req.u.id,Number(k.daily_bonus)||0,0,'bonus','مكافأة يومية');await c.query('UPDATE wallets SET last_bonus=current_date WHERE user_id=$1',[req.u.id])});res.json({ok:true})}));
app.post('/api/convert',auth,W(async(req,res)=>{const n=num(req.body.points);await tx(async c=>{const w=await lockW(c,req.u.id),r=Number((await cfg(c)).points_per_usd)||10000;if(n<r)bad('الحد الأدنى '+r+' نقطة');if(n>w.points)bad('نقاطك غير كافية');
await credit(c,req.u.id,-n,Math.floor(n*100/r),'convert','تحويل نقاط إلى دولار')});res.json({ok:true})}));
app.post('/api/store',auth,W(async(req,res)=>res.json({items:(await q('SELECT * FROM counter_items WHERE active ORDER BY price_points')).rows})));
app.post('/api/store/buy',auth,W(async(req,res)=>{await tx(async c=>{const{rows:[i]}=await c.query('SELECT * FROM counter_items WHERE id=$1 AND active',[num(req.body.id)]);if(!i)bad('العنصر غير موجود');const w=await lockW(c,req.u.id);if(w.points<i.price_points)bad('نقاطك غير كافية');
await credit(c,req.u.id,-i.price_points,0,'store',i.name);await c.query('UPDATE wallets SET counter_size=counter_size+$2 WHERE user_id=$1',[req.u.id,i.add_size])});res.json({ok:true})}));
app.post('/api/p2p',auth,W(async(req,res)=>res.json({list:(await q("SELECT l.id,l.points,l.price_cents,l.seller_id,COALESCE(u.name,'سنتات') AS seller FROM p2p_listings l LEFT JOIN users u ON u.id=l.seller_id WHERE l.status='open' ORDER BY l.id DESC LIMIT 100")).rows.map(r=>({...r,mine:r.seller_id===req.u.id}))})));
app.post('/api/p2p/sell',auth,W(async(req,res)=>{const p=num(req.body.points),c2=Math.round(Number(req.body.usd)*100);if(!(c2>0))bad('سعر غير صحيح');await tx(async c=>{const w=await lockW(c,req.u.id);if(w.points<p)bad('نقاطك غير كافية');
await credit(c,req.u.id,-p,0,'p2p_sell','عرض بيع');await c.query('INSERT INTO p2p_listings(seller_id,points,price_cents) VALUES($1,$2,$3)',[req.u.id,p,c2])});res.json({ok:true})}));
app.post('/api/p2p/buy',auth,W(async(req,res)=>{await tx(async c=>{const{rows:[l]}=await c.query("SELECT * FROM p2p_listings WHERE id=$1 AND status='open' FOR UPDATE",[num(req.body.id)]);if(!l)bad('العرض غير متاح');if(l.seller_id===req.u.id)bad('هذا عرضك');
const w=await lockW(c,req.u.id);if(w.usd_cents<l.price_cents)bad('رصيدك بالدولار غير كافٍ');await credit(c,req.u.id,l.points,-l.price_cents,'p2p_buy','شراء نقاط');
if(l.seller_id)await credit(c,l.seller_id,0,l.price_cents,'p2p_sell','بيع نقاط');await c.query("UPDATE p2p_listings SET status='sold',buyer_id=$2,sold_at=now() WHERE id=$1",[l.id,req.u.id])});res.json({ok:true})}));
app.post('/api/p2p/cancel',auth,W(async(req,res)=>{await tx(async c=>{const{rows:[l]}=await c.query("SELECT * FROM p2p_listings WHERE id=$1 AND seller_id=$2 AND status='open' FOR UPDATE",[num(req.body.id),req.u.id]);if(!l)bad('العرض غير متاح');
await credit(c,req.u.id,Number(l.points),0,'p2p_sell','إلغاء عرض');await c.query("UPDATE p2p_listings SET status='cancelled' WHERE id=$1",[l.id])});res.json({ok:true})}));
app.post('/api/rooms',auth,W(async(req,res)=>res.json({rooms:(await q('SELECT r.id,r.name,(SELECT count(*) FROM room_members m WHERE m.room_id=r.id)::int AS members,EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=r.id AND m.user_id=$1) AS joined FROM rooms r ORDER BY r.id DESC LIMIT 100',[req.u.id])).rows})));
app.post('/api/rooms/create',auth,W(async(req,res)=>{const n=String(req.body.name||'').trim().slice(0,40);if(!n)bad('اسم الغرفة فارغ');await tx(async c=>{const{rows:[r]}=await c.query('INSERT INTO rooms(name,owner_id) VALUES($1,$2) RETURNING id',[n,req.u.id]);await c.query('INSERT INTO room_members VALUES($1,$2)',[r.id,req.u.id])});res.json({ok:true})}));
app.post('/api/rooms/join',auth,W(async(req,res)=>{const id=num(req.body.id),d=await q('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2',[id,req.u.id]);if(!d.rowCount)await q('INSERT INTO room_members VALUES($1,$2) ON CONFLICT DO NOTHING',[id,req.u.id]);res.json({ok:true})}));
app.post('/api/friends',auth,W(async(req,res)=>res.json({friends:(await q('SELECT u.name FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=$1 ORDER BY f.created_at DESC',[req.u.id])).rows})));
app.post('/api/friends/add',auth,W(async(req,res)=>{const{rows:[f]}=await q('SELECT id FROM users WHERE invite_code=$1',[String(req.body.code||'').trim().toUpperCase()]);if(!f)bad('رمز غير صحيح');if(f.id===req.u.id)bad('لا يمكنك إضافة نفسك');
await q('INSERT INTO friends VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING',[req.u.id,f.id]);res.json({ok:true})}));
// ---------- admin ----------
const A=[auth,adm];
app.post('/api/admin/stats',A,W(async(req,res)=>res.json((await q("SELECT (SELECT count(*) FROM users)::int AS users,(SELECT count(*) FROM users WHERE banned)::int AS banned,(SELECT count(*) FROM mining_sessions WHERE active AND ends_at>now())::int AS active,COALESCE((SELECT sum(points) FROM wallets),0)::bigint AS points,COALESCE((SELECT sum(usd_cents) FROM wallets),0)::bigint AS usd_cents")).rows[0])));
app.post('/api/admin/users',A,W(async(req,res)=>res.json({users:(await q('SELECT u.id,u.name,u.email,u.role,u.banned,w.points,w.usd_cents,w.counter_size FROM users u JOIN wallets w ON w.user_id=u.id ORDER BY u.id DESC LIMIT 200')).rows})));
app.post('/api/admin/ban',A,W(async(req,res)=>{if(num(req.body.id)===req.u.id)bad('لا يمكن حظر نفسك');await q("UPDATE users SET banned=$2 WHERE id=$1 AND role<>'admin'",[req.body.id,!!req.body.banned]);res.json({ok:true})}));
app.post('/api/admin/config',A,W(async(req,res)=>{const b=req.body;if(b.set){const o={daily_bonus:num(b.set.daily_bonus,0),referral_bonus:num(b.set.referral_bonus,0),points_per_usd:num(b.set.points_per_usd),announcement:String(b.set.announcement||'').slice(0,200),maintenance:!!b.set.maintenance};
for(const k in o)await q('INSERT INTO config VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',[k,JSON.stringify(o[k])])}
res.json({config:await cfg(),rooms:(await q('SELECT id,name FROM rooms WHERE owner_id IS NULL ORDER BY id')).rows,listings:(await q("SELECT id,points,price_cents FROM p2p_listings WHERE seller_id IS NULL AND status='open' ORDER BY id")).rows})}));
app.post('/api/admin/room',A,W(async(req,res)=>{if(req.body.del)await q('DELETE FROM rooms WHERE id=$1 AND owner_id IS NULL',[num(req.body.del)]);else{const n=String(req.body.name||'').trim().slice(0,40);if(!n)bad('اسم فارغ');await q('INSERT INTO rooms(name) VALUES($1)',[n])}res.json({ok:true})}));
app.post('/api/admin/listing',A,W(async(req,res)=>{if(req.body.del)await q("UPDATE p2p_listings SET status='cancelled' WHERE id=$1 AND seller_id IS NULL",[num(req.body.del)]);else await q('INSERT INTO p2p_listings(points,price_cents) VALUES($1,$2)',[num(req.body.points),Math.round(Number(req.body.usd)*100)||bad('سعر غير صحيح')]);res.json({ok:true})}));
app.use(express.static(path.join(__dirname,'public')));
pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8')).then(()=>app.listen(process.env.PORT||3000,()=>console.log('SNTAT ready'))).catch(e=>{console.error(e);process.exit(1)});

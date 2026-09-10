// Hosted web OAuth; the desktop receives a request-bound, one-time session handoff.
import {persistentReady,googleToken,profileFor,createSession,encrypt,decrypt} from './server-auth.js';
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x=>x.toString(16).padStart(2,'0')).join('');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const valid=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const json=(data,status,cors)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
export async function desktopRoute(request,env,cors){
 const url=new URL(request.url),path=url.pathname;
 if(!persistentReady(env))throw fail('PERSISTENT_AUTH_NOT_CONFIGURED',503);
 const redirect=new URL('/api/desktop/callback',url.origin).href;
 if(path==='/api/desktop/start'&&request.method==='POST'){
  const b=await request.json();if(!valid(b.challenge))throw fail('INVALID_CHALLENGE');
  if(b.clientId!==env.GOOGLE_CLIENT_ID)throw fail('CLIENT_ID_MISMATCH');
  const now=Date.now(),state=random(),id=random();
  await env.DB.prepare('DELETE FROM desktop_auth_requests WHERE expires_at<?').bind(now).run();
  await env.DB.prepare('INSERT INTO desktop_auth_requests(id,state_hash,challenge,status,expires_at) VALUES(?,?,?,?,?)').bind(id,await hash(state),b.challenge,'pending',now+600000).run();
  const target=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:redirect,response_type:'code',scope:'openid email profile https://www.googleapis.com/auth/drive',access_type:'offline',prompt:'consent',state}).toString();
  return json({id,authorizationUrl:target.href},200,cors);
 }
 if(path==='/api/desktop/callback'&&request.method==='GET'){
  const state=url.searchParams.get('state');if(!valid(state))throw fail('INVALID_STATE');
  const row=await env.DB.prepare("UPDATE desktop_auth_requests SET status='exchanging' WHERE state_hash=? AND status='pending' AND expires_at>? RETURNING *").bind(await hash(state),Date.now()).first();
  if(!row)throw fail('AUTH_REQUEST_EXPIRED_OR_USED');
  let message='授權完成，請返回行事曆桌面程式。此頁可以關閉。';
  try{
   if(url.searchParams.has('error'))throw fail('GOOGLE_AUTH_CANCELLED');
   if(url.searchParams.has('iss')&&url.searchParams.get('iss')!=='https://accounts.google.com')throw fail('INVALID_ISSUER');
   const code=url.searchParams.get('code');if(!code)throw fail('CODE_MISSING');
   const t=await googleToken({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:redirect,grant_type:'authorization_code'});
   const session=await createSession(t,await profileFor(t.access_token),env);
   await env.DB.prepare("UPDATE desktop_auth_requests SET status='complete',payload=? WHERE id=? AND expires_at>?").bind(await encrypt(JSON.stringify(session),env),row.id,Date.now()).run();
  }catch(e){message='授權未完成，請返回桌面程式查看狀態並重試。';await env.DB.prepare("UPDATE desktop_auth_requests SET status='failed',payload=? WHERE id=?").bind(await encrypt(JSON.stringify({error:e.message}),env),row.id).run();}
  return new Response('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>行事曆登入</title><h1>'+message+'</h1></html>',{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}});
 }
 if(path==='/api/desktop/poll'&&request.method==='POST'){
  const b=await request.json();if(!valid(b.id)||!valid(b.verifier))throw fail('INVALID_REQUEST');
  const challenge=await hash(b.verifier),now=Date.now();
  const row=await env.DB.prepare("DELETE FROM desktop_auth_requests WHERE id=? AND challenge=? AND expires_at>? AND status IN ('complete','failed') RETURNING *").bind(b.id,challenge,now).first();
  if(row)return json(JSON.parse(await decrypt(row.payload,env)),row.status==='complete'?200:400,cors);
  const pending=await env.DB.prepare('SELECT status FROM desktop_auth_requests WHERE id=? AND challenge=? AND expires_at>?').bind(b.id,challenge,now).first();
  if(!pending)throw fail('AUTH_REQUEST_EXPIRED_OR_USED',410);return json({pending:true},202,cors);
 }
 throw fail('NOT_FOUND',404);
}

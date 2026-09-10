// Google refresh tokens are AES-GCM encrypted; opaque application sessions are stored as SHA-256 hashes.
const encoder=new TextEncoder(),decoder=new TextDecoder();
const legacyCache=new Map(),refreshes=new Map();
const SESSION_IDLE_MS=30*86400000,SESSION_MAX_MS=180*86400000;
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const digest=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const error=(s,status=401)=>Object.assign(new Error(s),{status});
export const persistentReady=env=>!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.AUTH_ENCRYPTION_KEY);
async function key(env){const raw=unb64(env.AUTH_ENCRYPTION_KEY);if(raw.length!==32)throw error('AUTH_KEY_INVALID',503);return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);}
export async function encrypt(s,env){if(!s)return '';const iv=crypto.getRandomValues(new Uint8Array(12));const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),encoder.encode(s)));return `${b64(iv)}.${b64(data)}`;}
export async function decrypt(s,env){if(!s)return '';const [iv,data]=s.split('.');return decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv)},await key(env),unb64(data)));}
export async function googleToken(parameters){const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(parameters),signal:AbortSignal.timeout(15000)});const d=await r.json();if(!r.ok)throw error(d.error==='invalid_grant'?'GOOGLE_LOGIN_REQUIRED':'GOOGLE_AUTH_TEMPORARILY_UNAVAILABLE',d.error==='invalid_grant'?401:503);return d;}
export async function profileFor(token){const r=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});if(!r.ok)throw error('UNAUTHORIZED',r.status>=500?503:401);const p=await r.json();if(!p.sub)throw error('UNAUTHORIZED');return p;}
export async function exchangeCode(request,env){
  if(!persistentReady(env))throw error('PERSISTENT_AUTH_NOT_CONFIGURED',503);
  const origin=request.headers.get('Origin'),allowed=String(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim());
  if(!allowed.includes(origin)||request.headers.get('X-Requested-With')!=='CalendarNotesPWA')throw error('ORIGIN_DENIED',403);
  const body=await request.json();if(!body.code||body.redirect_uri!==origin)throw error('INVALID_AUTH_REQUEST',400);
  const t=await googleToken({code:body.code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:origin,grant_type:'authorization_code'});const profile=await profileFor(t.access_token);
  return createSession(t,profile,env);
}
export async function createSession(t,profile,env){
  let refresh=t.refresh_token||'';
  if(!refresh){const prior=await env.DB.prepare('SELECT refresh_cipher FROM app_sessions WHERE user_sub=? AND expires_at>? ORDER BY created_at DESC LIMIT 1').bind(profile.sub,Date.now()).first();if(prior)refresh=await decrypt(prior.refresh_cipher,env);}
  if(!refresh)throw error('GOOGLE_OFFLINE_ACCESS_REQUIRED',409);
  const opaque='session.'+b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const now=Date.now();await env.DB.prepare('INSERT INTO app_sessions(token_hash,user_sub,profile,access_cipher,refresh_cipher,access_expires,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(await digest(opaque),profile.sub,JSON.stringify(profile),await encrypt(t.access_token,env),await encrypt(refresh,env),now+Number(t.expires_in)*1000,now+SESSION_IDLE_MS,now).run();
  return {ok:true,sessionToken:opaque,accessToken:t.access_token,expiresIn:t.expires_in,profile,persistent:true,sessionExpiresAt:now+SESSION_IDLE_MS};
}
export async function authenticate(request,env){
  const value=request.headers.get('Authorization')||'';if(!value.startsWith('Bearer '))throw error('UNAUTHORIZED');const token=value.slice(7).trim();if(!token)throw error('UNAUTHORIZED');
  const hash=await digest(token);
  if(token.startsWith('session.')){
    if(!persistentReady(env))throw error('PERSISTENT_AUTH_NOT_CONFIGURED',503);
    let row=await env.DB.prepare('SELECT * FROM app_sessions WHERE token_hash=? AND expires_at>?').bind(hash,Date.now()).first();if(!row)throw error('UNAUTHORIZED');
    if(row.access_expires<Date.now()+60000){
      if(!refreshes.has(hash))refreshes.set(hash,(async()=>{
        const refresh=await decrypt(row.refresh_cipher,env);if(!refresh)throw error('GOOGLE_LOGIN_REQUIRED');
        const t=await googleToken({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:refresh});
        await env.DB.prepare('UPDATE app_sessions SET access_cipher=?,access_expires=?,refresh_cipher=? WHERE token_hash=?').bind(await encrypt(t.access_token,env),Date.now()+Number(t.expires_in)*1000,await encrypt(t.refresh_token||refresh,env),hash).run();
      })().finally(()=>refreshes.delete(hash)));
      await refreshes.get(hash);row=await env.DB.prepare('SELECT * FROM app_sessions WHERE token_hash=? AND expires_at>?').bind(hash,Date.now()).first();if(!row)throw error('UNAUTHORIZED');
    }
    const now=Date.now(),sessionExpiresAt=Math.min(Number(row.created_at)+SESSION_MAX_MS,now+SESSION_IDLE_MS);
    if(sessionExpiresAt>Number(row.expires_at)+3600000)await env.DB.prepare('UPDATE app_sessions SET expires_at=? WHERE token_hash=?').bind(sessionExpiresAt,hash).run();
    const profile=JSON.parse(row.profile);return {sub:profile.sub,email:profile.email||'',name:profile.name||'',profile,token:await decrypt(row.access_cipher,env),sessionHash:hash,expiresIn:Math.max(0,Math.floor((row.access_expires-now)/1000)),persistent:!!row.refresh_cipher,sessionExpiresAt};
  }
  let cached=legacyCache.get(hash);if(!cached||cached.until<Date.now()){const profile=await profileFor(token);cached={profile,until:Date.now()+60000};if(legacyCache.size>250)legacyCache.clear();legacyCache.set(hash,cached)}
  const p=cached.profile;return {sub:p.sub,email:p.email||'',name:p.name||p.email||'',profile:p,token};
}
export async function endSession(request,env){const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');if(token.startsWith('session.'))await env.DB.prepare('DELETE FROM app_sessions WHERE token_hash=?').bind(await digest(token)).run();return {ok:true};}

import {getMeta,setMeta} from './db.js';
import {setAccessToken,getAccessToken,setSessionToken,getSessionToken,setRefreshHook} from './api.js';
const cfg=window.APP_CONFIG;
let expiry=0,refreshPromise=null,authConfig=null;
const base=()=>cfg.API_BASE_URL.replace(/\/$/,'');
async function request(path,options={}){
  const r=await fetch(base()+path,{...options,signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json',...options.headers}});
  const data=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(data.error||`HTTP_${r.status}`);e.status=r.status;throw e;}return data;
}
export async function getAuthConfig(){
  if(authConfig)return authConfig;
  try{authConfig=await request('/api/auth/config')}catch{authConfig={persistent:false}}return authConfig;
}
export async function restoreSession(legacy=null){
  let stored=await getMeta('googleSession',null);
  if(!stored&&legacy?.meta.googleSession){stored=legacy.meta.googleSession;await setMeta('googleSession',stored)}
  const persistent=await getMeta('serverSession',null);
  expiry=Number(stored?.expiresAt||0);
  if(persistent?.token)setSessionToken(persistent.token);
  if(stored?.token&&expiry>Date.now())setAccessToken(stored.token);
  setRefreshHook(refreshAccess);
  return persistent?.profile||stored?.profile||await getMeta('lastProfile',null);
}
export async function refreshAccess(force=false){
  if(!force&&getAccessToken()&&expiry>Date.now()+30000)return getAccessToken();
  if(!navigator.onLine)return getAccessToken();
  if(refreshPromise)return refreshPromise;
  if(!getSessionToken()){if(expiry<=Date.now()){setAccessToken('');throw new Error('GOOGLE_LOGIN_REQUIRED')}return getAccessToken();}
  refreshPromise=(async()=>{
    try{const r=await request('/api/auth/token',{method:'POST',headers:{Authorization:`Bearer ${getSessionToken()}`},body:'{}'});await rememberAccess(r);return r.accessToken;}
    catch(e){if(e.status===401){setSessionToken('');setAccessToken('');await setMeta('serverSession',null)}throw e;}
  })().finally(()=>{refreshPromise=null});return refreshPromise;
}
async function rememberAccess(r){
  expiry=Date.now()+Number(r.expiresIn||3600)*1000-60000;setAccessToken(r.accessToken);
  await setMeta('googleSession',{token:r.accessToken,expiresAt:expiry,profile:r.profile});await setMeta('lastProfile',r.profile);
}
export async function waitGoogle(){
  if(!document.querySelector('script[data-google]')){const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.dataset.google='true';document.head.append(script)}
  const begin=Date.now();while(!window.google?.accounts?.oauth2){if(Date.now()-begin>10000)throw new Error('Google 登入服務載入逾時，請稍後重試');await new Promise(r=>setTimeout(r,100))}
}
export async function prepareLogin(){await Promise.all([getAuthConfig(),waitGoogle()]);}
// Called directly from a click after prepareLogin; preserve the browser's user activation.
export function login(onSuccess,onError){
  if(!window.google?.accounts?.oauth2){onError(new Error('登入服務尚未載入，請稍後再按一次'));prepareLogin().catch(()=>{});return;}
  if(authConfig?.persistent){
    const client=google.accounts.oauth2.initCodeClient({client_id:cfg.GOOGLE_CLIENT_ID,scope:cfg.GOOGLE_SCOPES,ux_mode:'popup',
      callback:async response=>{try{if(response.error)throw new Error(response.error);const r=await request('/api/auth/code',{method:'POST',headers:{'X-Requested-With':'CalendarNotesPWA'},body:JSON.stringify({code:response.code,redirect_uri:location.origin})});setSessionToken(r.sessionToken);await setMeta('serverSession',{token:r.sessionToken,profile:r.profile});await rememberAccess(r);onSuccess(r.profile)}catch(e){onError(e)}},error_callback:e=>onError(new Error(e.type==='popup_closed'?'已取消登入':'Google 登入視窗未能開啟'))});client.requestCode();
  }else{
    const client=google.accounts.oauth2.initTokenClient({client_id:cfg.GOOGLE_CLIENT_ID,scope:cfg.GOOGLE_SCOPES,
      callback:async response=>{try{if(response.error)throw new Error(response.error);const r=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:`Bearer ${response.access_token}`},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Google 帳號驗證失敗');const profile=await r.json();setSessionToken('');await setMeta('serverSession',null);await rememberAccess({accessToken:response.access_token,expiresIn:response.expires_in,profile});onSuccess(profile)}catch(e){onError(e)}},error_callback:e=>onError(new Error(e.type==='popup_closed'?'已取消登入':'Google 登入視窗未能開啟'))});client.requestAccessToken({prompt:''});
  }
}
export async function logout(){
  const session=getSessionToken();
  if(session){try{await request('/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${session}`},body:'{}'})}catch{/* Local sign-out still succeeds offline; server session expires automatically. */}}
  setAccessToken('');setSessionToken('');expiry=0;
  await setMeta('googleSession',null);await setMeta('serverSession',null);await setMeta('lastProfile',null);
}

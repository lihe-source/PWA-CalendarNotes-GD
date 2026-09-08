import {getMeta,setMeta} from './db.js';
import {setAccessToken,getAccessToken,setSessionToken,getSessionToken,setRefreshHook} from './api.js';
const cfg=window.APP_CONFIG;
let expiry=0,refreshPromise=null,authConfig=null,configCheckedAt=0,restoredProfile=null;
let authState={phase:'signed-out',persistent:false,configAvailable:false,serverReady:false,lastRestoredAt:0,sessionExpiresAt:0,reason:''};
const base=()=>cfg.API_BASE_URL.replace(/\/$/,'');
const setState=patch=>(authState={...authState,...patch});
export const getAuthState=()=>({...authState});
async function request(path,options={}){
  const r=await fetch(base()+path,{...options,signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json',...options.headers}});
  const data=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(data.error||`HTTP_${r.status}`);e.status=r.status;throw e;}return data;
}
export async function getAuthConfig(force=false){
  if(!force&&authConfig&&Date.now()-configCheckedAt<300000)return authConfig;
  try{authConfig=await request('/api/auth/config');configCheckedAt=Date.now();setState({configAvailable:true,serverReady:!!authConfig.persistent});return authConfig}
  catch(e){setState({configAvailable:false,reason:'AUTH_CONFIG_UNAVAILABLE'});if(authConfig)return authConfig;return {persistent:false,available:false}}
}
export async function restoreSession(legacy=null){
  let stored=await getMeta('googleSession',null);
  if(!stored&&legacy?.meta.googleSession){stored=legacy.meta.googleSession;await setMeta('googleSession',stored)}
  const persistent=await getMeta('serverSession',null);expiry=Number(stored?.expiresAt||0);
  const validAccess=!!(stored?.token&&expiry>Date.now());
  if(persistent?.token){setSessionToken(persistent.token);restoredProfile=persistent.profile||stored?.profile||null;setState({phase:'restoring',persistent:true,sessionExpiresAt:Number(persistent.expiresAt||0),reason:''})}
  else if(validAccess){setAccessToken(stored.token);restoredProfile=stored.profile||null;setState({phase:'legacy',persistent:false,reason:'SESSION_UPGRADE_REQUIRED'})}
  else{setAccessToken('');setSessionToken('');restoredProfile=null;setState({phase:'signed-out',persistent:false,reason:stored?.profile?'GOOGLE_LOGIN_REQUIRED':''})}
  setRefreshHook(refreshAccess);return restoredProfile;
}
export async function resumeAuthentication(){
  if(!navigator.onLine){setState({phase:'offline'});return restoredProfile}
  if(getSessionToken()){
    setState({phase:'restoring',reason:''});
    try{await refreshAccess(true);return restoredProfile}
    catch(e){if(e.status===401){restoredProfile=null;setState({phase:'action-required',persistent:false,reason:e.message})}else setState({phase:'temporarily-unavailable',reason:e.message});throw e}
  }
  if(getAccessToken()&&expiry>Date.now()){setState({phase:'legacy',persistent:false,lastRestoredAt:Date.now(),reason:'SESSION_UPGRADE_REQUIRED'});return restoredProfile}
  setState({phase:'action-required',persistent:false,reason:'GOOGLE_LOGIN_REQUIRED'});throw Object.assign(new Error('GOOGLE_LOGIN_REQUIRED'),{status:401});
}
export async function refreshAccess(force=false){
  if(!force&&getAccessToken()&&expiry>Date.now()+30000)return getAccessToken();
  if(!navigator.onLine)return getAccessToken();if(refreshPromise)return refreshPromise;
  if(!getSessionToken()){if(expiry<=Date.now()){setAccessToken('');throw Object.assign(new Error('GOOGLE_LOGIN_REQUIRED'),{status:401})}return getAccessToken()}
  refreshPromise=(async()=>{
    try{const r=await request('/api/auth/token',{method:'POST',headers:{Authorization:`Bearer ${getSessionToken()}`},body:'{}'});await rememberAccess(r);setState({phase:'connected',persistent:!!r.persistent,lastRestoredAt:Date.now(),sessionExpiresAt:Number(r.sessionExpiresAt||authState.sessionExpiresAt),reason:r.persistent?'':'SESSION_UPGRADE_REQUIRED'});return r.accessToken}
    catch(e){if(e.status===401){setSessionToken('');setAccessToken('');await setMeta('serverSession',null);await setMeta('googleSession',null)}throw e}
  })().finally(()=>{refreshPromise=null});return refreshPromise;
}
async function rememberAccess(r){
  expiry=Date.now()+Number(r.expiresIn||3600)*1000-60000;setAccessToken(r.accessToken);restoredProfile=r.profile||restoredProfile;
  await setMeta('googleSession',{token:r.accessToken,expiresAt:expiry,profile:restoredProfile});await setMeta('lastProfile',restoredProfile);
  if(getSessionToken())await setMeta('serverSession',{token:getSessionToken(),profile:restoredProfile,expiresAt:Number(r.sessionExpiresAt||authState.sessionExpiresAt||0)});
}
export async function waitGoogle(){
  if(!document.querySelector('script[data-google]')){const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.dataset.google='true';document.head.append(script)}
  const begin=Date.now();while(!window.google?.accounts?.oauth2){if(Date.now()-begin>10000)throw new Error('Google 登入服務載入逾時，請稍後重試');await new Promise(r=>setTimeout(r,100))}
}
export async function prepareLogin(){await Promise.all([getAuthConfig(true),waitGoogle()]);}
// Google requires user activation for first authorization or renewed consent. Daily startup uses resumeAuthentication instead.
export function login(onSuccess,onError){
  if(!window.google?.accounts?.oauth2){onError(new Error('登入服務尚未載入，請稍後再按一次'));prepareLogin().catch(()=>{});return;}
  if(authConfig?.persistent){
    const client=google.accounts.oauth2.initCodeClient({client_id:cfg.GOOGLE_CLIENT_ID,scope:cfg.GOOGLE_SCOPES,ux_mode:'popup',select_account:false,
      callback:async response=>{try{if(response.error)throw new Error(response.error);const r=await request('/api/auth/code',{method:'POST',headers:{'X-Requested-With':'CalendarNotesPWA'},body:JSON.stringify({code:response.code,redirect_uri:location.origin})});setSessionToken(r.sessionToken);await setMeta('serverSession',{token:r.sessionToken,profile:r.profile,expiresAt:Number(r.sessionExpiresAt||0)});await rememberAccess(r);setState({phase:'connected',persistent:!!r.persistent,lastRestoredAt:Date.now(),sessionExpiresAt:Number(r.sessionExpiresAt||0),reason:''});onSuccess(r.profile)}catch(e){setState({phase:'action-required',reason:e.message});onError(e)}},error_callback:e=>onError(new Error(e.type==='popup_closed'?'已取消登入':'Google 登入視窗未能開啟'))});client.requestCode();
  }else{
    const client=google.accounts.oauth2.initTokenClient({client_id:cfg.GOOGLE_CLIENT_ID,scope:cfg.GOOGLE_SCOPES,
      callback:async response=>{try{if(response.error)throw new Error(response.error);const r=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:`Bearer ${response.access_token}`},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Google 帳號驗證失敗');const profile=await r.json();setSessionToken('');await setMeta('serverSession',null);await rememberAccess({accessToken:response.access_token,expiresIn:response.expires_in,profile});setState({phase:'legacy',persistent:false,lastRestoredAt:Date.now(),reason:'PERSISTENT_AUTH_NOT_CONFIGURED'});onSuccess(profile)}catch(e){onError(e)}},error_callback:e=>onError(new Error(e.type==='popup_closed'?'已取消登入':'Google 登入視窗未能開啟'))});client.requestAccessToken({prompt:''});
  }
}
export async function logout(){
  const session=getSessionToken();if(session){try{await request('/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${session}`},body:'{}'})}catch{/* Local sign-out still succeeds offline; server session expires automatically. */}}
  setAccessToken('');setSessionToken('');expiry=0;restoredProfile=null;setState({phase:'signed-out',persistent:false,lastRestoredAt:0,sessionExpiresAt:0,reason:''});
  await setMeta('googleSession',null);await setMeta('serverSession',null);await setMeta('lastProfile',null);
}

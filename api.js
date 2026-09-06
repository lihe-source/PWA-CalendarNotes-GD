import {stage,listQueue,acknowledge,retainConflict,markQueueError,getScope} from './db.js';
const cfg=window.APP_CONFIG;
let accessToken='',sessionToken='',refreshHook=null,flushPromise=null;
export const setAccessToken=t=>{accessToken=t||''};
export const getAccessToken=()=>accessToken;
export const setSessionToken=t=>{sessionToken=t||''};
export const getSessionToken=()=>sessionToken;
export const setRefreshHook=fn=>{refreshHook=fn};
export async function ensureToken(){if(refreshHook)await refreshHook();if(!accessToken&&!sessionToken)throw new Error('GOOGLE_LOGIN_REQUIRED');return accessToken;}
export async function api(path,options={}){
  await ensureToken();
  const scope=getScope();
  const res=await fetch(`${cfg.API_BASE_URL.replace(/\/$/,'')}${path}`,{
    ...options,signal:options.signal||AbortSignal.timeout(path==='/api/restore'?120000:20000),
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${sessionToken||accessToken}`,...options.headers}
  });
  const data=await res.json().catch(()=>({}));
  if(scope!==getScope())throw new Error('ACCOUNT_CHANGED');
  if(!res.ok){const e=new Error(data.error||`HTTP_${res.status}`);e.status=res.status;e.data=data;throw e;}return data;
}
export async function saveRemote(kind,item){const local=await stage(kind,item,'put');return local;}
export async function deleteRemote(kind,item){const local={...item,deleted_at:new Date().toISOString(),updated_at:new Date().toISOString()};return stage(kind,local,'delete');}
export async function flushQueue(){
  if(flushPromise)return flushPromise;
  flushPromise=flush().finally(()=>{flushPromise=null});return flushPromise;
}
async function flush(){
  if((!accessToken&&!sessionToken)||!navigator.onLine)return {done:0,pending:(await listQueue()).length};
  let done=0,conflicts=0;const scope=getScope();
  for(const op of (await listQueue()).sort((a,b)=>a.queued_at.localeCompare(b.queued_at))){
    if(op.scope!==scope||getScope()!==scope)throw new Error('ACCOUNT_CHANGED');
    if(op.error?.startsWith('刪除衝突')){conflicts++;continue;}
    try{
      const data=await api(`/api/${op.kind}/${encodeURIComponent(op.item.id)}`,{method:op.action==='delete'?'DELETE':'PUT',body:JSON.stringify({...op.item,base_revision:Number(op.item.revision||0),mutation_id:op.generation})});
      if(!data.ok)throw new Error('未收到伺服器確認');
      await acknowledge(op,data.item||{...op.item,deleted_at:op.item.deleted_at||new Date().toISOString()});done++;
    }catch(e){
      if(e.status===409&&e.data?.server){await retainConflict(op,e.data.server);conflicts++;continue;}
      await markQueueError(op,e.message);throw e;
    }
  }
  return {done,conflicts,pending:(await listQueue()).length};
}

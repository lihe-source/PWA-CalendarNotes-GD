import { enqueue, listQueue, removeQueue, put as dbPut } from './db.js';

const cfg = window.APP_CONFIG;
let accessToken = '';
export function setAccessToken(token){accessToken=token||'';}
export function getAccessToken(){return accessToken;}

export async function api(path, options={}){
  if (!accessToken) throw new Error('GOOGLE_LOGIN_REQUIRED');
  const url = `${cfg.API_BASE_URL.replace(/\/$/,'')}${path}`;
  const res = await fetch(url,{
    ...options,
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${accessToken}`,...(options.headers||{})}
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok){
    const e=new Error(data.error||`HTTP_${res.status}`); e.status=res.status; e.data=data; throw e;
  }
  return data;
}

export async function saveRemote(kind,item,{queueOnOffline=true}={}){
  if(!accessToken){if(queueOnOffline)await enqueue({action:'put',kind,item});return item;}
  try{
    const data=await api(`/api/${kind}/${encodeURIComponent(item.id)}`,{method:'PUT',body:JSON.stringify({...item,base_revision:Number(item.revision||0)})});
    await dbPut(kind,data.item);
    return data.item;
  }catch(e){
    if (!navigator.onLine || e.name==='TypeError'){
      if(queueOnOffline)await enqueue({action:'put',kind,item}); return item;
    }
    if (e.status===409 && e.data?.server){
      // 保留伺服器版本，同時建立本機衝突副本，避免使用者內容被覆蓋。
      await dbPut(kind,e.data.server);
      const copy={...item,id:`${item.id}-conflict-${Date.now()}`,title:`${item.title}（衝突副本）`,revision:0,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
      await enqueue({action:'put',kind,item:copy});
      await dbPut(kind,copy);
      return e.data.server;
    }
    throw e;
  }
}

export async function deleteRemote(kind,item,{queueOnOffline=true}={}){
  if(!accessToken){const tomb={...item,deleted_at:new Date().toISOString(),updated_at:new Date().toISOString()};await dbPut(kind,tomb);if(queueOnOffline)await enqueue({action:'delete',kind,item:tomb});return tomb;}
  try{
    const data=await api(`/api/${kind}/${encodeURIComponent(item.id)}`,{method:'DELETE',body:JSON.stringify({base_revision:Number(item.revision||0)})});
    await dbPut(kind,data.item||{...item,deleted_at:new Date().toISOString()});
    return data.item;
  }catch(e){
    if (!navigator.onLine || e.name==='TypeError'){
      const tomb={...item,deleted_at:new Date().toISOString(),updated_at:new Date().toISOString()};
      await dbPut(kind,tomb); if(queueOnOffline)await enqueue({action:'delete',kind,item:tomb}); return tomb;
    }
    throw e;
  }
}

export async function flushQueue(){
  if (!accessToken || !navigator.onLine) return {done:0};
  const q=await listQueue(); let done=0;
  for (const op of q.sort((a,b)=>a.queued_at.localeCompare(b.queued_at))){
    try{
      if (op.action==='put') await saveRemote(op.kind,op.item,{queueOnOffline:false});
      else if (op.action==='delete') await deleteRemote(op.kind,op.item,{queueOnOffline:false});
      await removeQueue(op.qid); done++;
    }catch(e){
      if (e.status===401) break;
      console.warn('queue item failed',op,e);
    }
  }
  return {done};
}

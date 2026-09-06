// App-path + account + workspace isolation. Resolve writes only after transaction commit.
const appPath = new URL('./', import.meta.url).pathname;
const prefix = `calendar-notes-v2:${appPath}`;
const globalKeys = new Set(['googleSession','serverSession','theme','uiStyle','activeScope','lastDriveRoot','lastProfile','authConfig']);
let activeScope = 'guest';
const handles = new Map();
function open(name) {
  if (!handles.has(name)) handles.set(name, new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { for (const [s,key] of [['events','id'],['notes','id'],['meta','key'],['queue','qid']]) req.result.createObjectStore(s,{keyPath:key}); };
    req.onsuccess = () => { const db=req.result; db.onversionchange=()=>{db.close();handles.delete(name)}; resolve(db); };
    req.onerror = () => {handles.delete(name);reject(req.error)};
    req.onblocked = () => reject(new Error('請關閉其他分頁後重試'));
  }));
  return handles.get(name);
}
const dataName = () => `${prefix}:${activeScope}`;
async function transaction(name, stores, mode, action) {
  const db=await open(name);
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(stores,mode);let value;
    tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('資料寫入已取消'));
    try{action(tx,v=>{value=v})}catch(e){tx.abort();reject(e)}
  });
}
export async function initializeStore(){ activeScope=await getMeta('activeScope','guest'); return activeScope; }
export function getScope(){return activeScope;}
export async function setScope(userSub='',folder='') {
  activeScope=userSub?`${userSub}:${folder||'unjoined'}`:'guest';
  await setMeta('activeScope',activeScope);return activeScope;
}
export async function all(name){return transaction(dataName(),[name],'readonly',(tx,done)=>{tx.objectStore(name).getAll().onsuccess=e=>done(e.target.result)});}
export async function get(name,key){return transaction(dataName(),[name],'readonly',(tx,done)=>{tx.objectStore(name).get(key).onsuccess=e=>done(e.target.result)});}
export async function put(name,value){return transaction(dataName(),[name],'readwrite',tx=>tx.objectStore(name).put(value));}
export async function clear(name){return transaction(dataName(),[name],'readwrite',tx=>tx.objectStore(name).clear());}
export async function del(name,key){return transaction(dataName(),[name],'readwrite',tx=>tx.objectStore(name).delete(key));}
export async function getMeta(key,fallback=null){const name=globalKeys.has(key)?`${prefix}:preferences`:dataName();return transaction(name,['meta'],'readonly',(tx,done)=>{tx.objectStore('meta').get(key).onsuccess=e=>done(e.target.result?.value??fallback)});}
export async function setMeta(key,value){const name=globalKeys.has(key)?`${prefix}:preferences`:dataName();return transaction(name,['meta'],'readwrite',tx=>tx.objectStore('meta').put({key,value}));}
export async function stage(kind,item,action='put') {
  const scope=activeScope, qid=`${kind}:${item.id}`,generation=crypto.randomUUID();
  return transaction(dataName(),[kind,'queue'],'readwrite',(tx,done)=>{
    const queue=tx.objectStore('queue');
    queue.get(qid).onsuccess=e=>{
      const prior=e.target.result;
      const value={...item,revision:Number(prior?.item.revision??item.revision??0)};
      tx.objectStore(kind).put(value);
      queue.put({qid,kind,item:value,action,generation,scope,queued_at:prior?.queued_at||new Date().toISOString()});
      done(value);
    };
  });
}
export async function acknowledge(op,server) {
  if(op.scope!==activeScope)throw new Error('ACCOUNT_CHANGED');
  return transaction(dataName(),[op.kind,'queue'],'readwrite',tx=>{
    const q=tx.objectStore('queue');q.get(op.qid).onsuccess=e=>{
      const pending=e.target.result;
      if(!pending)return;
      if(pending.generation===op.generation){q.delete(op.qid);if(server)tx.objectStore(op.kind).put(server)}
      else if(server){pending.item.revision=server.revision;q.put(pending);tx.objectStore(op.kind).put(pending.item)}
    };
  });
}
export async function retainConflict(op,server){
  if(op.scope!==activeScope)throw new Error('ACCOUNT_CHANGED');
  return transaction(dataName(),[op.kind,'queue'],'readwrite',tx=>{
    const q=tx.objectStore('queue');q.get(op.qid).onsuccess=e=>{
      const pending=e.target.result;if(!pending)return;
      // A delete conflict is kept for explicit user resolution, never silently retried.
      if(pending.action==='delete'){pending.error='刪除衝突：資料已在其他裝置變更';pending.server=server;q.put(pending);return;}
      const copy={...pending.item,id:crypto.randomUUID(),title:`${pending.item.title}（衝突副本）`,revision:0,deleted_at:null};
      tx.objectStore(op.kind).put(server);tx.objectStore(op.kind).put(copy);q.delete(op.qid);
      q.put({...pending,qid:`${op.kind}:${copy.id}`,item:copy,generation:crypto.randomUUID(),error:''});
    };
  });
}
export async function markQueueError(op,message){if(op.scope!==activeScope)return;return transaction(dataName(),['queue'],'readwrite',tx=>{const s=tx.objectStore('queue');s.get(op.qid).onsuccess=e=>{const q=e.target.result;if(q&&q.generation===op.generation)s.put({...q,error:message})}});}
export const listQueue=()=>all('queue');
export async function applyRemote(events,notes,cursor){
  return transaction(dataName(),['events','notes','queue','meta'],'readwrite',tx=>{
    const queue=tx.objectStore('queue');
    for(const [kind,items]of[['events',events],['notes',notes]])for(const item of items){queue.get(`${kind}:${item.id}`).onsuccess=e=>{if(!e.target.result)tx.objectStore(kind).put(item)}}
    tx.objectStore('meta').put({key:'lastSync',value:cursor});
  });
}
export async function replaceSnapshot(events,notes,cursor){
  return transaction(dataName(),['events','notes','queue','meta'],'readwrite',tx=>{for(const s of ['events','notes','queue'])tx.objectStore(s).clear();for(const e of events)tx.objectStore('events').put(e);for(const n of notes)tx.objectStore('notes').put(n);tx.objectStore('meta').put({key:'lastSync',value:cursor})});
}
export async function readLegacy(){
  if(await getMeta('legacyMigrated',false))return null;
  const names=typeof indexedDB.databases==='function'?await indexedDB.databases():null;
  if(names&&!names.some(x=>x.name==='calendar-notes-pwa'))return null;
  return new Promise(resolve=>{
    const req=indexedDB.open('calendar-notes-pwa');let fresh=false;
    req.onupgradeneeded=()=>{fresh=true;req.transaction.abort()};req.onerror=()=>resolve(null);
    req.onsuccess=async()=>{const db=req.result;if(fresh||!db.objectStoreNames.contains('meta')){db.close();resolve(null);return}
      try{const read=s=>new Promise((ok,no)=>{const r=db.transaction(s).objectStore(s).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});const [events,notes,meta,queue]=await Promise.all(['events','notes','meta','queue'].map(read));db.close();resolve({events,notes,meta:Object.fromEntries(meta.map(x=>[x.key,x.value])),queue})}catch{db.close();resolve(null)}
    };
  });
}
export async function migrateLegacy(legacy,profile,folder){
  if(!legacy||legacy.meta.googleSession?.profile?.sub!==profile.sub||legacy.meta.driveRoot!==folder||await getMeta('legacyMigrated',false))return false;
  for(const kind of ['events','notes'])for(const item of legacy[kind])if(!await get(kind,item.id))await put(kind,item);
  for(const op of (legacy.queue||[]).sort((a,b)=>String(a.queued_at).localeCompare(String(b.queued_at))))await stage(op.kind,op.item,op.action);
  await setMeta('lastSync','1970-01-01T00:00:00.000Z');await setMeta('legacyMigrated',true);return true;
}
export async function guestRecords(){return transaction(`${prefix}:guest`,['events','notes'],'readonly',(tx,done)=>{const data={};for(const kind of ['events','notes'])tx.objectStore(kind).getAll().onsuccess=e=>{data[kind]=e.target.result.filter(x=>!x.deleted_at);if(data.events&&data.notes)done(data)}})}

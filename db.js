const DB_NAME = 'calendar-notes-pwa';
const DB_VERSION = 1;
let dbPromise;

export function openDb(){
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events',{keyPath:'id'});
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes',{keyPath:'id'});
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta',{keyPath:'key'});
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue',{keyPath:'qid'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  return dbPromise;
}

async function store(name, mode='readonly'){
  const db = await openDb();
  return db.transaction(name,mode).objectStore(name);
}

export async function put(name, value){
  const s=await store(name,'readwrite');
  return reqPromise(s.put(value));
}
export async function get(name,key){
  const s=await store(name); return reqPromise(s.get(key));
}
export async function del(name,key){
  const s=await store(name,'readwrite'); return reqPromise(s.delete(key));
}
export async function all(name){
  const s=await store(name); return reqPromise(s.getAll());
}
export async function clear(name){
  const s=await store(name,'readwrite'); return reqPromise(s.clear());
}
export async function setMeta(key,value){return put('meta',{key,value});}
export async function getMeta(key,fallback=null){const r=await get('meta',key);return r?.value ?? fallback;}
export async function enqueue(op){
  const qid=op.qid || `${Date.now()}-${crypto.randomUUID()}`;
  return put('queue',{...op,qid,queued_at:new Date().toISOString()});
}
export async function listQueue(){return all('queue');}
export async function removeQueue(qid){return del('queue',qid);}

function reqPromise(req){
  return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
}

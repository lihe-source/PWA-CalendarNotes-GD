const VERSION='V2.2.0';
const PREFIX=`calendar-notes:${new URL(self.registration.scope).pathname}:`;
const CACHE=PREFIX+VERSION;
const CORE=['./','./index.html','./style.css','./config.js','./app.js','./db.js','./api.js','./auth.js','./recurrence.js','./google-drive.js','./push.js','./holidays.js','./manifest.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
self.addEventListener('install',event=>{event.waitUntil((async()=>{const releaseResponse=await fetch('./version.json',{cache:'no-store'});if(!releaseResponse.ok)throw new Error('Release manifest unavailable');const release=await releaseResponse.json();if(release.version!==VERSION||!release.assets)throw new Error('Release version mismatch');const cache=await caches.open(CACHE);for(const path of CORE){const response=await fetch(new Request(path,{cache:'reload'}));if(!response.ok)throw new Error('Incomplete release');const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await response.clone().arrayBuffer()))).map(n=>n.toString(16).padStart(2,'0')).join('');if(release.assets[path]!==digest)throw new Error('Asset version mismatch: '+path);await cache.put(path,response)}})())});
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)));for(const k of keys.filter(k=>/^calendar-notes-pwa-v1\./.test(k))){const legacy=await caches.open(k),requests=await legacy.keys();if(requests.length&&requests.every(r=>r.url.startsWith(self.registration.scope)))await caches.delete(k);}await self.clients.claim()})())});
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url),scope=new URL(self.registration.scope);
  if(req.method!=='GET'||url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return;
  if(url.pathname.endsWith('/version.json')||url.pathname.endsWith('/service-worker.js')){event.respondWith(fetch(req,{cache:'no-store'}));return;}
  if(req.mode==='navigate'){event.respondWith(caches.open(CACHE).then(async c=>(await c.match('./index.html'))||fetch(req)));return;}
  const relative='./'+url.pathname.slice(scope.pathname.length);
  if(CORE.includes(relative))event.respondWith(caches.open(CACHE).then(async c=>(await c.match(relative))||fetch(req)));
});
self.addEventListener('push',event=>{
  let data={title:'行程提醒',body:'提醒時間到了',url:'./'};try{data={...data,...event.data.json()}}catch{}
  event.waitUntil(self.registration.showNotification(data.title,{body:data.body||'',icon:'./icon-192.png',tag:data.tag||'calendar-reminder',data:{url:data.url||'./'},renotify:true}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const scope=new URL(self.registration.scope);let target;
  try{target=new URL(event.notification.data?.url||'./',scope);if(target.origin!==scope.origin||!target.pathname.startsWith(scope.pathname))target=scope;}catch{target=scope;}
  event.waitUntil((async()=>{const list=await clients.matchAll({type:'window',includeUncontrolled:true});for(const c of list){const u=new URL(c.url);if(u.origin===scope.origin&&u.pathname.startsWith(scope.pathname)){c.postMessage({type:'OPEN_ITEM',url:target.href});await c.focus();return;}}await clients.openWindow(target.href)})());
});

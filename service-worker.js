const CACHE='calendar-notes-pwa-v1.6.0';
const CORE=['./','./index.html','./style.css','./config.js','./app.js','./db.js','./api.js','./google-drive.js','./push.js','./holidays.js','./manifest.json','./version.json','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('calendar-notes-pwa-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;const url=new URL(req.url);
  if(url.origin===location.origin){
    if(url.pathname.endsWith('/version.json')){event.respondWith(fetch(req,{cache:'no-store'}).catch(()=>caches.match(req)));return}
    event.respondWith(fetch(req).then(res=>{const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy));return res}).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html'))));
  }
});
self.addEventListener('push',event=>{
  let data={title:'提醒',body:'你有一個提醒事項',url:'./'};try{const parsed=event.data?.json();data={...data,...parsed}}catch{try{data.body=event.data?.text()||data.body}catch{}}
  event.waitUntil(self.registration.showNotification(data.title||'提醒',{body:data.body||'',icon:'./icon-192.png',badge:'./icon-192.png',tag:data.tag||'calendar-reminder',data:{url:data.url||'./'},renotify:true}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const target=new URL(event.notification.data?.url||'./',self.registration.scope).href;
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{for(const c of list){if('focus'in c){c.navigate(target);return c.focus()}}return clients.openWindow(target)}));
});

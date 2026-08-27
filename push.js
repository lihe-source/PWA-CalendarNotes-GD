import { api } from './api.js';
const cfg=window.APP_CONFIG;

function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');const raw=atob(base64);return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}
export async function enablePush(){
  if(!('serviceWorker'in navigator)||!('PushManager'in window))throw new Error('此瀏覽器不支援 Web Push');
  const perm=await Notification.requestPermission();if(perm!=='granted')throw new Error('通知權限未允許');
  const reg=await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if(!sub){
    if(!cfg.VAPID_PUBLIC_KEY||cfg.VAPID_PUBLIC_KEY.startsWith('REPLACE_'))throw new Error('尚未設定 VAPID_PUBLIC_KEY');
    sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY)});
  }
  await api('/api/push/subscribe',{method:'POST',body:JSON.stringify({subscription:sub.toJSON(),device_name:navigator.userAgent.slice(0,180)})});
  return sub;
}
export async function testPush(){return api('/api/push/test',{method:'POST',body:'{}'});}

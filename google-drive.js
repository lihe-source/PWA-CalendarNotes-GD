import { getAccessToken } from './api.js';

const DRIVE='https://www.googleapis.com/drive/v3';
const UPLOAD='https://www.googleapis.com/upload/drive/v3';

function token(){const t=getAccessToken();if(!t)throw new Error('GOOGLE_LOGIN_REQUIRED');return t;}
async function gfetch(url,opts={}){
  const res=await fetch(url,{...opts,headers:{Authorization:`Bearer ${token()}`,...(opts.headers||{})}});
  if(!res.ok){const text=await res.text();throw new Error(`DRIVE_${res.status}: ${text.slice(0,500)}`);}return res;
}
export function extractFolderId(input){
  const s=String(input||'').trim();
  const m=s.match(/\/folders\/([A-Za-z0-9_-]+)/); if(m)return m[1];
  if(/^[A-Za-z0-9_-]{10,}$/.test(s))return s; return '';
}
export async function verifyFolder(folderId){
  const fields='id,name,mimeType,driveId,capabilities(canAddChildren,canEdit,canReadDrive)';
  const r=await gfetch(`${DRIVE}/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`);
  const d=await r.json();
  if(d.mimeType!=='application/vnd.google-apps.folder')throw new Error('指定位置不是資料夾');
  if(d.capabilities && d.capabilities.canAddChildren===false)throw new Error('此 Google 帳號沒有新增檔案到該資料夾的權限');
  return d;
}
function escQ(s){return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");}
export async function findChildFolder(parentId,name){
  const q=`'${escQ(parentId)}' in parents and name='${escQ(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const u=new URL(`${DRIVE}/files`);u.searchParams.set('q',q);u.searchParams.set('fields','files(id,name)');u.searchParams.set('pageSize','10');u.searchParams.set('supportsAllDrives','true');u.searchParams.set('includeItemsFromAllDrives','true');
  const r=await gfetch(u);const d=await r.json();return d.files?.[0]||null;
}
export async function createFolder(parentId,name){
  const r=await gfetch(`${DRIVE}/files?supportsAllDrives=true&fields=id,name`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[parentId]})});return r.json();
}
export async function ensureFolder(parentId,name){return await findChildFolder(parentId,name)||await createFolder(parentId,name);}
export async function ensureAppFolders(rootId){
  const app=await ensureFolder(rootId,'CalendarPWA-Data');
  const attachments=await ensureFolder(app.id,'Attachments');
  const backups=await ensureFolder(app.id,'Backups');
  return {app,attachments,backups};
}
export async function uploadFile(file,parentId,name=file.name){
  const init=await gfetch(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,createdTime`,{
    method:'POST',headers:{'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':file.type||'application/octet-stream','X-Upload-Content-Length':String(file.size)},body:JSON.stringify({name,parents:[parentId]})
  });
  const location=init.headers.get('Location'); if(!location)throw new Error('Google Drive 未回傳 resumable upload URL');
  const done=await fetch(location,{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});
  if(!done.ok)throw new Error(`Drive upload failed: ${done.status} ${await done.text()}`); return done.json();
}
export async function uploadJson(obj,parentId,name){
  const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}); const file=new File([blob],name,{type:'application/json'});return uploadFile(file,parentId,name);
}
export async function getOrCreateItemFolder(attachmentsRoot,itemId){return ensureFolder(attachmentsRoot,itemId);}
export async function listLatestBackups(backupsId){
  const q=`'${escQ(backupsId)}' in parents and trashed=false and mimeType='application/json'`;
  const u=new URL(`${DRIVE}/files`);u.searchParams.set('q',q);u.searchParams.set('orderBy','modifiedTime desc');u.searchParams.set('pageSize','10');u.searchParams.set('fields','files(id,name,modifiedTime,size)');u.searchParams.set('supportsAllDrives','true');u.searchParams.set('includeItemsFromAllDrives','true');
  const r=await gfetch(u);return (await r.json()).files||[];
}
export async function downloadJson(fileId){const r=await gfetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);return r.json();}

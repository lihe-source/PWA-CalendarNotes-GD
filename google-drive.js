import {ensureToken} from './api.js';
import {refreshAccess} from './auth.js';
const DRIVE='https://www.googleapis.com/drive/v3',UPLOAD='https://www.googleapis.com/upload/drive/v3';
async function gfetch(url,options={},retry=true){
  const token=await ensureToken();const r=await fetch(url,{...options,signal:options.signal||AbortSignal.timeout(25000),headers:{Authorization:`Bearer ${token}`,...options.headers}});
  if(r.status===401&&retry){await refreshAccess(true);return gfetch(url,options,false)}
  if(!r.ok){const e=new Error(`Google Drive ${r.status}：${(await r.text()).slice(0,160)}`);e.status=r.status;throw e;}return r;
}
export function extractFolderId(input){const s=String(input||'').trim(),m=s.match(/\/folders\/([A-Za-z0-9_-]+)/);return m?.[1]||(/^[A-Za-z0-9_-]{10,}$/.test(s)?s:'');}
export async function verifyFolder(id){const r=await gfetch(`${DRIVE}/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,mimeType,capabilities(canAddChildren,canEdit)`);const d=await r.json();if(d.mimeType!=='application/vnd.google-apps.folder')throw new Error('指定位置不是資料夾');return d;}
const escape=s=>String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
async function folder(parent,name){const u=new URL(DRIVE+'/files');u.search=new URLSearchParams({q:`'${escape(parent)}' in parents and name='${escape(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,fields:'files(id,name)',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});const data=await(await gfetch(u)).json();if(data.files?.[0])return data.files[0];return(await gfetch(DRIVE+'/files?supportsAllDrives=true&fields=id,name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,parents:[parent],mimeType:'application/vnd.google-apps.folder'})})).json();}
export async function ensureAppFolders(root){const app=await folder(root,'CalendarPWA-Data');const [attachments,backups]=await Promise.all([folder(app.id,'Attachments'),folder(app.id,'Backups')]);return {app,attachments,backups};}
export const getOrCreateItemFolder=(root,id)=>folder(root,id);
function uploadChunk(url,blob,start,total,signal,onProgress){return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhr.open('PUT',url);xhr.timeout=60000;xhr.setRequestHeader('Content-Type',blob.type||'application/octet-stream');xhr.setRequestHeader('Content-Range',`bytes ${start}-${start+blob.size-1}/${total}`);
  const abort=()=>xhr.abort();if(signal?.aborted){reject(new DOMException('已取消上傳','AbortError'));return;}signal?.addEventListener('abort',abort,{once:true});
  const cleanup=()=>signal?.removeEventListener('abort',abort);
  xhr.upload.onprogress=e=>onProgress?.(Math.min(total,start+e.loaded),total);
  xhr.onload=()=>{cleanup();resolve({status:xhr.status,text:xhr.responseText,range:xhr.getResponseHeader('Range')})};
  xhr.onerror=()=>{cleanup();reject(new TypeError('上傳連線中斷'))};xhr.ontimeout=()=>{cleanup();reject(new Error('上傳逾時'))};xhr.onabort=()=>{cleanup();reject(new DOMException('已取消上傳','AbortError'))};xhr.send(blob);
});}
export async function uploadFile(file,parent,name=file.name,{signal,onProgress}={}){
  const initial=await gfetch(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,thumbnailLink,createdTime`,{method:'POST',signal,headers:{'Content-Type':'application/json','X-Upload-Content-Type':file.type||'application/octet-stream','X-Upload-Content-Length':String(file.size)},body:JSON.stringify({name,parents:[parent]})});
  const url=initial.headers.get('Location');if(!url)throw new Error('Drive 未回傳上傳位置');
  if(!file.size){const r=await fetch(url,{method:'PUT',body:file,signal,headers:{'Content-Type':file.type||'application/octet-stream'}});if(!r.ok)throw new Error(`空檔案上傳失敗 ${r.status}`);return r.json();}
  let start=0,retries=0;
  while(start<file.size){
    signal?.throwIfAborted();let result;
    try{result=await uploadChunk(url,file.slice(start,Math.min(start+1024*1024,file.size),file.type),start,file.size,signal,onProgress)}catch(e){if(e.name==='AbortError')throw e;result={status:503};}
    if(result.status===200||result.status===201){onProgress?.(file.size,file.size);return JSON.parse(result.text)}
    if(result.status===308){const end=result.range?.match(/-(\d+)$/);if(end){start=Number(end[1])+1;retries=0;continue;}}
    else if(result.status<500&&result.status!==429&&result.status!==0)throw new Error(`附件上傳失敗（${result.status}）`);
    if(++retries>4)throw new Error('網路不穩定，上傳已保留文字草稿；請稍後重試附件');
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,Math.min(8000,500*2**retries));signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('已取消','AbortError'))},{once:true})});
    const status=await fetch(url,{method:'PUT',signal:signal||AbortSignal.timeout(20000),headers:{'Content-Range':`bytes */${file.size}`}});
    if(status.ok)return status.json();if(status.status===404)throw new Error('上傳工作階段已失效，請重新選取檔案');if(status.status===308){const end=status.headers.get('Range')?.match(/-(\d+)$/);start=end?Number(end[1])+1:0;}
  }
  throw new Error('Drive 尚未確認檔案上傳完成');
}
export const uploadJson=(obj,parent,name,options)=>uploadFile(new File([JSON.stringify(obj)],name,{type:'application/json'}),parent,name,options);
export async function listLatestBackups(id){const u=new URL(DRIVE+'/files');u.search=new URLSearchParams({q:`'${escape(id)}' in parents and trashed=false and mimeType='application/json'`,orderBy:'modifiedTime desc',pageSize:'20',fields:'files(id,name,modifiedTime,size)',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});return(await(await gfetch(u)).json()).files||[];}
export async function downloadJson(id){return(await gfetch(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`)).json();}

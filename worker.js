import {sendPushNotification,WebPushError} from '@mmmike/web-push/send';
import {authenticate,persistentReady,exchangeCode,endSession} from './server-auth.js';
import {nextTrigger,occurrenceAt,dateKeyInZone,validTimezone} from './recurrence.js';

async function upsertUser(db, user) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO users (user_sub, email, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_sub) DO UPDATE SET
      email=excluded.email,
      name=excluded.name,
      updated_at=excluded.updated_at
  `).bind(user.sub, user.email, user.name, now, now).run();
}

const SHARED_WORKSPACE_ID = 'shared-main';

async function getWorkspaceAccess(db, userSub) {
  const row = await db.prepare(`
    SELECT wm.workspace_id, wm.role, wm.status, wm.email, wm.name,
           wm.last_verified_at, w.name AS workspace_name, w.drive_root_folder_id, w.timezone, w.owner_sub
    FROM workspace_members wm
    JOIN workspaces w ON w.workspace_id=wm.workspace_id
    WHERE wm.user_sub=? AND wm.status='active'
    ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
    LIMIT 1
  `).bind(userSub).first();
  return row || null;
}

async function workspaceStatus(env, user, cors) {
  let access = await getWorkspaceAccess(env.DB, user.sub);

  // 尚未登記為成員時：如果共享工作區已存在，直接用目前 Google token
  // 驗證該帳號是否有共用 Drive Folder 權限；有權限就自動加入。
  if (!access) {
    const ws = await env.DB.prepare(`SELECT * FROM workspaces WHERE workspace_id=?`).bind(SHARED_WORKSPACE_ID).first();
    if (!ws?.drive_root_folder_id) return json({ ok:true, joined:false }, 200, cors);
    const verified = await verifyDriveFolderAccess(user.token, ws.drive_root_folder_id);
    if (!verified.ok) return json({ ok:true, joined:false, reason:'DRIVE_ACCESS_REQUIRED' }, 200, cors);
    const now = new Date().toISOString();
    const role = ws.owner_sub===user.sub ? 'owner' : (verified.canEdit ? 'editor' : 'viewer');
    await env.DB.prepare(`
      INSERT INTO workspace_members (workspace_id,user_sub,email,name,role,status,joined_at,updated_at,last_verified_at)
      VALUES (?,?,?,?,?,'active',?,?,?)
      ON CONFLICT(workspace_id,user_sub) DO UPDATE SET
        email=excluded.email,name=excluded.name,role=excluded.role,status='active',updated_at=excluded.updated_at,last_verified_at=excluded.last_verified_at
    `).bind(ws.workspace_id,user.sub,user.email,user.name,role,now,now,now).run();
    access = await getWorkspaceAccess(env.DB,user.sub);
  }

  // 已加入的成員，每次重新登入時再驗證一次 Drive 權限。
  const verified = await verifyDriveFolderAccess(user.token, access.drive_root_folder_id);
  if (!verified.ok) {
    await env.DB.prepare(`UPDATE workspace_members SET status='inactive', updated_at=? WHERE workspace_id=? AND user_sub=?`)
      .bind(new Date().toISOString(), access.workspace_id, user.sub).run();
    return json({ ok:true, joined:false, reason:'DRIVE_ACCESS_REVOKED' }, 200, cors);
  }
  const role = access.owner_sub===user.sub ? 'owner' : (verified.canEdit ? 'editor' : 'viewer');
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE workspace_members SET role=?, email=?, name=?, status='active', updated_at=?, last_verified_at=? WHERE workspace_id=? AND user_sub=?`)
    .bind(role, user.email, user.name, now, now, access.workspace_id, user.sub).run();
  access = await getWorkspaceAccess(env.DB, user.sub);
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND status='active'`).bind(access.workspace_id).first();
  return json({ ok:true, joined:true, workspace: workspaceJson(access), memberCount:Number(count?.n||0) }, 200, cors);
}

async function joinWorkspace(request, env, user, cors) {
  const body = await safeJson(request);
  const folderId = String(body.drive_root_folder_id || '').trim();
  if (!folderId) return json({ok:false,error:'DRIVE_FOLDER_REQUIRED'},400,cors);
  const verified = await verifyDriveFolderAccess(user.token, folderId);
  if (!verified.ok) return json({ok:false,error:verified.error||'DRIVE_ACCESS_REQUIRED'},403,cors);

  const now = new Date().toISOString();
  let ws = await env.DB.prepare(`SELECT * FROM workspaces WHERE workspace_id=?`).bind(SHARED_WORKSPACE_ID).first();
  if (!ws) {
    await env.DB.prepare(`INSERT INTO workspaces (workspace_id,name,drive_root_folder_id,timezone,owner_sub,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(SHARED_WORKSPACE_ID, '共享行事曆', folderId, 'Asia/Taipei', user.sub, now, now).run();
    ws = await env.DB.prepare(`SELECT * FROM workspaces WHERE workspace_id=?`).bind(SHARED_WORKSPACE_ID).first();
  } else if (!ws.drive_root_folder_id) {
    await env.DB.prepare(`UPDATE workspaces SET drive_root_folder_id=?, owner_sub=CASE WHEN owner_sub='' THEN ? ELSE owner_sub END, updated_at=? WHERE workspace_id=?`)
      .bind(folderId, user.sub, now, SHARED_WORKSPACE_ID).run();
    ws = await env.DB.prepare(`SELECT * FROM workspaces WHERE workspace_id=?`).bind(SHARED_WORKSPACE_ID).first();
  } else if (ws.drive_root_folder_id !== folderId) {
    return json({ok:false,error:'WORKSPACE_FOLDER_MISMATCH'},409,cors);
  }

  const role = ws.owner_sub===user.sub ? 'owner' : (verified.canEdit ? 'editor' : 'viewer');
  await env.DB.prepare(`
    INSERT INTO workspace_members (workspace_id,user_sub,email,name,role,status,joined_at,updated_at,last_verified_at)
    VALUES (?,?,?,?,?,'active',?,?,?)
    ON CONFLICT(workspace_id,user_sub) DO UPDATE SET
      email=excluded.email, name=excluded.name, role=excluded.role, status='active',
      updated_at=excluded.updated_at, last_verified_at=excluded.last_verified_at
  `).bind(SHARED_WORKSPACE_ID,user.sub,user.email,user.name,role,now,now,now).run();

  // 保留舊版 per-user 設定，方便舊裝置升級與備份相容。
  await env.DB.prepare(`
    INSERT INTO user_settings (user_sub,drive_root_folder_id,timezone,updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(user_sub) DO UPDATE SET drive_root_folder_id=excluded.drive_root_folder_id, timezone=excluded.timezone, updated_at=excluded.updated_at
  `).bind(user.sub,folderId,ws.timezone||'Asia/Taipei',now).run();

  const access = await getWorkspaceAccess(env.DB,user.sub);
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND status='active'`).bind(SHARED_WORKSPACE_ID).first();
  return json({ok:true,joined:true,workspace:workspaceJson(access),memberCount:Number(count?.n||0)},200,cors);
}

async function verifyDriveFolderAccess(token, folderId) {
  if (!token || !folderId) return {ok:false,error:'DRIVE_ACCESS_REQUIRED'};
  const fields = encodeURIComponent('id,name,mimeType,trashed,capabilities(canEdit,canAddChildren,canShare)');
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=${fields}&supportsAllDrives=true`, {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
  if (r.status>=500||r.status===429)throw problem('Google Drive 暫時無法連線',503);
  if (!r.ok) return {ok:false,error:r.status===404?'DRIVE_FOLDER_NOT_FOUND':'DRIVE_ACCESS_REQUIRED'};
  const f = await r.json();
  if (f.trashed || f.mimeType!=='application/vnd.google-apps.folder') return {ok:false,error:'DRIVE_FOLDER_INVALID'};
  return {ok:true,name:f.name||'',canEdit:!!(f.capabilities?.canEdit||f.capabilities?.canAddChildren),canShare:!!f.capabilities?.canShare};
}

function workspaceJson(access){
  return {
    id:access.workspace_id,
    name:access.workspace_name||'共享行事曆',
    drive_root_folder_id:access.drive_root_folder_id||'',
    timezone:access.timezone||'Asia/Taipei',
    role:access.role||'viewer',
    owner:access.owner_sub||''
  };
}

async function workspaceMembers(env, access, cors){
  const rows=await env.DB.prepare(`SELECT email,name,role,status,joined_at,last_verified_at FROM workspace_members WHERE workspace_id=? AND status='active' ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, name, email`).bind(access.workspace_id).all();
  return json({ok:true,members:rows.results||[]},200,cors);
}

function canWrite(access){return access && (access.role==='owner'||access.role==='editor');}


function dbEventToJson(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description || '',
    location: r.location || '',
    start_at: r.start_at,
    end_at: r.end_at,
    all_day: !!r.all_day,
    category: r.category || '',
    color: r.color || '',
    completed: !!r.completed,
    repeat_rule: r.repeat_rule || '',
    reminder_minutes: parseJson(r.reminder_minutes, []),
    attachment_meta: parseJson(r.attachment_meta, []),
    revision: Number(r.revision || 0),
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at || null
  };
}

function dbNoteToJson(r) {
  return {
    id: r.id,
    title: r.title,
    content: r.content || '',
    category: r.category || '',
    tags: parseJson(r.tags, []),
    pinned: !!r.pinned,
    completed: !!r.completed,
    reminder_at: r.reminder_at || null,
    attachment_meta: parseJson(r.attachment_meta, []),
    revision: Number(r.revision || 0),
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at || null
  };
}

const problem=(message,status=400)=>Object.assign(new Error(message),{status});
function json(data,status=200,cors={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...cors}})}
function corsHeaders(request,env){const origin=request.headers.get('Origin')||'',allowed=String(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim());return {'Access-Control-Allow-Origin':allowed.includes(origin)?origin:'null','Access-Control-Allow-Headers':'Authorization, Content-Type, X-Requested-With','Access-Control-Allow-Methods':'GET, PUT, POST, DELETE, OPTIONS','Access-Control-Max-Age':'86400',Vary:'Origin'}}
function parseJson(value,fallback){try{return JSON.parse(value)}catch{return fallback}}
function normalizeMinutes(value){return [...new Set((Array.isArray(value)?value:[]).map(Number).filter(v=>Number.isInteger(v)&&v>=0&&v<=10080))].sort((a,b)=>a-b)}
async function safeJson(request){try{return await request.json()}catch{throw problem('INVALID_JSON')}}
function validateId(id){if(!/^[A-Za-z0-9._:-]{1,180}$/.test(id))throw problem('INVALID_ID')}
function truncate(s,n){return String(s||'').replace(/\s+/g,' ').slice(0,n)}
const tables={events:['title','description','location','start_at','end_at','all_day','category','color','completed','repeat_rule','reminder_minutes','attachment_meta'],notes:['title','content','category','tags','pinned','completed','reminder_at','attachment_meta']};
const convert=(kind,row)=>kind==='events'?dbEventToJson(row):dbNoteToJson(row);
function normalizeItem(kind,input){
  if(!input||typeof input!=='object'||typeof input.title!=='string'||!input.title.trim())throw problem('TITLE_REQUIRED');validateId(input.id);
  const item={id:input.id,title:input.title.trim().slice(0,300),category:String(input.category||'').slice(0,40),completed:!!input.completed,attachment_meta:[]};
  for(const a of Array.isArray(input.attachment_meta)?input.attachment_meta:[]){if(typeof a.id!=='string'||!a.id)continue;item.attachment_meta.push({id:a.id,name:String(a.name||'附件').slice(0,250),mimeType:String(a.mimeType||''),size:Math.max(0,Number(a.size)||0),webViewLink:`https://drive.google.com/file/d/${encodeURIComponent(a.id)}/view`,thumbnailLink:'',createdTime:a.createdTime||''})}
  const date=s=>{if(!s)return null;const d=new Date(s);if(!Number.isFinite(d.getTime()))throw problem('INVALID_DATE');return d.toISOString()};
  if(kind==='events'){
    item.start_at=date(input.start_at);if(!item.start_at)throw problem('START_REQUIRED');item.end_at=date(input.end_at);if(item.end_at&&item.end_at<item.start_at)throw problem('END_BEFORE_START');
    Object.assign(item,{description:String(input.description||'').slice(0,30000),location:String(input.location||'').slice(0,500),all_day:!!input.all_day,color:String(input.color||'').slice(0,30),repeat_rule:String(input.repeat_rule||''),reminder_minutes:normalizeMinutes(input.reminder_minutes)});
    if(!['','daily','weekly','monthly','yearly'].includes(item.repeat_rule))throw problem('INVALID_REPEAT');
    if(item.end_at&&Date.parse(item.end_at)-Date.parse(item.start_at)>3660*86400000)throw problem('行程跨度不可超過十年');
  }else Object.assign(item,{content:String(input.content||'').slice(0,60000),tags:(Array.isArray(input.tags)?input.tags:[]).map(x=>String(x).slice(0,40)).slice(0,30),pinned:!!input.pinned,reminder_at:date(input.reminder_at)});
  if(JSON.stringify(item).length>150000)throw problem('ITEM_TOO_LARGE');return item;
}
function rowValues(kind,item){return tables[kind].map(k=>Array.isArray(item[k])?JSON.stringify(item[k]):typeof item[k]==='boolean'?Number(item[k]):item[k]??null)}
function remindersFor(kind,item,userSub,workspaceId,tz){
  if(item.deleted_at||item.completed)return [];
  const now=new Date(),sourceType=kind==='events'?'event':'note',out=[];
  const entries=kind==='events'?normalizeMinutes(item.reminder_minutes):[0];
  for(const offset of entries){
    let trigger,occurrence;
    if(kind==='events'){
      trigger=nextTrigger(item,offset,new Date(now.getTime()-1000),tz);
      if(!item.repeat_rule&&Date.parse(item.start_at)-offset*60000>=now.getTime()-60000)trigger=new Date(Date.parse(item.start_at)-offset*60000);
      occurrence=trigger?new Date(trigger.getTime()+offset*60000):null;
    }else trigger=item.reminder_at?new Date(item.reminder_at):null;
    if(!trigger||trigger.getTime()<now.getTime()-60000)continue;
    out.push({id:`${sourceType}:${workspaceId}:${item.id}:${offset}:${trigger.toISOString()}`,user_sub:userSub,workspace_id:workspaceId,source_type:sourceType,source_id:item.id,title:item.title,body:JSON.stringify({text:truncate(kind==='events'?(item.location||item.description||''):(item.content||''),180),occurrence:occurrence?.toISOString()||null}),trigger_at:trigger.toISOString(),offset_minutes:offset,created_at:now.toISOString(),updated_at:now.toISOString()});
  }return out;
}
function reminderStatements(db,kind,item,userSub,access){const ws=access.workspace_id,now=new Date().toISOString();const rows=remindersFor(kind,item,userSub,ws,access.timezone||'Asia/Taipei');return [
  db.prepare("UPDATE reminders SET cancelled=1,updated_at=? WHERE workspace_id=? AND source_type=? AND source_id=? AND sent_at IS NULL").bind(now,ws,kind==='events'?'event':'note',item.id),
  db.prepare(`INSERT INTO reminders(id,user_sub,workspace_id,source_type,source_id,title,body,trigger_at,offset_minutes,created_at,updated_at,cancelled,sent_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.user_sub'),json_extract(value,'$.workspace_id'),json_extract(value,'$.source_type'),json_extract(value,'$.source_id'),json_extract(value,'$.title'),json_extract(value,'$.body'),json_extract(value,'$.trigger_at'),json_extract(value,'$.offset_minutes'),json_extract(value,'$.created_at'),json_extract(value,'$.updated_at'),0,NULL FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,cancelled=0,updated_at=excluded.updated_at`).bind(JSON.stringify(rows)),
  db.prepare('DELETE FROM reminder_rebuild_jobs WHERE workspace_id=? AND kind=? AND item_id=?').bind(ws,kind,item.id)
]}
async function receipt(db,ws,id){if(!id)return null;const r=await db.prepare('SELECT response FROM mutation_receipts WHERE workspace_id=? AND mutation_id=?').bind(ws,id).first();return r?JSON.parse(r.response):null;}
async function mutate(request,env,user,access,kind,id){
  if(!canWrite(access))throw problem('READ_ONLY_MEMBER',403);validateId(id);const body=await safeJson(request),mutation=String(body.mutation_id||crypto.randomUUID());validateId(mutation);
  const prior=await receipt(env.DB,access.workspace_id,mutation);if(prior)return prior;
  const old=await env.DB.prepare(`SELECT * FROM ${kind} WHERE workspace_id=? AND id=?`).bind(access.workspace_id,id).first();
  if(old&&Number(body.base_revision||0)!==old.revision)return {conflict:true,server:convert(kind,old)};
  const deleting=request.method==='DELETE';if(deleting&&!old)return {ok:true,item:{...body,id,deleted_at:new Date().toISOString()}};
  const now=new Date().toISOString();let item=deleting?{...convert(kind,old),deleted_at:now}:normalizeItem(kind,{...body,id});
  item={...item,revision:old?old.revision+1:1,created_at:old?.created_at||now,updated_at:now,deleted_at:deleting?now:null};
  const ws=access.workspace_id,creator=old?.user_sub||user.sub,guard=crypto.randomUUID(),result={ok:true,item},statements=[];
  if(old){if(deleting)statements.push(env.DB.prepare(`UPDATE ${kind} SET deleted_at=?,updated_at=?,revision=revision+1 WHERE workspace_id=? AND id=? AND revision=?`).bind(now,now,ws,id,old.revision));
    else statements.push(env.DB.prepare(`UPDATE ${kind} SET ${tables[kind].map(k=>k+'=?').join(',')},revision=?,updated_at=?,deleted_at=NULL WHERE workspace_id=? AND id=? AND revision=?`).bind(...rowValues(kind,item),item.revision,now,ws,id,old.revision));
  }else statements.push(env.DB.prepare(`INSERT INTO ${kind}(id,user_sub,workspace_id,${tables[kind].join(',')},revision,created_at,updated_at,deleted_at) VALUES(${Array(tables[kind].length+7).fill('?').join(',')})`).bind(id,creator,ws,...rowValues(kind,item),1,now,now,null));
  statements.push(env.DB.prepare('INSERT INTO transaction_assertions(id,ok) VALUES(?,changes())').bind(guard));
  statements.push(...reminderStatements(env.DB,kind,item,creator,access));
  statements.push(env.DB.prepare('INSERT INTO mutation_receipts(workspace_id,mutation_id,response,created_at) VALUES(?,?,?,?)').bind(ws,mutation,JSON.stringify(result),now));
  statements.push(env.DB.prepare('DELETE FROM transaction_assertions WHERE id=?').bind(guard));
  try{await env.DB.batch(statements)}catch(e){const replay=await receipt(env.DB,ws,mutation);if(replay)return replay;const latest=await env.DB.prepare(`SELECT * FROM ${kind} WHERE workspace_id=? AND id=?`).bind(ws,id).first();if(latest&&(!old||latest.revision!==old.revision))return {conflict:true,server:convert(kind,latest)};throw e;}
  return result;
}
async function snapshot(env,access,since=null){
  const ws=access.workspace_id,isCursor=/^\d+$/.test(String(since));
  const query=kind=>env.DB.prepare(`SELECT * FROM ${kind} WHERE workspace_id=? ${isCursor?'AND id IN (SELECT item_id FROM change_log WHERE workspace_id=? AND kind=? AND change_id>?)':''} ORDER BY id`).bind(...(isCursor?[ws,ws,kind,Number(since)]:[ws]));
  const result=await env.DB.batch([env.DB.prepare('SELECT COALESCE(MAX(change_id),0) AS cursor FROM change_log WHERE workspace_id=?').bind(ws),query('events'),query('notes'),env.DB.prepare('SELECT generation FROM workspace_state WHERE workspace_id=?').bind(ws),env.DB.prepare('SELECT categories FROM workspace_preferences WHERE workspace_id=?').bind(ws)]);
  return {ok:true,cursor:String(result[0].results[0].cursor),generation:Number(result[3].results[0]?.generation||0),serverTime:new Date().toISOString(),events:result[1].results.map(dbEventToJson),notes:result[2].results.map(dbNoteToJson),workspace:workspaceJson(access),settings:{drive_root_folder_id:access.drive_root_folder_id,timezone:access.timezone,categories:parseJson(result[4].results[0]?.categories,['工作','會議','生活'])}};
}
async function putSettings(request,env,user,access){
  if(!canWrite(access))throw problem('READ_ONLY_MEMBER',403);const body=await safeJson(request),tz=body.timezone||access.timezone;if(!validTimezone(tz))throw problem('INVALID_TIMEZONE');
  const categories=[...new Set((body.categories||[]).map(x=>String(x).trim().slice(0,40)).filter(Boolean))].slice(0,100);
  await env.DB.batch([env.DB.prepare('UPDATE workspaces SET timezone=?,updated_at=? WHERE workspace_id=?').bind(tz,new Date().toISOString(),access.workspace_id),env.DB.prepare('INSERT INTO workspace_preferences(workspace_id,categories) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET categories=excluded.categories').bind(access.workspace_id,JSON.stringify(categories)),env.DB.prepare("INSERT OR IGNORE INTO reminder_rebuild_jobs(workspace_id,kind,item_id) SELECT workspace_id,'events',id FROM events WHERE workspace_id=? AND repeat_rule<>'' AND deleted_at IS NULL").bind(access.workspace_id)]);return {ok:true};
}
async function restore(request,env,user,access){
  if(!canWrite(access))throw problem('READ_ONLY_MEMBER',403);const body=await safeJson(request),data=body.backup;
  if(!data||![1,2].includes(data.schema)||!Array.isArray(data.events)||!Array.isArray(data.notes))throw problem('INVALID_BACKUP');
  if(!Number.isSafeInteger(body.expectedGeneration))throw problem('RESTORE_PREVIEW_REQUIRED');
  if(new TextEncoder().encode(JSON.stringify(data)).length>1500000)throw problem('備份超過安全還原上限（約 1.5 MB），請分批匯入',413);
  if(data.settings?.driveRoot&&data.settings.driveRoot!==access.drive_root_folder_id)throw problem('WORKSPACE_FOLDER_MISMATCH',409);
  if(data.events.length+data.notes.length>2000)throw problem('單次還原最多 2,000 筆記錄，已停止還原',413);
  const current=await snapshot(env,access);if(current.generation!==body.expectedGeneration)throw problem('RESTORE_CONFLICT',409);
  const now=new Date().toISOString(),ws=access.workspace_id,guard=crypto.randomUUID(),historyId=crypto.randomUUID(),statements=[];
  const prepared={};for(const kind of ['events','notes']){const ids=new Set(),old=new Map(current[kind].map(x=>[x.id,x]));prepared[kind]=data[kind].filter(x=>!x.deleted_at).map(x=>{if(ids.has(x.id))throw problem('DUPLICATE_BACKUP_ID');ids.add(x.id);const item=normalizeItem(kind,x);return {...item,revision:Number(old.get(x.id)?.revision||0)+1,created_at:old.get(x.id)?.created_at||now,updated_at:now,deleted_at:null}})}
  const oldPayload=JSON.stringify({...current,schema:2,settings:{...current.settings,driveRoot:access.drive_root_folder_id}});if(new TextEncoder().encode(oldPayload).length>1800000)throw problem('目前資料超過安全快照上限，已停止還原',413);
  statements.push(env.DB.prepare('INSERT INTO transaction_assertions(id,ok) VALUES(?,CASE WHEN COALESCE((SELECT generation FROM workspace_state WHERE workspace_id=?),0)=? THEN 1 ELSE 0 END)').bind(guard,ws,body.expectedGeneration));
  statements.push(env.DB.prepare('INSERT INTO restore_history(id,workspace_id,created_by,created_at,payload) VALUES(?,?,?,?,?)').bind(historyId,ws,user.sub,now,oldPayload));
  for(const kind of ['events','notes']){
    const fields=tables[kind],oldCreator=`COALESCE((SELECT user_sub FROM ${kind} WHERE workspace_id=? AND id=json_extract(j.value,'$.id')),?)`;
    statements.push(env.DB.prepare(`UPDATE ${kind} SET deleted_at=?,updated_at=?,revision=revision+1 WHERE workspace_id=? AND deleted_at IS NULL`).bind(now,now,ws));
    const select=fields.map(k=>['attachment_meta','tags','reminder_minutes'].includes(k)?`json_extract(j.value,'$.${k}')`:`json_extract(j.value,'$.${k}')`).join(',');
    statements.push(env.DB.prepare(`INSERT INTO ${kind}(id,user_sub,workspace_id,${fields.join(',')},revision,created_at,updated_at,deleted_at) SELECT json_extract(j.value,'$.id'),${oldCreator},?,${select},json_extract(j.value,'$.revision'),json_extract(j.value,'$.created_at'),?,NULL FROM json_each(?) j WHERE true ON CONFLICT(workspace_id,id) DO UPDATE SET ${fields.map(k=>k+'=excluded.'+k).join(',')},revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=NULL`).bind(ws,user.sub,ws,now,JSON.stringify(prepared[kind])));
  }
  statements.push(env.DB.prepare('UPDATE reminders SET cancelled=1,updated_at=? WHERE workspace_id=? AND sent_at IS NULL').bind(now,ws));
  const tz=validTimezone(data.timezone||'')?data.timezone:access.timezone;
  const rows=[...prepared.events.flatMap(e=>remindersFor('events',e,user.sub,ws,tz)),...prepared.notes.flatMap(n=>remindersFor('notes',n,user.sub,ws,tz))];
  for(let offset=0;offset<rows.length;offset+=500)statements.push(env.DB.prepare(`INSERT INTO reminders(id,user_sub,workspace_id,source_type,source_id,title,body,trigger_at,offset_minutes,created_at,updated_at,cancelled,sent_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.user_sub'),json_extract(value,'$.workspace_id'),json_extract(value,'$.source_type'),json_extract(value,'$.source_id'),json_extract(value,'$.title'),json_extract(value,'$.body'),json_extract(value,'$.trigger_at'),json_extract(value,'$.offset_minutes'),?,?,0,NULL FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,cancelled=0,updated_at=excluded.updated_at`).bind(now,now,JSON.stringify(rows.slice(offset,offset+500))));
  statements.push(env.DB.prepare('UPDATE workspaces SET timezone=?,updated_at=? WHERE workspace_id=?').bind(tz,now,ws));
  if(Array.isArray(data.settings?.categories))statements.push(env.DB.prepare('INSERT INTO workspace_preferences(workspace_id,categories) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET categories=excluded.categories').bind(ws,JSON.stringify([...new Set(data.settings.categories.map(x=>String(x).slice(0,40)))].slice(0,100))));
  statements.push(env.DB.prepare('DELETE FROM reminder_rebuild_jobs WHERE workspace_id=?').bind(ws));
  statements.push(env.DB.prepare('DELETE FROM transaction_assertions WHERE id=?').bind(guard));
  try{await env.DB.batch(statements)}catch(e){if(String(e.message).includes('CHECK constraint'))throw problem('RESTORE_CONFLICT',409);throw e;}
  return {ok:true,historyId,...await snapshot(env,{...access,timezone:tz})};
}
function allowedEndpoint(endpoint){try{const u=new URL(endpoint);return u.protocol==='https:'&&(u.hostname==='fcm.googleapis.com'||u.hostname.endsWith('.push.services.mozilla.com')||u.hostname==='updates.push.services.mozilla.com'||u.hostname.endsWith('.push.apple.com'))}catch{return false}}
async function pushOutcome(env,row,payload){
  if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY||!env.VAPID_SUBJECT)return {status:'retry',error:'VAPID 尚未設定'};
  try{const accepted=await sendPushNotification({endpoint:row.endpoint,expirationTime:null,keys:{p256dh:row.p256dh,auth:row.auth}},payload,{subject:env.VAPID_SUBJECT,publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY},{ttl:3600,urgency:'high'});return accepted?{status:'accepted'}:{status:'gone',error:'訂閱已失效'};}
  catch(e){return e instanceof WebPushError&&[404,410].includes(e.statusCode)?{status:'gone',error:'訂閱已失效'}:{status:'retry',error:`推播服務暫時失敗 ${e.statusCode||''}`};}
}
async function subscribe(request,env,user){const b=await safeJson(request),sub=b.subscription;if(!sub?.keys?.p256dh||!sub?.keys?.auth||!allowedEndpoint(sub.endpoint))throw problem('INVALID_SUBSCRIPTION');const now=new Date().toISOString();await env.DB.prepare(`INSERT INTO push_subscriptions(endpoint,user_sub,p256dh,auth,device_name,created_at,updated_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_sub=excluded.user_sub,p256dh=excluded.p256dh,auth=excluded.auth,device_name=excluded.device_name,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`).bind(sub.endpoint,user.sub,sub.keys.p256dh,sub.keys.auth,String(b.device_name||'').slice(0,180),now,now,now).run();return {ok:true};}
async function testPush(request,env,user){const b=await safeJson(request);const rows=await env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_sub=? AND endpoint=?').bind(user.sub,String(b.endpoint||'')).all();let sent=0;const errors=[];for(const row of rows.results){const r=await pushOutcome(env,row,{title:'測試通知',body:'此裝置的提醒連線測試',url:'./',tag:'calendar-test'});if(r.status==='accepted')sent++;else errors.push(r.error)}return {ok:true,sent,errors};}
async function diagnostics(env,user,access){const [subscriptions,result]=await env.DB.batch([env.DB.prepare('SELECT device_name,last_seen_at FROM push_subscriptions WHERE user_sub=?').bind(user.sub),env.DB.prepare(`SELECT pd.status,COUNT(*) AS n FROM push_deliveries pd JOIN reminders r ON r.id=pd.reminder_id JOIN push_subscriptions ps ON ps.endpoint=pd.endpoint WHERE r.workspace_id=? AND ps.user_sub=? GROUP BY pd.status`).bind(access.workspace_id,user.sub)]);return {ok:true,configured:!!(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY&&env.VAPID_SUBJECT),devices:subscriptions.results,deliveries:result.results};}
async function rebuildPending(env){const jobs=await env.DB.prepare('SELECT * FROM reminder_rebuild_jobs LIMIT 3').all();for(const job of jobs.results){if(!tables[job.kind])continue;const rows=await env.DB.batch([env.DB.prepare(`SELECT * FROM ${job.kind} WHERE workspace_id=? AND id=?`).bind(job.workspace_id,job.item_id),env.DB.prepare('SELECT timezone FROM workspaces WHERE workspace_id=?').bind(job.workspace_id)]);const source=rows[0].results[0];if(source)await env.DB.batch(reminderStatements(env.DB,job.kind,convert(job.kind,source),source.user_sub,{workspace_id:job.workspace_id,timezone:rows[1].results[0]?.timezone||'Asia/Taipei'}));else await env.DB.prepare('DELETE FROM reminder_rebuild_jobs WHERE workspace_id=? AND kind=? AND item_id=?').bind(job.workspace_id,job.kind,job.item_id).run();}}
async function processDueReminders(env){
  await rebuildPending(env);const now=new Date().toISOString();
  const due=await env.DB.prepare(`SELECT r.*,w.timezone,e.start_at AS source_start,e.repeat_rule,e.completed AS event_completed,e.deleted_at AS event_deleted,n.completed AS note_completed,n.deleted_at AS note_deleted,COALESCE(e.id,n.id) AS live_source_id FROM reminders r JOIN workspaces w ON w.workspace_id=r.workspace_id LEFT JOIN events e ON r.source_type='event' AND e.workspace_id=r.workspace_id AND e.id=r.source_id LEFT JOIN notes n ON r.source_type='note' AND n.workspace_id=r.workspace_id AND n.id=r.source_id WHERE r.cancelled=0 AND r.sent_at IS NULL AND r.trigger_at<=? AND EXISTS(SELECT 1 FROM push_subscriptions ps JOIN workspace_members wm ON wm.user_sub=ps.user_sub WHERE wm.workspace_id=r.workspace_id AND wm.status='active') ORDER BY r.trigger_at LIMIT 2`).bind(now).all();
  let budget=4;
  for(const reminder of due.results){
    const lease=new Date(Date.now()+120000).toISOString();
    const claim=await env.DB.prepare('INSERT INTO reminder_jobs(reminder_id,lease_until) VALUES(?,?) ON CONFLICT(reminder_id) DO UPDATE SET lease_until=excluded.lease_until WHERE reminder_jobs.lease_until<?').bind(reminder.id,lease,now).run();if(!claim.meta.changes)continue;
    try{
      if(!reminder.live_source_id||reminder.event_completed||reminder.note_completed||reminder.event_deleted||reminder.note_deleted){await env.DB.prepare('UPDATE reminders SET cancelled=1,updated_at=? WHERE id=?').bind(now,reminder.id).run();continue;}
      if(reminder.source_type==='event'&&reminder.repeat_rule)await scheduleNextReminder(env,reminder);
      const rows=await env.DB.prepare(`SELECT ps.*,pd.status AS delivery_status,pd.attempts,pd.next_retry_at,pd.lease_until FROM push_subscriptions ps JOIN workspace_members wm ON wm.user_sub=ps.user_sub LEFT JOIN push_deliveries pd ON pd.endpoint=ps.endpoint AND pd.reminder_id=? WHERE wm.workspace_id=? AND wm.status='active'`).bind(reminder.id,reminder.workspace_id).all();
      const meta=parseJson(reminder.body,null);const occurrence=new Date(Date.parse(reminder.trigger_at)+Number(reminder.offset_minutes||0)*60000);const date=new Intl.DateTimeFormat('zh-TW',{timeZone:reminder.timezone||'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(occurrence);
      const payload={title:reminder.title,body:truncate(`${reminder.source_type==='event'?date+' · ':''}${meta?.text??reminder.body??''}`,180),url:`?open=${reminder.source_type}&id=${encodeURIComponent(reminder.source_id)}`,tag:`calendar-${reminder.id}`};
      for(const sub of rows.results){
        if(!budget)break;if(sub.delivery_status==='accepted'||sub.next_retry_at>now||sub.lease_until>now)continue;
        const lock=await env.DB.prepare(`INSERT INTO push_deliveries(reminder_id,endpoint,status,attempts,lease_until) VALUES(?,?,'sending',1,?) ON CONFLICT(reminder_id,endpoint) DO UPDATE SET status='sending',attempts=attempts+1,lease_until=excluded.lease_until WHERE push_deliveries.status<>'accepted' AND (push_deliveries.lease_until IS NULL OR push_deliveries.lease_until<?)`).bind(reminder.id,sub.endpoint,lease,now).run();if(!lock.meta.changes)continue;budget--;
        const outcome=await pushOutcome(env,sub,payload),accepted=outcome.status==='accepted';
        await env.DB.prepare('UPDATE push_deliveries SET status=?,lease_until=NULL,next_retry_at=?,last_error=?,accepted_at=? WHERE reminder_id=? AND endpoint=? AND lease_until=?').bind(outcome.status,accepted?null:new Date(Date.now()+Math.min(3600000,60000*2**Math.min(Number(sub.attempts||0),6))).toISOString(),outcome.error||null,accepted?new Date().toISOString():null,reminder.id,sub.endpoint,lease).run();
        if(outcome.status==='gone')await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(sub.endpoint).run();
      }
      const pending=await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions ps JOIN workspace_members wm ON wm.user_sub=ps.user_sub LEFT JOIN push_deliveries pd ON pd.endpoint=ps.endpoint AND pd.reminder_id=? WHERE wm.workspace_id=? AND wm.status='active' AND (pd.status IS NULL OR pd.status<>'accepted')`).bind(reminder.id,reminder.workspace_id).first();
      if(pending.n===0){const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM push_deliveries WHERE reminder_id=? AND status='accepted'").bind(reminder.id).first();if(count.n>0){await env.DB.prepare('UPDATE reminders SET sent_at=?,updated_at=? WHERE id=? AND cancelled=0').bind(now,now,reminder.id).run();}}
    }finally{await env.DB.prepare('DELETE FROM reminder_jobs WHERE reminder_id=? AND lease_until=?').bind(reminder.id,lease).run();}
  }
}
export default {
  async fetch(request,env){
    const url=new URL(request.url),cors=corsHeaders(request,env);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    try{
      const origin=request.headers.get('Origin');if(origin&&cors['Access-Control-Allow-Origin']==='null')throw problem('ORIGIN_DENIED',403);
      if(url.pathname==='/api/health')return json({ok:true,version:'V2.2.1',service:'calendar-notes-pwa-api'},200,cors);
      if(url.pathname==='/api/auth/config')return json({ok:true,persistent:persistentReady(env),automaticResume:persistentReady(env),idleDays:30,maxDays:180},200,cors);
      if(url.pathname==='/api/auth/code'&&request.method==='POST')return json(await exchangeCode(request,env),200,cors);
      if(url.pathname==='/api/auth/logout'&&request.method==='POST')return json(await endSession(request,env),200,cors);
      const user=await authenticate(request,env);await upsertUser(env.DB,user);
      if(url.pathname==='/api/auth/token')return json({ok:true,accessToken:user.token,expiresIn:user.expiresIn||300,profile:user.profile,persistent:!!user.persistent,sessionExpiresAt:user.sessionExpiresAt||0},200,cors);
      if(url.pathname==='/api/workspace/status')return workspaceStatus(env,user,cors);
      if(url.pathname==='/api/workspace/join'&&request.method==='POST')return joinWorkspace(request,env,user,cors);
      let access=await getWorkspaceAccess(env.DB,user.sub);if(!access)throw problem('WORKSPACE_REQUIRED',403);
      if(!access.last_verified_at||Date.now()-Date.parse(access.last_verified_at)>5*60000){await workspaceStatus(env,user,cors);access=await getWorkspaceAccess(env.DB,user.sub);if(!access)throw problem('DRIVE_ACCESS_REVOKED',403);}
      if(url.pathname==='/api/workspace/members')return workspaceMembers(env,access,cors);
      if(url.pathname==='/api/sync')return json(await snapshot(env,access,url.searchParams.get('since')),200,cors);
      if(url.pathname==='/api/snapshot')return json(await snapshot(env,access),200,cors);
      if(url.pathname==='/api/restore'&&request.method==='POST')return json(await restore(request,env,user,access),200,cors);
      if(url.pathname==='/api/settings'&&request.method==='PUT')return json(await putSettings(request,env,user,access),200,cors);
      if(url.pathname==='/api/restore/history')return json({ok:true,history:(await env.DB.prepare('SELECT id,created_at FROM restore_history WHERE workspace_id=? ORDER BY created_at DESC LIMIT 10').bind(access.workspace_id).all()).results},200,cors);
      if(url.pathname.startsWith('/api/restore/history/')){const r=await env.DB.prepare('SELECT payload FROM restore_history WHERE workspace_id=? AND id=?').bind(access.workspace_id,url.pathname.split('/').pop()).first();if(!r)throw problem('NOT_FOUND',404);return json(JSON.parse(r.payload),200,cors);}
      const match=url.pathname.match(/^\/api\/(events|notes)\/([^/]+)$/);if(match&&['PUT','DELETE'].includes(request.method)){const r=await mutate(request,env,user,access,match[1],decodeURIComponent(match[2]));return r.conflict?json({ok:false,error:'REVISION_CONFLICT',server:r.server},409,cors):json(r,200,cors);}
      if(url.pathname==='/api/push/subscribe'&&request.method==='POST')return json(await subscribe(request,env,user),200,cors);
      if(url.pathname==='/api/push/unsubscribe'&&request.method==='POST'){const b=await safeJson(request);await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_sub=? AND endpoint=?').bind(user.sub,String(b.endpoint||'')).run();return json({ok:true},200,cors);}
      if(url.pathname==='/api/push/test'&&request.method==='POST')return json(await testPush(request,env,user),200,cors);
      if(url.pathname==='/api/push/diagnostics')return json(await diagnostics(env,user,access),200,cors);
      throw problem('NOT_FOUND',404);
    }catch(e){console.error('request failed',e.status||500,e.message);return json({ok:false,error:e.status?e.message:'SERVER_ERROR'},e.status||500,cors);}
  },
  async scheduled(controller,env,ctx){ctx.waitUntil(processDueReminders(env));}
};

async function scheduleNextReminder(env,r){
 const trigger=nextTrigger({start_at:r.source_start,repeat_rule:r.repeat_rule},Number(r.offset_minutes||0),new Date(),r.timezone||'Asia/Taipei');if(!trigger)return;
 const now=new Date().toISOString(),id=`event:${r.workspace_id}:${r.source_id}:${r.offset_minutes}:${trigger.toISOString()}`;
 await env.DB.prepare(`INSERT OR IGNORE INTO reminders(id,user_sub,workspace_id,source_type,source_id,title,body,trigger_at,offset_minutes,created_at,updated_at,cancelled,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,NULL)`).bind(id,r.user_sub,r.workspace_id,r.source_type,r.source_id,r.title,r.body,trigger.toISOString(),r.offset_minutes,now,now).run();
}

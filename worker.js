import { sendPushNotification, WebPushError } from '@mmmike/web-push/send';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, service: 'calendar-notes-pwa-api', now: new Date().toISOString() }, 200, cors);
      }

      if (url.pathname === '/api/config' && request.method === 'GET') {
        return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY || '' }, 200, cors);
      }

      const user = await authenticate(request);
      if (!user) return json({ ok: false, error: 'UNAUTHORIZED' }, 401, cors);
      await upsertUser(env.DB, user);

      // 共享工作區加入 / 狀態查詢：尚未加入工作區的使用者也可以呼叫。
      if (url.pathname === '/api/workspace/status' && request.method === 'GET') {
        return await workspaceStatus(env, user, cors);
      }
      if (url.pathname === '/api/workspace/join' && request.method === 'POST') {
        return await joinWorkspace(request, env, user, cors);
      }

      const access = await getWorkspaceAccess(env.DB, user.sub);
      if (!access) return json({ ok: false, error: 'WORKSPACE_REQUIRED' }, 403, cors);

      if (url.pathname === '/api/workspace/members' && request.method === 'GET') {
        return await workspaceMembers(env, access, cors);
      }
      if (url.pathname === '/api/sync' && request.method === 'GET') {
        return await handleSync(url, env, user, access, cors);
      }

      if (url.pathname === '/api/settings') {
        if (request.method === 'GET') return await getSettings(env, access, cors);
        if (request.method === 'PUT') return await putSettings(request, env, user, access, cors);
      }

      if (url.pathname.startsWith('/api/events/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        if (request.method === 'PUT') return await putEvent(request, env, user, access, id, cors);
        if (request.method === 'DELETE') return await deleteEvent(request, env, user, access, id, cors);
      }

      if (url.pathname.startsWith('/api/notes/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        if (request.method === 'PUT') return await putNote(request, env, user, access, id, cors);
        if (request.method === 'DELETE') return await deleteNote(request, env, user, access, id, cors);
      }

      if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
        return await subscribePush(request, env, user, access, cors);
      }
      if (url.pathname === '/api/push/unsubscribe' && request.method === 'POST') {
        return await unsubscribePush(request, env, user, cors);
      }
      if (url.pathname === '/api/push/test' && request.method === 'POST') {
        return await testPush(env, user, cors);
      }

      return json({ ok: false, error: 'NOT_FOUND' }, 404, cors);
    } catch (error) {
      console.error('fetch error', error);
      return json({ ok: false, error: 'SERVER_ERROR', message: error?.message || String(error) }, 500, cors);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processDueReminders(env));
  }
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || 'null');
  return {
    ...JSON_HEADERS,
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

async function authenticate(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const profile = await res.json();
  if (!profile.sub) return null;
  return {
    sub: profile.sub,
    email: profile.email || '',
    name: profile.name || profile.email || profile.sub,
    token
  };
}

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
           w.name AS workspace_name, w.drive_root_folder_id, w.timezone, w.owner_sub
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
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=${fields}&supportsAllDrives=true`, {headers:{Authorization:`Bearer ${token}`}});
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

async function handleSync(url, env, user, access, cors) {
  const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
  const [eventsResult, notesResult] = await Promise.all([
    env.DB.prepare(`SELECT * FROM events WHERE workspace_id=? AND updated_at>? ORDER BY updated_at`).bind(access.workspace_id, since).all(),
    env.DB.prepare(`SELECT * FROM notes WHERE workspace_id=? AND updated_at>? ORDER BY updated_at`).bind(access.workspace_id, since).all()
  ]);
  return json({
    ok:true,
    serverTime:new Date().toISOString(),
    events:(eventsResult.results||[]).map(dbEventToJson),
    notes:(notesResult.results||[]).map(dbNoteToJson),
    settings:{drive_root_folder_id:access.drive_root_folder_id||'',timezone:access.timezone||'Asia/Taipei'},
    workspace:workspaceJson(access)
  },200,cors);
}

async function getSettings(env, access, cors) {
  return json({ok:true,settings:{drive_root_folder_id:access.drive_root_folder_id||'',timezone:access.timezone||'Asia/Taipei'},workspace:workspaceJson(access)},200,cors);
}

async function putSettings(request, env, user, access, cors) {
  if (!canWrite(access)) return json({ok:false,error:'READ_ONLY_MEMBER'},403,cors);
  const body=await safeJson(request);
  const driveRoot=String(body.drive_root_folder_id||access.drive_root_folder_id||'').trim();
  const timezone=String(body.timezone||access.timezone||'Asia/Taipei').trim();
  if (driveRoot && access.drive_root_folder_id && driveRoot!==access.drive_root_folder_id) return json({ok:false,error:'WORKSPACE_FOLDER_MISMATCH'},409,cors);
  const now=new Date().toISOString();
  await env.DB.prepare(`UPDATE workspaces SET timezone=?,updated_at=? WHERE workspace_id=?`).bind(timezone,now,access.workspace_id).run();
  await env.DB.prepare(`INSERT INTO user_settings (user_sub,drive_root_folder_id,timezone,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_sub) DO UPDATE SET drive_root_folder_id=excluded.drive_root_folder_id,timezone=excluded.timezone,updated_at=excluded.updated_at`)
    .bind(user.sub,access.drive_root_folder_id||driveRoot,timezone,now).run();
  return json({ok:true,settings:{drive_root_folder_id:access.drive_root_folder_id||driveRoot,timezone,updated_at:now}},200,cors);
}

async function putEvent(request, env, user, access, id, cors) {
  if (!canWrite(access)) return json({ok:false,error:'READ_ONLY_MEMBER'},403,cors);
  const body=await safeJson(request); validateId(id);
  if(!body.title||!body.start_at) return json({ok:false,error:'TITLE_AND_START_REQUIRED'},400,cors);
  const existing=await env.DB.prepare(`SELECT * FROM events WHERE workspace_id=? AND id=?`).bind(access.workspace_id,id).first();
  const baseRevision=Number(body.base_revision||0);
  if(existing&&baseRevision!==Number(existing.revision)) return json({ok:false,error:'REVISION_CONFLICT',server:dbEventToJson(existing)},409,cors);
  const now=new Date().toISOString(); const revision=existing?Number(existing.revision)+1:1; const createdAt=existing?.created_at||body.created_at||now;
  if(existing){
    await env.DB.prepare(`UPDATE events SET title=?,description=?,location=?,start_at=?,end_at=?,all_day=?,category=?,color=?,completed=?,repeat_rule=?,reminder_minutes=?,attachment_meta=?,revision=?,updated_at=?,deleted_at=NULL WHERE workspace_id=? AND id=?`).bind(
      String(body.title).trim(),String(body.description||''),String(body.location||''),body.start_at,body.end_at||null,body.all_day?1:0,String(body.category||''),String(body.color||''),body.completed?1:0,String(body.repeat_rule||''),JSON.stringify(normalizeMinutes(body.reminder_minutes)),JSON.stringify(Array.isArray(body.attachment_meta)?body.attachment_meta:[]),revision,now,access.workspace_id,id
    ).run();
  }else{
    await env.DB.prepare(`INSERT INTO events (id,user_sub,workspace_id,title,description,location,start_at,end_at,all_day,category,color,completed,repeat_rule,reminder_minutes,attachment_meta,revision,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).bind(
      id,user.sub,access.workspace_id,String(body.title).trim(),String(body.description||''),String(body.location||''),body.start_at,body.end_at||null,body.all_day?1:0,String(body.category||''),String(body.color||''),body.completed?1:0,String(body.repeat_rule||''),JSON.stringify(normalizeMinutes(body.reminder_minutes)),JSON.stringify(Array.isArray(body.attachment_meta)?body.attachment_meta:[]),revision,createdAt,now
    ).run();
  }
  const saved=await env.DB.prepare(`SELECT * FROM events WHERE workspace_id=? AND id=?`).bind(access.workspace_id,id).first();
  await rebuildEventReminders(env.DB,access.workspace_id,saved.user_sub,saved);
  return json({ok:true,item:dbEventToJson(saved)},200,cors);
}

async function deleteEvent(request, env, user, access, id, cors) {
  if (!canWrite(access)) return json({ok:false,error:'READ_ONLY_MEMBER'},403,cors);
  validateId(id); const existing=await env.DB.prepare(`SELECT * FROM events WHERE workspace_id=? AND id=?`).bind(access.workspace_id,id).first();
  if(!existing) return json({ok:true},200,cors);
  const body=await safeJson(request); if(Number(body.base_revision||0)!==Number(existing.revision)) return json({ok:false,error:'REVISION_CONFLICT',server:dbEventToJson(existing)},409,cors);
  const now=new Date().toISOString();
  await env.DB.prepare(`UPDATE events SET deleted_at=?,updated_at=?,revision=revision+1 WHERE workspace_id=? AND id=?`).bind(now,now,access.workspace_id,id).run();
  await env.DB.prepare(`UPDATE reminders SET cancelled=1,updated_at=? WHERE workspace_id=? AND source_type='event' AND source_id=? AND sent_at IS NULL`).bind(now,access.workspace_id,id).run();
  const saved=await env.DB.prepare(`SELECT * FROM events WHERE workspace_id=? AND id=?`).bind(access.workspace_id,id).first();
  return json({ok:true,item:dbEventToJson(saved)},200,cors);
}

async function putNote(request, env, user, access, id, cors) {
  if (!canWrite(access)) return json({ok:false,error:'READ_ONLY_MEMBER'},403,cors);
  const body=await safeJson(request); validateId(id); if(!body.title) return json({ok:false,error:'TITLE_REQUIRED'},400,cors);
  const existing=await env.DB.prepare(`SELECT * FROM notes WHERE workspace_id=? AND id=?`).bind(access.workspace_id,id).first();
  const baseRevision=Number(body.base_revision||0); if(existing&&baseRevision!==Number(existing.revision)) return json({ok:false,error:'REVISION_CONFLICT',server:dbNoteToJson(existing)},409,cors);
  const now=new Date().toISOString(); const revision=existing?Number(existing.revision)+1:1; const createdAt=existing?.created_at||body.created_at||now;
  if(existing){
    await env.DB.prepare(`UPDATE notes SET title=?,content=?,category=?,tags=?,pinned=?,completed=?,reminder_at=?,attachment_meta=?,revision=?,updated_at=?,deleted_at=NULL WHERE workspace_id=? AND id=?`).bind(
      String(body.title).trim(),String(body.content||''),String(body.category||''),JSON.stringify(Array.isArray(body.tags)?body.tags:[]),body.pinned?1:0,body.completed?1:0,body.reminder_at||null,JSON.stringify(Array.isArray(body.attachment_meta)?body.attachment_meta:[]),revision,now,access.workspace_id,id
    ).run();
  }else{
    await env.DB.prepare(`INSERT INTO notes (id,user_sub,workspace_id,title,content,category,tags,pinned,completed,reminder_at,attachment_meta,revision,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).bind(
      id,user.sub,access.workspace_id,String(body.title).trim(),String(body.content||''),String(body.category||''),JSON.stringify(Array.isArray(body.tags)?body.tags:[]),body.pinned?1:0,body.completed?1:0,body.reminder_at||null,JSON.stringify(Array.isArray(body.attachment_meta)?body.attachment_meta:[]),revision,createdAt,now
    ).run();
  }
  const saved=await env.DB.prepare(`SELECT * FROM notes WHERE workspace_id=? AND id=?`).bind(access.workspace_id,id).first();
  await rebuildNoteReminder(env.DB,access.workspace_id,saved.user_sub,saved);
  return json({ok:true,item:dbNoteToJson(saved)},200,cors);
}

async function deleteNote(request, env, user, access, id, cors) {
  if (!canWrite(access)) return json({ok:false,error:'READ_ONLY_MEMBER'},403,cors);
  validateId(id); const existing=await env.DB.prepare(`SELECT * FROM notes WHERE workspace_id=? AND id=?`).bind(access.workspace_id,id).first();
  if(!existing) return json({ok:true},200,cors);
  const body=await safeJson(request); if(Number(body.base_revision||0)!==Number(existing.revision)) return json({ok:false,error:'REVISION_CONFLICT',server:dbNoteToJson(existing)},409,cors);
  const now=new Date().toISOString();
  await env.DB.prepare(`UPDATE notes SET deleted_at=?,updated_at=?,revision=revision+1 WHERE workspace_id=? AND id=?`).bind(now,now,access.workspace_id,id).run();
  await env.DB.prepare(`UPDATE reminders SET cancelled=1,updated_at=? WHERE workspace_id=? AND source_type='note' AND source_id=? AND sent_at IS NULL`).bind(now,access.workspace_id,id).run();
  const saved=await env.DB.prepare(`SELECT * FROM notes WHERE workspace_id=? AND id=?`).bind(access.workspace_id,id).first();
  return json({ok:true,item:dbNoteToJson(saved)},200,cors);
}

async function rebuildEventReminders(db, workspaceId, creatorSub, eventRow) {
  const now=new Date().toISOString();
  await db.prepare(`UPDATE reminders SET cancelled=1,updated_at=? WHERE workspace_id=? AND source_type='event' AND source_id=? AND sent_at IS NULL`).bind(now,workspaceId,eventRow.id).run();
  if(eventRow.deleted_at||eventRow.completed)return;
  const startMs=Date.parse(eventRow.start_at); if(!Number.isFinite(startMs))return;
  const minutes=normalizeMinutes(parseJson(eventRow.reminder_minutes,[]));
  for(const min of minutes){
    let trigger=new Date(startMs-min*60000);
    if(eventRow.repeat_rule&&trigger.getTime()<=Date.now()){const nextTrigger=nextRecurringTrigger(new Date(startMs),eventRow.repeat_rule,min,new Date());if(nextTrigger)trigger=nextTrigger;}
    if(trigger.getTime()<=Date.now()-60000)continue;
    const rid=`event:${workspaceId}:${eventRow.id}:${min}:${trigger.toISOString()}`;
    await db.prepare(`INSERT OR REPLACE INTO reminders (id,user_sub,workspace_id,source_type,source_id,title,body,trigger_at,offset_minutes,sent_at,cancelled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,0,?,?)`).bind(
      rid,creatorSub,workspaceId,'event',eventRow.id,eventRow.title,eventRow.location?`地點：${eventRow.location}`:(eventRow.description||''),trigger.toISOString(),min,now,now
    ).run();
  }
}

async function rebuildNoteReminder(db, workspaceId, creatorSub, noteRow) {
  const now=new Date().toISOString();
  await db.prepare(`UPDATE reminders SET cancelled=1,updated_at=? WHERE workspace_id=? AND source_type='note' AND source_id=? AND sent_at IS NULL`).bind(now,workspaceId,noteRow.id).run();
  if(noteRow.deleted_at||noteRow.completed||!noteRow.reminder_at)return;
  const t=new Date(noteRow.reminder_at); if(!Number.isFinite(t.getTime())||t.getTime()<=Date.now()-60000)return;
  const rid=`note:${workspaceId}:${noteRow.id}:${t.toISOString()}`;
  await db.prepare(`INSERT OR REPLACE INTO reminders (id,user_sub,workspace_id,source_type,source_id,title,body,trigger_at,offset_minutes,sent_at,cancelled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,0,?,?)`).bind(
    rid,creatorSub,workspaceId,'note',noteRow.id,noteRow.title,truncate(noteRow.content,160),t.toISOString(),0,now,now
  ).run();
}

async function subscribePush(request, env, user, access, cors) {
  const body=await safeJson(request); const sub=body.subscription;
  if(!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth)return json({ok:false,error:'INVALID_SUBSCRIPTION'},400,cors);
  if(!isAllowedPushEndpoint(sub.endpoint))return json({ok:false,error:'UNSUPPORTED_PUSH_ENDPOINT'},400,cors);
  const now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO push_subscriptions (endpoint,user_sub,p256dh,auth,device_name,created_at,updated_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_sub=excluded.user_sub,p256dh=excluded.p256dh,auth=excluded.auth,device_name=excluded.device_name,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`).bind(sub.endpoint,user.sub,sub.keys.p256dh,sub.keys.auth,String(body.device_name||''),now,now,now).run();
  return json({ok:true,workspace:workspaceJson(access)},200,cors);
}

async function unsubscribePush(request, env, user, cors) {
  const body=await safeJson(request); const endpoint=String(body.endpoint||''); if(endpoint)await env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_sub=? AND endpoint=?`).bind(user.sub,endpoint).run(); return json({ok:true},200,cors);
}

async function testPush(env, user, cors) {
  const rows=await env.DB.prepare(`SELECT * FROM push_subscriptions WHERE user_sub=?`).bind(user.sub).all(); let sent=0;
  for(const row of rows.results||[]){const ok=await sendPush(env,row,{title:'測試通知成功',body:'Cloudflare Web Push 已正常連線。',url:'/',tag:'test-push'});if(ok)sent++;}
  return json({ok:true,sent},200,cors);
}

async function processDueReminders(env) {
  const now=new Date().toISOString();
  const due=await env.DB.prepare(`SELECT * FROM reminders WHERE cancelled=0 AND sent_at IS NULL AND trigger_at<=? ORDER BY trigger_at ASC LIMIT 100`).bind(now).all();
  for(const reminder of due.results||[]){
    const subs=await env.DB.prepare(`SELECT ps.* FROM push_subscriptions ps JOIN workspace_members wm ON wm.user_sub=ps.user_sub WHERE wm.workspace_id=? AND wm.status='active'`).bind(reminder.workspace_id||SHARED_WORKSPACE_ID).all();
    const notification=await buildReminderNotification(env,reminder);
    for(const sub of subs.results||[]) await sendPush(env,sub,notification);
    const sentAt=new Date().toISOString(); await env.DB.prepare(`UPDATE reminders SET sent_at=?,updated_at=? WHERE id=?`).bind(sentAt,sentAt,reminder.id).run();
    if(reminder.source_type==='event'){
      const ev=await env.DB.prepare(`SELECT * FROM events WHERE workspace_id=? AND id=?`).bind(reminder.workspace_id||SHARED_WORKSPACE_ID,reminder.source_id).first();
      if(ev&&!ev.deleted_at&&!ev.completed&&ev.repeat_rule){
        const trigger=nextRecurringTrigger(new Date(ev.start_at),ev.repeat_rule,Number(reminder.offset_minutes||0),new Date());
        if(trigger){
          const ws=reminder.workspace_id||SHARED_WORKSPACE_ID; const rid=`event:${ws}:${ev.id}:${Number(reminder.offset_minutes||0)}:${trigger.toISOString()}`;
          await env.DB.prepare(`INSERT OR IGNORE INTO reminders (id,user_sub,workspace_id,source_type,source_id,title,body,trigger_at,offset_minutes,sent_at,cancelled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,0,?,?)`).bind(
            rid,ev.user_sub,ws,'event',ev.id,ev.title,ev.location?`地點：${ev.location}`:(ev.description||''),trigger.toISOString(),Number(reminder.offset_minutes||0),sentAt,sentAt
          ).run();
        }
      }
    }
  }
}

async function buildReminderNotification(env, reminder) {
  let title=String(reminder.title||'').trim(); let body=String(reminder.body||'').trim(); let source=null; const ws=reminder.workspace_id||SHARED_WORKSPACE_ID;
  if(reminder.source_type==='event'){
    source=await env.DB.prepare(`SELECT title,start_at,location,description FROM events WHERE workspace_id=? AND id=?`).bind(ws,reminder.source_id).first();
    if(source?.title)title=String(source.title).trim();
    if(source){const setting=await env.DB.prepare(`SELECT timezone FROM workspaces WHERE workspace_id=?`).bind(ws).first();const timezone=setting?.timezone||'Asia/Taipei';const parts=[];if(source.start_at)parts.push(`時間：${formatPushDateTime(source.start_at,timezone)}`);if(source.location)parts.push(`地點：${source.location}`);if(!source.location&&source.description)parts.push(truncate(source.description,120));body=parts.filter(Boolean).join(' · ')||body||'行程提醒';}
  }else if(reminder.source_type==='note'){
    source=await env.DB.prepare(`SELECT title,content FROM notes WHERE workspace_id=? AND id=?`).bind(ws,reminder.source_id).first(); if(source?.title)title=String(source.title).trim(); if(source?.content)body=truncate(source.content,150);
  }
  return {title:title||(reminder.source_type==='event'?'行程提醒':'備註提醒'),body:body||'提醒時間到了',url:`?open=${encodeURIComponent(reminder.source_type)}&id=${encodeURIComponent(reminder.source_id)}`,tag:`reminder-${reminder.source_type}-${reminder.source_id}`};
}

function formatPushDateTime(iso, timezone) {
  try {
    return new Intl.DateTimeFormat('zh-TW', { timeZone: timezone || 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(5,16).replace('T',' ');
  }
}

async function sendPush(env, row, payloadData) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    console.error('VAPID secrets are not configured');
    return false;
  }
  const subscription = {
    endpoint: row.endpoint,
    expirationTime: null,
    keys: { p256dh: row.p256dh, auth: row.auth }
  };
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
  try {
    const delivered = await sendPushNotification(subscription, payloadData, vapid, {
      ttl: 300,
      urgency: 'high'
    });
    if (!delivered) {
      await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).bind(row.endpoint).run();
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).bind(row.endpoint).run();
      return false;
    }
    console.error('Push exception', error?.statusCode || '', error?.message || String(error));
    return false;
  }
}

function isAllowedPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'fcm.googleapis.com' ||
      h.endsWith('.push.services.mozilla.com') ||
      h.endsWith('.push.apple.com');
  } catch {
    return false;
  }
}

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

function nextRecurringTrigger(start, rule, offsetMinutes, after) {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return null;
  let occurrence = new Date(start.getTime());
  const offsetMs = Number(offsetMinutes || 0) * 60000;
  for (let i = 0; i < 5000; i++) {
    const trigger = new Date(occurrence.getTime() - offsetMs);
    if (trigger.getTime() > after.getTime()) return trigger;
    const next = advanceOccurrence(occurrence, rule);
    if (!next) return null;
    occurrence = next;
  }
  return null;
}

function advanceOccurrence(date, rule) {
  const d = new Date(date.getTime());
  if (rule === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (rule === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (rule === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (rule === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else return null;
  return d;
}

function normalizeMinutes(value) {
  const arr = Array.isArray(value) ? value : [];
  return [...new Set(arr.map(Number).filter(v => Number.isFinite(v) && v >= 0 && v <= 525600))].sort((a, b) => a - b);
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

async function safeJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function validateId(id) {
  if (!/^[A-Za-z0-9._:-]{1,180}$/.test(id)) throw new Error('Invalid ID');
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

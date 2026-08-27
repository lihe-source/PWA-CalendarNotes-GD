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

      if (url.pathname === '/api/sync' && request.method === 'GET') {
        return await handleSync(url, env, user, cors);
      }

      if (url.pathname === '/api/settings') {
        if (request.method === 'GET') return await getSettings(env, user, cors);
        if (request.method === 'PUT') return await putSettings(request, env, user, cors);
      }

      if (url.pathname.startsWith('/api/events/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        if (request.method === 'PUT') return await putEvent(request, env, user, id, cors);
        if (request.method === 'DELETE') return await deleteEvent(request, env, user, id, cors);
      }

      if (url.pathname.startsWith('/api/notes/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        if (request.method === 'PUT') return await putNote(request, env, user, id, cors);
        if (request.method === 'DELETE') return await deleteNote(request, env, user, id, cors);
      }

      if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
        return await subscribePush(request, env, user, cors);
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
    name: profile.name || profile.email || profile.sub
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

async function handleSync(url, env, user, cors) {
  const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
  const [eventsResult, notesResult, settings] = await Promise.all([
    env.DB.prepare(`SELECT * FROM events WHERE user_sub=? AND updated_at>? ORDER BY updated_at`).bind(user.sub, since).all(),
    env.DB.prepare(`SELECT * FROM notes WHERE user_sub=? AND updated_at>? ORDER BY updated_at`).bind(user.sub, since).all(),
    env.DB.prepare(`SELECT * FROM user_settings WHERE user_sub=?`).bind(user.sub).first()
  ]);

  return json({
    ok: true,
    serverTime: new Date().toISOString(),
    events: (eventsResult.results || []).map(dbEventToJson),
    notes: (notesResult.results || []).map(dbNoteToJson),
    settings: settings || null
  }, 200, cors);
}

async function getSettings(env, user, cors) {
  const row = await env.DB.prepare(`SELECT * FROM user_settings WHERE user_sub=?`).bind(user.sub).first();
  return json({ ok: true, settings: row || { drive_root_folder_id: '', timezone: 'Asia/Taipei' } }, 200, cors);
}

async function putSettings(request, env, user, cors) {
  const body = await safeJson(request);
  const driveRoot = String(body.drive_root_folder_id || '').trim();
  const timezone = String(body.timezone || 'Asia/Taipei').trim();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO user_settings (user_sub, drive_root_folder_id, timezone, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_sub) DO UPDATE SET
      drive_root_folder_id=excluded.drive_root_folder_id,
      timezone=excluded.timezone,
      updated_at=excluded.updated_at
  `).bind(user.sub, driveRoot, timezone, now).run();
  return json({ ok: true, settings: { drive_root_folder_id: driveRoot, timezone, updated_at: now } }, 200, cors);
}

async function putEvent(request, env, user, id, cors) {
  const body = await safeJson(request);
  validateId(id);
  if (!body.title || !body.start_at) return json({ ok: false, error: 'TITLE_AND_START_REQUIRED' }, 400, cors);

  const existing = await env.DB.prepare(`SELECT * FROM events WHERE user_sub=? AND id=?`).bind(user.sub, id).first();
  const baseRevision = Number(body.base_revision || 0);
  if (existing && baseRevision !== Number(existing.revision)) {
    return json({ ok: false, error: 'REVISION_CONFLICT', server: dbEventToJson(existing) }, 409, cors);
  }

  const now = new Date().toISOString();
  const revision = existing ? Number(existing.revision) + 1 : 1;
  const createdAt = existing?.created_at || body.created_at || now;

  await env.DB.prepare(`
    INSERT INTO events (
      id,user_sub,title,description,location,start_at,end_at,all_day,category,color,completed,
      repeat_rule,reminder_minutes,attachment_meta,revision,created_at,updated_at,deleted_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(user_sub,id) DO UPDATE SET
      title=excluded.title, description=excluded.description, location=excluded.location,
      start_at=excluded.start_at, end_at=excluded.end_at, all_day=excluded.all_day,
      category=excluded.category, color=excluded.color, completed=excluded.completed,
      repeat_rule=excluded.repeat_rule, reminder_minutes=excluded.reminder_minutes,
      attachment_meta=excluded.attachment_meta, revision=excluded.revision,
      updated_at=excluded.updated_at, deleted_at=NULL
  `).bind(
    id, user.sub, String(body.title).trim(), String(body.description || ''), String(body.location || ''),
    body.start_at, body.end_at || null, body.all_day ? 1 : 0, String(body.category || ''), String(body.color || ''),
    body.completed ? 1 : 0, String(body.repeat_rule || ''), JSON.stringify(normalizeMinutes(body.reminder_minutes)),
    JSON.stringify(Array.isArray(body.attachment_meta) ? body.attachment_meta : []), revision, createdAt, now
  ).run();

  const saved = await env.DB.prepare(`SELECT * FROM events WHERE user_sub=? AND id=?`).bind(user.sub, id).first();
  await rebuildEventReminders(env.DB, user.sub, saved);
  return json({ ok: true, item: dbEventToJson(saved) }, 200, cors);
}

async function deleteEvent(request, env, user, id, cors) {
  validateId(id);
  const existing = await env.DB.prepare(`SELECT * FROM events WHERE user_sub=? AND id=?`).bind(user.sub, id).first();
  if (!existing) return json({ ok: true }, 200, cors);
  const body = await safeJson(request);
  const baseRevision = Number(body.base_revision || 0);
  if (baseRevision !== Number(existing.revision)) {
    return json({ ok: false, error: 'REVISION_CONFLICT', server: dbEventToJson(existing) }, 409, cors);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE events SET deleted_at=?, updated_at=?, revision=revision+1 WHERE user_sub=? AND id=?`)
    .bind(now, now, user.sub, id).run();
  await env.DB.prepare(`UPDATE reminders SET cancelled=1, updated_at=? WHERE user_sub=? AND source_type='event' AND source_id=? AND sent_at IS NULL`)
    .bind(now, user.sub, id).run();
  const saved = await env.DB.prepare(`SELECT * FROM events WHERE user_sub=? AND id=?`).bind(user.sub, id).first();
  return json({ ok: true, item: dbEventToJson(saved) }, 200, cors);
}

async function putNote(request, env, user, id, cors) {
  const body = await safeJson(request);
  validateId(id);
  if (!body.title) return json({ ok: false, error: 'TITLE_REQUIRED' }, 400, cors);

  const existing = await env.DB.prepare(`SELECT * FROM notes WHERE user_sub=? AND id=?`).bind(user.sub, id).first();
  const baseRevision = Number(body.base_revision || 0);
  if (existing && baseRevision !== Number(existing.revision)) {
    return json({ ok: false, error: 'REVISION_CONFLICT', server: dbNoteToJson(existing) }, 409, cors);
  }

  const now = new Date().toISOString();
  const revision = existing ? Number(existing.revision) + 1 : 1;
  const createdAt = existing?.created_at || body.created_at || now;

  await env.DB.prepare(`
    INSERT INTO notes (
      id,user_sub,title,content,category,tags,pinned,completed,reminder_at,attachment_meta,
      revision,created_at,updated_at,deleted_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(user_sub,id) DO UPDATE SET
      title=excluded.title, content=excluded.content, category=excluded.category, tags=excluded.tags,
      pinned=excluded.pinned, completed=excluded.completed, reminder_at=excluded.reminder_at,
      attachment_meta=excluded.attachment_meta, revision=excluded.revision,
      updated_at=excluded.updated_at, deleted_at=NULL
  `).bind(
    id, user.sub, String(body.title).trim(), String(body.content || ''), String(body.category || ''),
    JSON.stringify(Array.isArray(body.tags) ? body.tags : []), body.pinned ? 1 : 0, body.completed ? 1 : 0,
    body.reminder_at || null, JSON.stringify(Array.isArray(body.attachment_meta) ? body.attachment_meta : []),
    revision, createdAt, now
  ).run();

  const saved = await env.DB.prepare(`SELECT * FROM notes WHERE user_sub=? AND id=?`).bind(user.sub, id).first();
  await rebuildNoteReminder(env.DB, user.sub, saved);
  return json({ ok: true, item: dbNoteToJson(saved) }, 200, cors);
}

async function deleteNote(request, env, user, id, cors) {
  validateId(id);
  const existing = await env.DB.prepare(`SELECT * FROM notes WHERE user_sub=? AND id=?`).bind(user.sub, id).first();
  if (!existing) return json({ ok: true }, 200, cors);
  const body = await safeJson(request);
  const baseRevision = Number(body.base_revision || 0);
  if (baseRevision !== Number(existing.revision)) {
    return json({ ok: false, error: 'REVISION_CONFLICT', server: dbNoteToJson(existing) }, 409, cors);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE notes SET deleted_at=?, updated_at=?, revision=revision+1 WHERE user_sub=? AND id=?`)
    .bind(now, now, user.sub, id).run();
  await env.DB.prepare(`UPDATE reminders SET cancelled=1, updated_at=? WHERE user_sub=? AND source_type='note' AND source_id=? AND sent_at IS NULL`)
    .bind(now, user.sub, id).run();
  const saved = await env.DB.prepare(`SELECT * FROM notes WHERE user_sub=? AND id=?`).bind(user.sub, id).first();
  return json({ ok: true, item: dbNoteToJson(saved) }, 200, cors);
}

async function rebuildEventReminders(db, userSub, eventRow) {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE reminders SET cancelled=1, updated_at=? WHERE user_sub=? AND source_type='event' AND source_id=? AND sent_at IS NULL`)
    .bind(now, userSub, eventRow.id).run();
  if (eventRow.deleted_at || eventRow.completed) return;

  const startMs = Date.parse(eventRow.start_at);
  if (!Number.isFinite(startMs)) return;
  const minutes = normalizeMinutes(parseJson(eventRow.reminder_minutes, []));
  for (const min of minutes) {
    let trigger = new Date(startMs - min * 60000);
    if (eventRow.repeat_rule && trigger.getTime() <= Date.now()) {
      const nextTrigger = nextRecurringTrigger(new Date(startMs), eventRow.repeat_rule, min, new Date());
      if (nextTrigger) trigger = nextTrigger;
    }
    if (trigger.getTime() <= Date.now() - 60000) continue;
    const rid = `event:${userSub}:${eventRow.id}:${min}:${trigger.toISOString()}`;
    await db.prepare(`
      INSERT OR REPLACE INTO reminders
      (id,user_sub,source_type,source_id,title,body,trigger_at,offset_minutes,sent_at,cancelled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?)
    `).bind(
      rid, userSub, 'event', eventRow.id, eventRow.title,
      eventRow.location ? `地點：${eventRow.location}` : (eventRow.description || ''),
      trigger.toISOString(), min, now, now
    ).run();
  }
}

async function rebuildNoteReminder(db, userSub, noteRow) {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE reminders SET cancelled=1, updated_at=? WHERE user_sub=? AND source_type='note' AND source_id=? AND sent_at IS NULL`)
    .bind(now, userSub, noteRow.id).run();
  if (noteRow.deleted_at || noteRow.completed || !noteRow.reminder_at) return;
  const t = new Date(noteRow.reminder_at);
  if (!Number.isFinite(t.getTime()) || t.getTime() <= Date.now() - 60000) return;
  const rid = `note:${userSub}:${noteRow.id}:${t.toISOString()}`;
  await db.prepare(`
    INSERT OR REPLACE INTO reminders
    (id,user_sub,source_type,source_id,title,body,trigger_at,offset_minutes,sent_at,cancelled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?)
  `).bind(rid, userSub, 'note', noteRow.id, noteRow.title, truncate(noteRow.content, 160), t.toISOString(), 0, now, now).run();
}

async function subscribePush(request, env, user, cors) {
  const body = await safeJson(request);
  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return json({ ok: false, error: 'INVALID_SUBSCRIPTION' }, 400, cors);
  }
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    return json({ ok: false, error: 'UNSUPPORTED_PUSH_ENDPOINT' }, 400, cors);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO push_subscriptions (endpoint,user_sub,p256dh,auth,device_name,created_at,updated_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_sub=excluded.user_sub, p256dh=excluded.p256dh, auth=excluded.auth,
      device_name=excluded.device_name, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at
  `).bind(sub.endpoint, user.sub, sub.keys.p256dh, sub.keys.auth, String(body.device_name || ''), now, now, now).run();
  return json({ ok: true }, 200, cors);
}

async function unsubscribePush(request, env, user, cors) {
  const body = await safeJson(request);
  const endpoint = String(body.endpoint || '');
  if (endpoint) await env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_sub=? AND endpoint=?`).bind(user.sub, endpoint).run();
  return json({ ok: true }, 200, cors);
}

async function testPush(env, user, cors) {
  const rows = await env.DB.prepare(`SELECT * FROM push_subscriptions WHERE user_sub=?`).bind(user.sub).all();
  let sent = 0;
  for (const row of rows.results || []) {
    const ok = await sendPush(env, row, {
      title: '測試通知成功',
      body: 'Cloudflare Web Push 已正常連線。',
      url: '/',
      tag: 'test-push'
    });
    if (ok) sent++;
  }
  return json({ ok: true, sent }, 200, cors);
}

async function processDueReminders(env) {
  const now = new Date().toISOString();
  const due = await env.DB.prepare(`
    SELECT * FROM reminders
    WHERE cancelled=0 AND sent_at IS NULL AND trigger_at<=?
    ORDER BY trigger_at ASC
    LIMIT 100
  `).bind(now).all();

  for (const reminder of due.results || []) {
    const subs = await env.DB.prepare(`SELECT * FROM push_subscriptions WHERE user_sub=?`).bind(reminder.user_sub).all();
    let delivered = false;
    for (const sub of subs.results || []) {
      const ok = await sendPush(env, sub, {
        title: reminder.title || '提醒',
        body: reminder.body || (reminder.source_type === 'event' ? '行事曆提醒' : '備註提醒'),
        url: `?open=${encodeURIComponent(reminder.source_type)}&id=${encodeURIComponent(reminder.source_id)}`,
        tag: `reminder-${reminder.source_type}-${reminder.source_id}`
      });
      delivered = delivered || ok;
    }

    // 即使目前沒有訂閱，也標記本次 reminder 已處理；避免 cron 無限重試。
    const sentAt = new Date().toISOString();
    await env.DB.prepare(`UPDATE reminders SET sent_at=?, updated_at=? WHERE id=?`).bind(sentAt, sentAt, reminder.id).run();

    // 週期性事件：為相同 offset 建立下一次 reminder。
    if (reminder.source_type === 'event') {
      const ev = await env.DB.prepare(`SELECT * FROM events WHERE user_sub=? AND id=?`).bind(reminder.user_sub, reminder.source_id).first();
      if (ev && !ev.deleted_at && !ev.completed && ev.repeat_rule) {
        const trigger = nextRecurringTrigger(new Date(ev.start_at), ev.repeat_rule, Number(reminder.offset_minutes || 0), new Date());
        if (trigger) {
          const rid = `event:${reminder.user_sub}:${ev.id}:${Number(reminder.offset_minutes || 0)}:${trigger.toISOString()}`;
          await env.DB.prepare(`
            INSERT OR IGNORE INTO reminders
            (id,user_sub,source_type,source_id,title,body,trigger_at,offset_minutes,sent_at,cancelled,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?)
          `).bind(
            rid, reminder.user_sub, 'event', ev.id, ev.title,
            ev.location ? `地點：${ev.location}` : (ev.description || ''),
            trigger.toISOString(), Number(reminder.offset_minutes || 0), sentAt, sentAt
          ).run();
        }
      }
    }
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

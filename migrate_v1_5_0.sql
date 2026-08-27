-- CalendarNotesPWA V1.5.0 一次性升級腳本
-- 用於既有 V1.4.x D1。請只執行一次。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '共享行事曆',
  drive_root_folder_id TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
  owner_sub TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_sub TEXT NOT NULL,
  email TEXT DEFAULT '',
  name TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'editor',
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  PRIMARY KEY (workspace_id, user_sub)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_sub, status);

ALTER TABLE events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'shared-main';
ALTER TABLE notes ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'shared-main';
ALTER TABLE reminders ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'shared-main';

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_workspace_id ON events(workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_events_workspace_start ON events(workspace_id, start_at);
CREATE INDEX IF NOT EXISTS idx_events_workspace_updated ON events(workspace_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_workspace_id ON notes(workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_notes_workspace_updated ON notes(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_workspace_reminder ON notes(workspace_id, reminder_at);
CREATE INDEX IF NOT EXISTS idx_reminders_workspace_source ON reminders(workspace_id, source_type, source_id);

INSERT OR IGNORE INTO workspaces (
  workspace_id, name, drive_root_folder_id, timezone, owner_sub, created_at, updated_at
)
SELECT
  'shared-main',
  '共享行事曆',
  COALESCE((SELECT drive_root_folder_id FROM user_settings WHERE drive_root_folder_id<>'' ORDER BY updated_at DESC LIMIT 1), ''),
  COALESCE((SELECT timezone FROM user_settings ORDER BY updated_at DESC LIMIT 1), 'Asia/Taipei'),
  COALESCE((SELECT user_sub FROM user_settings WHERE drive_root_folder_id<>'' ORDER BY updated_at DESC LIMIT 1), (SELECT user_sub FROM users ORDER BY created_at ASC LIMIT 1), ''),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now');

INSERT OR IGNORE INTO workspace_members (
  workspace_id, user_sub, email, name, role, status, joined_at, updated_at, last_verified_at
)
SELECT
  'shared-main', u.user_sub, COALESCE(u.email,''), COALESCE(u.name,''),
  CASE WHEN u.user_sub=(SELECT owner_sub FROM workspaces WHERE workspace_id='shared-main') THEN 'owner' ELSE 'editor' END,
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  NULL
FROM users u
LEFT JOIN user_settings s ON s.user_sub=u.user_sub
WHERE
  u.user_sub=(SELECT owner_sub FROM workspaces WHERE workspace_id='shared-main')
  OR (
    COALESCE((SELECT drive_root_folder_id FROM workspaces WHERE workspace_id='shared-main'),'')<>''
    AND COALESCE(s.drive_root_folder_id,'')=(SELECT drive_root_folder_id FROM workspaces WHERE workspace_id='shared-main')
  );

UPDATE events SET workspace_id='shared-main' WHERE workspace_id IS NULL OR workspace_id='';
UPDATE notes SET workspace_id='shared-main' WHERE workspace_id IS NULL OR workspace_id='';
UPDATE reminders SET workspace_id='shared-main' WHERE workspace_id IS NULL OR workspace_id='';

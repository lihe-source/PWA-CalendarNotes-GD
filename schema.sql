PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_sub TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS events (
  id TEXT NOT NULL,
  user_sub TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'shared-main',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  location TEXT DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  category TEXT DEFAULT '',
  color TEXT DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0,
  repeat_rule TEXT DEFAULT '',
  reminder_minutes TEXT DEFAULT '[]',
  attachment_meta TEXT DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_sub, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_workspace_id ON events(workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_events_workspace_start ON events(workspace_id, start_at);
CREATE INDEX IF NOT EXISTS idx_events_workspace_updated ON events(workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT NOT NULL,
  user_sub TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'shared-main',
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  category TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  reminder_at TEXT,
  attachment_meta TEXT DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_sub, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_workspace_id ON notes(workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_notes_workspace_updated ON notes(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_workspace_reminder ON notes(workspace_id, reminder_at);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'shared-main',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  trigger_at TEXT NOT NULL,
  offset_minutes INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(cancelled, sent_at, trigger_at);
CREATE INDEX IF NOT EXISTS idx_reminders_workspace_source ON reminders(workspace_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_name TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_sub);

-- 保留舊版相容；V1.5.0 起真正共享的 Drive root / timezone 以 workspaces 為主。
CREATE TABLE IF NOT EXISTS user_settings (
  user_sub TEXT PRIMARY KEY,
  drive_root_folder_id TEXT DEFAULT '',
  timezone TEXT DEFAULT 'Asia/Taipei',
  updated_at TEXT NOT NULL
);

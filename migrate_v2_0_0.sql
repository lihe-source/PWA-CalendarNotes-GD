-- Additive migration for existing V1.5+ databases; safe to run again.
CREATE TABLE IF NOT EXISTS change_log(change_id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,kind TEXT NOT NULL,item_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_change_log_workspace_cursor ON change_log(workspace_id,change_id);
CREATE TABLE IF NOT EXISTS workspace_state(workspace_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS transaction_assertions(id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE IF NOT EXISTS mutation_receipts(workspace_id TEXT NOT NULL,mutation_id TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(workspace_id,mutation_id));
CREATE TABLE IF NOT EXISTS restore_history(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_restore_history_workspace ON restore_history(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS push_deliveries(reminder_id TEXT NOT NULL,endpoint TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_retry_at TEXT,lease_until TEXT,last_error TEXT,accepted_at TEXT,PRIMARY KEY(reminder_id,endpoint));
CREATE TABLE IF NOT EXISTS reminder_jobs(reminder_id TEXT PRIMARY KEY,lease_until TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_sessions(token_hash TEXT PRIMARY KEY,user_sub TEXT NOT NULL,profile TEXT NOT NULL,access_cipher TEXT NOT NULL,refresh_cipher TEXT NOT NULL,access_expires INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(user_sub);
CREATE TABLE IF NOT EXISTS workspace_preferences(workspace_id TEXT PRIMARY KEY,categories TEXT NOT NULL DEFAULT '["工作","會議","生活"]');
CREATE TABLE IF NOT EXISTS reminder_rebuild_jobs(workspace_id TEXT NOT NULL,kind TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(workspace_id,kind,item_id));

CREATE TRIGGER IF NOT EXISTS trg_events_insert_v2 AFTER INSERT ON events
BEGIN
 INSERT INTO change_log(workspace_id,kind,item_id) VALUES(NEW.workspace_id,'events',NEW.id);
 INSERT INTO workspace_state(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1;
 INSERT INTO reminder_rebuild_jobs(workspace_id,kind,item_id) VALUES(NEW.workspace_id,'events',NEW.id) ON CONFLICT(workspace_id,kind,item_id) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS trg_events_update_v2 AFTER UPDATE ON events
BEGIN
 INSERT INTO change_log(workspace_id,kind,item_id) VALUES(NEW.workspace_id,'events',NEW.id);
 INSERT INTO workspace_state(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1;
 INSERT INTO reminder_rebuild_jobs(workspace_id,kind,item_id) VALUES(NEW.workspace_id,'events',NEW.id) ON CONFLICT(workspace_id,kind,item_id) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS trg_events_delete_v2 AFTER DELETE ON events
BEGIN
 INSERT INTO change_log(workspace_id,kind,item_id) VALUES(OLD.workspace_id,'events',OLD.id);
 INSERT INTO workspace_state(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1;
 INSERT INTO reminder_rebuild_jobs(workspace_id,kind,item_id) VALUES(OLD.workspace_id,'events',OLD.id) ON CONFLICT(workspace_id,kind,item_id) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_insert_v2 AFTER INSERT ON notes
BEGIN
 INSERT INTO change_log(workspace_id,kind,item_id) VALUES(NEW.workspace_id,'notes',NEW.id);
 INSERT INTO workspace_state(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1;
 INSERT INTO reminder_rebuild_jobs(workspace_id,kind,item_id) VALUES(NEW.workspace_id,'notes',NEW.id) ON CONFLICT(workspace_id,kind,item_id) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_update_v2 AFTER UPDATE ON notes
BEGIN
 INSERT INTO change_log(workspace_id,kind,item_id) VALUES(NEW.workspace_id,'notes',NEW.id);
 INSERT INTO workspace_state(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1;
 INSERT INTO reminder_rebuild_jobs(workspace_id,kind,item_id) VALUES(NEW.workspace_id,'notes',NEW.id) ON CONFLICT(workspace_id,kind,item_id) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_delete_v2 AFTER DELETE ON notes
BEGIN
 INSERT INTO change_log(workspace_id,kind,item_id) VALUES(OLD.workspace_id,'notes',OLD.id);
 INSERT INTO workspace_state(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1;
 INSERT INTO reminder_rebuild_jobs(workspace_id,kind,item_id) VALUES(OLD.workspace_id,'notes',OLD.id) ON CONFLICT(workspace_id,kind,item_id) DO NOTHING;
END;

-- Rebuild old recurrence schedules with the shared V2 rules.
INSERT OR IGNORE INTO reminder_rebuild_jobs(workspace_id,kind,item_id) SELECT workspace_id,'events',id FROM events WHERE deleted_at IS NULL;
INSERT OR IGNORE INTO reminder_rebuild_jobs(workspace_id,kind,item_id) SELECT workspace_id,'notes',id FROM notes WHERE deleted_at IS NULL;

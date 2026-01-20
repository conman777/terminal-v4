-- Initial schema for browser system storage
-- This migration creates tables for browser sessions, logs, and visual baselines

-- Browser sessions table
CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  current_url TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_browser_sessions_is_active ON browser_sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_last_activity ON browser_sessions(last_activity);

-- Logs table for storing all log entries
CREATE TABLE IF NOT EXISTS browser_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  port INTEGER,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  level TEXT,
  message TEXT,
  filename TEXT,
  lineno INTEGER,
  colno INTEGER,
  stack TEXT,
  method TEXT,
  url TEXT,
  status INTEGER,
  statusText TEXT,
  duration INTEGER,
  responsePreview TEXT,
  requestHeaders TEXT,
  responseHeaders TEXT,
  requestBody TEXT,
  responseBody TEXT,
  html TEXT,
  localStorage TEXT,
  sessionStorage TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES browser_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_browser_logs_session_id ON browser_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_browser_logs_port ON browser_logs(port);
CREATE INDEX IF NOT EXISTS idx_browser_logs_timestamp ON browser_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_browser_logs_type ON browser_logs(type);
CREATE INDEX IF NOT EXISTS idx_browser_logs_level ON browser_logs(level);
CREATE INDEX IF NOT EXISTS idx_browser_logs_created_at ON browser_logs(created_at);

-- Visual baselines table for screenshot regression testing
CREATE TABLE IF NOT EXISTS visual_baselines (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  url TEXT NOT NULL,
  selector TEXT,
  screenshot_data BLOB NOT NULL,
  screenshot_hash TEXT NOT NULL,
  viewport_width INTEGER NOT NULL,
  viewport_height INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT,
  FOREIGN KEY (session_id) REFERENCES browser_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_visual_baselines_session_id ON visual_baselines(session_id);
CREATE INDEX IF NOT EXISTS idx_visual_baselines_url ON visual_baselines(url);
CREATE INDEX IF NOT EXISTS idx_visual_baselines_hash ON visual_baselines(screenshot_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_visual_baselines_unique ON visual_baselines(session_id, url, selector);

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { config } from "./config.js";

export const db = new DatabaseSync(path.join(config.dataDir, "control-plane.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS tasks (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    request   TEXT NOT NULL,
    stage     TEXT NOT NULL,
    status    TEXT NOT NULL,
    branch    TEXT,
    model     TEXT,
    repo      TEXT,
    cost_usd  REAL NOT NULL DEFAULT 0,
    tokens    INTEGER NOT NULL DEFAULT 0,
    created   INTEGER NOT NULL,
    updated   INTEGER NOT NULL,
    meta      TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id  TEXT,
    ts       INTEGER NOT NULL,
    type     TEXT NOT NULL,
    data     TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS code_index (
    repo      TEXT NOT NULL,
    path      TEXT NOT NULL,
    summary   TEXT NOT NULL,
    symbols   TEXT NOT NULL DEFAULT '',
    updated   INTEGER NOT NULL,
    PRIMARY KEY (repo, path)
  );
`);

export type TaskRow = {
  id: string;
  title: string;
  request: string;
  stage: string;
  status: string;
  branch: string | null;
  model: string | null;
  repo: string | null;
  cost_usd: number;
  tokens: number;
  created: number;
  updated: number;
  meta: string;
};

export function now(): number {
  return Date.now();
}

/**
 * Token Stats Extension (v2)
 * --------------------------
 * Tracks token (and cost) usage across sessions and shows a GitHub-style daily
 * summary with the `/stats` command.
 *
 * Design notes (v2):
 *  - Append-only JSONL log (`<agent-dir>/token-stats/usage.jsonl`): one small
 *    record per counted session entry. O_APPEND writes keep concurrent pi
 *    processes from clobbering each other, there is no counted-id cap, and the
 *    log can be pruned/exported safely. Aggregates are recomputed from the log
 *    on demand, so a crash can never lose the whole history.
 *  - Per-session cursor (`cursors/<session-id>.json`): stores the last processed
 *    entry id so repeated settle events only scan the new tail of the session
 *    instead of the whole entry list.
 *  - Counting happens on `agent_settled` (the final boundary, after retries and
 *    automatic compaction), on `session_start`, and right before a `/stats`
 *    report, so the numbers are always current.
 *  - Legacy `stats.json` data is migrated into the log on first run.
 *
 * Commands:
 *   /stats              last 7 calendar days (missing days shown as zero)
 *   /stats 30           last 30 calendar days
 *   /stats today        only today
 *   /stats all          entire history
 *   /stats export [f]   CSV export (default: ./token-stats-YYYY-MM-DD.csv)
 *   /stats prune 180    delete records older than 180 days (keeps cursors)
 *   /stats reset        delete all recorded usage and cursors
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- constants --------------------------------------------------------------

const STORE_DIRNAME = "token-stats";
const USAGE_FILENAME = "usage.jsonl";
const LEGACY_STATS_FILENAME = "stats.json";
const LEGACY_BACKUP_SUFFIX = ".migrated.bak";
const CURSOR_DIRNAME = "cursors";
const RECORD_VERSION = 1;

const VERTICAL_BARS = "▁▂▃▄▅▆▇█";
const MAX_CHART_DAYS = 31; // daily bars up to this many days
const MAX_CHART_WEEKS = 78; // weekly bars up to this many weeks (546 days)
const MAX_RANGE_DAYS = 4000; // hard safety cap for "all"
const MAX_MODEL_ROWS = 10;
const MAX_PROJECT_ROWS = 5;

// ---- types ------------------------------------------------------------------

interface UsageRecord {
  v: number;
  t: "u";
  id: string;
  ts: string;
  session: string;
  cwd?: string;
  key: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  total: number;
  cost: number;
  /** True for aggregates migrated from the old stats.json. */
  legacy?: boolean;
}

interface RunRecord {
  v: number;
  t: "r";
  id: string;
  ts: string;
  session: string;
  cwd?: string;
}

type LogRecord = UsageRecord | RunRecord;

interface LoadedLog {
  usage: UsageRecord[];
  runs: RunRecord[];
  seen: Set<string>;
  legacy: boolean;
}

interface DayBucket {
  date: string;
  label: string;
  runs: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  tokens: number;
  cost: number;
}

interface ChartPoint {
  label: string;
  tokens: number;
  cost: number;
  isToday: boolean;
}

interface ModelRow {
  key: string;
  tokens: number;
  cost: number;
  requests: number;
  share: number;
}

interface ProjectRow {
  key: string;
  tokens: number;
  cost: number;
}

interface TodayRow {
  date: string;
  runs: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  tokens: number;
  cost: number;
  cacheHitRate: number;
}

interface ReportTotals {
  tokens: number;
  cost: number;
  runs: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cacheHitRate: number;
}

interface ReportData {
  generatedAt: string;
  range: { from: string; to: string; days: number };
  today: TodayRow | null;
  days: DayBucket[];
  chart: ChartPoint[];
  chartUnit: "day" | "week" | "month";
  models: ModelRow[];
  projects: ProjectRow[];
  totals: ReportTotals;
  legacy: boolean;
}

interface Cursor {
  lastId: string;
  count: number;
  updatedAt: string;
}

// ---- paths ------------------------------------------------------------------

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function storeDir(): string {
  return path.join(agentDir(), STORE_DIRNAME);
}

function usagePath(): string {
  return path.join(storeDir(), USAGE_FILENAME);
}

function legacyStatsPath(): string {
  return path.join(storeDir(), LEGACY_STATS_FILENAME);
}

function cursorDir(): string {
  return path.join(storeDir(), CURSOR_DIRNAME);
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

function cursorPath(sessionId: string): string {
  return path.join(cursorDir(), sanitizeId(sessionId) + ".json");
}

// ---- generic helpers --------------------------------------------------------

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function localDateKey(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  // Local noon avoids DST edge cases around midnight.
  const dt = new Date(y, m - 1, d + delta, 12, 0, 0, 0);
  return localDateKey(dt);
}

function daysBetween(from: string, to: string): number {
  const [ay, am, ad] = from.split("-").map(Number);
  const [by, bm, bd] = to.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard++ < MAX_RANGE_DAYS + 1) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

function isoAtLocalNoon(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).toISOString();
}

function weekStartKey(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  const dow = (dt.getDay() + 6) % 7; // Monday = 0
  dt.setDate(dt.getDate() - dow);
  return localDateKey(dt);
}

/** Collapse quantisation suffixes so the same model is not split in two rows. */
function normalizeModelKey(raw: string): string {
  return raw.replace(/:(?:I?Q\d[\w.-]*|F16|F32|BF16|FP16|INT[48]|MXFP[48](?:_[\w]+)*)$/i, "");
}

function cacheHitRate(input: number, cacheRead: number): number {
  const denom = input + cacheRead;
  return denom > 0 ? cacheRead / denom : 0;
}

// ---- formatting -------------------------------------------------------------

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, "");
}

function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return trimZeros((n / 1_000_000_000).toFixed(2)) + "B";
  if (abs >= 1_000_000) return trimZeros((n / 1_000_000).toFixed(2)) + "M";
  if (abs >= 10_000) return trimZeros((n / 1_000).toFixed(1)) + "K";
  if (abs >= 1_000) return trimZeros((n / 1_000).toFixed(2)) + "K";
  return String(Math.round(n));
}

function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const abs = Math.abs(n);
  if (abs < 0.01) return "$" + n.toFixed(4);
  if (abs < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

function fmtPct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

function padRight(s: string, width: number): string {
  const t = truncate(s, width);
  return t + " ".repeat(Math.max(0, width - Array.from(t).length));
}

function padLeft(s: string, width: number): string {
  const t = truncate(s, width);
  return " ".repeat(Math.max(0, width - Array.from(t).length)) + t;
}

function barFor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return VERTICAL_BARS[0];
  const idx = Math.max(
    0,
    Math.min(VERTICAL_BARS.length - 1, Math.round((value / max) * (VERTICAL_BARS.length - 1))),
  );
  return VERTICAL_BARS[idx];
}

// ---- storage: JSONL log -----------------------------------------------------

function appendRecords(records: LogRecord[]): void {
  if (records.length === 0) return;
  fs.mkdirSync(storeDir(), { recursive: true });
  const fd = fs.openSync(usagePath(), "a");
  try {
    for (const rec of records) {
      fs.writeSync(fd, JSON.stringify(rec) + "\n");
    }
  } finally {
    fs.closeSync(fd);
  }
}

function loadLog(): LoadedLog {
  const usage: UsageRecord[] = [];
  const runs: RunRecord[] = [];
  const seen = new Set<string>();
  let legacy = false;
  let content = "";
  try {
    content = fs.readFileSync(usagePath(), "utf-8");
  } catch {
    return { usage, runs, seen, legacy };
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Partial<LogRecord> & { t?: string };
    try {
      rec = JSON.parse(trimmed) as Partial<LogRecord> & { t?: string };
    } catch {
      continue; // ignore partial line after a crash
    }
    if (!rec || rec.v !== RECORD_VERSION || typeof rec.id !== "string" || seen.has(rec.id)) continue;
    seen.add(rec.id);
    if (rec.t === "r") {
      runs.push(rec as RunRecord);
    } else if (rec.t === "u") {
      const u = rec as UsageRecord;
      if (u.legacy) legacy = true;
      usage.push(u);
    }
  }
  return { usage, runs, seen, legacy };
}

function loadKnownIds(sessionId: string): Set<string> {
  const ids = new Set<string>();
  try {
    const content = fs.readFileSync(usagePath(), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as { id?: unknown; session?: unknown };
        if (rec && rec.session === sessionId && typeof rec.id === "string") ids.add(rec.id);
      } catch {
        // ignore malformed lines
      }
    }
  } catch {
    // no log yet
  }
  return ids;
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function pruneLog(keepDays: number): { kept: number; removed: number } {
  const cutoff = addDays(localDateKey(new Date()), -(keepDays - 1));
  let content = "";
  try {
    content = fs.readFileSync(usagePath(), "utf-8");
  } catch {
    return { kept: 0, removed: 0 };
  }
  const keptLines: string[] = [];
  let removed = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as { ts?: unknown };
      if (typeof rec.ts === "string" && localDateKey(rec.ts) >= cutoff) {
        keptLines.push(trimmed);
      } else {
        removed++;
      }
    } catch {
      removed++;
    }
  }
  atomicWrite(usagePath(), keptLines.length > 0 ? keptLines.join("\n") + "\n" : "");
  return { kept: keptLines.length, removed };
}

// ---- storage: migration from v1 --------------------------------------------

/**
 * Seed per-session cursors from the v1 `countedIds` list so that entries already
 * reflected in the migrated aggregates are not counted a second time when their
 * sessions are resumed. Sessions never seen by v1 get no cursor and are backfilled.
 */
function seedLegacyCursors(countedIds: Set<string>): void {
  if (countedIds.size === 0) return;
  const sessionsRoot = path.join(agentDir(), "sessions");
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(sessionsRoot, { recursive: true, encoding: "utf-8" })
      .filter((file) => file.endsWith(".jsonl"));
  } catch {
    return; // no sessions directory
  }

  for (const rel of files) {
    let content = "";
    try {
      content = fs.readFileSync(path.join(sessionsRoot, rel), "utf-8");
    } catch {
      continue;
    }
    let sessionId = "";
    let lastCountedId: string | null = null;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: { type?: unknown; id?: unknown };
      try {
        rec = JSON.parse(trimmed) as { type?: unknown; id?: unknown };
      } catch {
        continue;
      }
      if (!sessionId && rec?.type === "session" && typeof rec.id === "string") {
        sessionId = rec.id;
        continue;
      }
      if (typeof rec?.id === "string" && countedIds.has(rec.id)) lastCountedId = rec.id;
    }
    if (sessionId && lastCountedId && !loadCursor(sessionId)) {
      saveCursor(sessionId, { lastId: lastCountedId, count: 0, updatedAt: new Date().toISOString() });
    }
  }
}

function ensureMigrated(): void {
  try {
    if (fs.existsSync(usagePath())) return;
    const legacyPath = legacyStatsPath();
    if (!fs.existsSync(legacyPath)) return;

    const parsed = JSON.parse(fs.readFileSync(legacyPath, "utf-8")) as {
      days?: Record<string, { models?: Record<string, Record<string, unknown>> }>;
      countedIds?: unknown;
    };
    const countedIds = new Set<string>(
      Array.isArray(parsed.countedIds)
        ? (parsed.countedIds as unknown[]).filter((id): id is string => typeof id === "string")
        : [],
    );
    const records: UsageRecord[] = [];
    for (const [dateKey, day] of Object.entries(parsed.days ?? {})) {
      for (const [rawKey, rawModel] of Object.entries(day?.models ?? {})) {
        const input = num(rawModel.input);
        const output = num(rawModel.output);
        const cacheRead = num(rawModel.cacheRead);
        const cacheWrite = num(rawModel.cacheWrite);
        const total = num(rawModel.totalTokens, input + output + cacheRead + cacheWrite);
        const cost = num(rawModel.cost);
        if (total <= 0 && cost <= 0) continue;
        const key = normalizeModelKey(rawKey === "Tools/summaries" ? "Tools" : rawKey);
        records.push({
          v: RECORD_VERSION,
          t: "u",
          id: `legacy:${dateKey}:${key}`,
          ts: isoAtLocalNoon(dateKey),
          session: "legacy",
          key,
          input,
          output,
          cacheRead,
          cacheWrite,
          total,
          cost,
          legacy: true,
        });
      }
    }
    // Seed cursors before writing the log: if we crash after this, the next run
    // sees usage.jsonl and skips migration while cursors are already in place.
    seedLegacyCursors(countedIds);
    if (records.length > 0) appendRecords(records);
    fs.renameSync(legacyPath, legacyPath + LEGACY_BACKUP_SUFFIX);
  } catch {
    // Migration is best-effort: never break the agent because of old data.
  }
}

// ---- accounting -------------------------------------------------------------

function recordFromEntry(entry: SessionEntry, sessionId: string, cwd: string | undefined): UsageRecord | null {
  let key: string | undefined;
  let usage: Usage | undefined;

  if (entry.type === "message" && entry.message.role === "assistant") {
    const msg = entry.message;
    key = normalizeModelKey(`${msg.provider}/${msg.responseModel ?? msg.model ?? "unknown"}`);
    usage = msg.usage;
  } else if (entry.type === "usage") {
    key = normalizeModelKey(`${entry.provider}/${entry.model}`);
    usage = entry.usage;
  } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
    key = "Tools";
    usage = entry.message.usage;
  } else if (entry.type === "compaction" && entry.usage) {
    key = "Compaction";
    usage = entry.usage;
  } else if (entry.type === "branch_summary" && entry.usage) {
    key = "Branch summary";
    usage = entry.usage;
  }

  if (!key || !usage) return null;

  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  const total = num(usage.totalTokens, input + output + cacheRead + cacheWrite);
  const cost = num(usage.cost?.total);

  return {
    v: RECORD_VERSION,
    t: "u",
    id: entry.id,
    ts: entry.timestamp,
    session: sessionId,
    ...(cwd ? { cwd } : {}),
    key,
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(typeof usage.reasoning === "number" ? { reasoning: usage.reasoning } : {}),
    total,
    cost,
  };
}

function findEntryIndexFromEnd(entries: SessionEntry[], id: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].id === id) return i;
  }
  return -1;
}

function loadCursor(sessionId: string): Cursor | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath(sessionId), "utf-8")) as Partial<Cursor>;
    if (typeof parsed.lastId === "string" && parsed.lastId) {
      return { lastId: parsed.lastId, count: num(parsed.count), updatedAt: String(parsed.updatedAt ?? "") };
    }
  } catch {
    // no cursor yet
  }
  return null;
}

function saveCursor(sessionId: string, cursor: Cursor): void {
  try {
    atomicWrite(cursorPath(sessionId), JSON.stringify(cursor, null, 2));
  } catch {
    // best-effort
  }
}

/**
 * Count any usage from session entries not processed yet.
 * Returns the number of new usage records appended.
 */
function syncUsage(ctx: ExtensionContext): number {
  try {
    ensureMigrated();
    const sm = ctx.sessionManager;
    let sessionId = "unknown";
    try {
      sessionId = sm.getSessionId?.() || "unknown";
    } catch {
      // keep fallback
    }
    const entries = sm.getEntries();
    if (entries.length === 0) return 0;

    let cwd: string | undefined;
    try {
      cwd = ctx.cwd || sm.getCwd?.() || undefined;
    } catch {
      cwd = ctx.cwd || undefined;
    }

    const cursor = loadCursor(sessionId);
    let start = 0;
    let known: Set<string> | null = null;
    if (cursor?.lastId) {
      const idx = findEntryIndexFromEnd(entries, cursor.lastId);
      if (idx >= 0) {
        start = idx + 1;
      } else {
        // Session file rewritten/truncated: fall back to per-session id dedup.
        known = loadKnownIds(sessionId);
      }
    }

    const records: UsageRecord[] = [];
    for (let i = start; i < entries.length; i++) {
      const entry = entries[i];
      if (known?.has(entry.id)) continue;
      const rec = recordFromEntry(entry, sessionId, cwd);
      if (rec) records.push(rec);
    }

    const lastEntryId = entries[entries.length - 1]?.id;
    if (records.length > 0) {
      appendRecords(records);
      appendRecords([
        {
          v: RECORD_VERSION,
          t: "r",
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          session: sessionId,
          ...(cwd ? { cwd } : {}),
        },
      ]);
    }

    if (lastEntryId && lastEntryId !== cursor?.lastId) {
      saveCursor(sessionId, {
        lastId: lastEntryId,
        count: entries.length,
        updatedAt: new Date().toISOString(),
      });
    }

    return records.length;
  } catch {
    return 0; // tracking must never crash the agent
  }
}

// ---- aggregation ------------------------------------------------------------

function emptyDay(date: string): DayBucket {
  return {
    date,
    label: date.slice(5),
    runs: 0,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    tokens: 0,
    cost: 0,
  };
}

function buildChart(days: DayBucket[], todayKey: string): { points: ChartPoint[]; unit: "day" | "week" | "month" } {
  if (days.length <= MAX_CHART_DAYS) {
    return {
      points: days.map((d) => ({ label: d.label, tokens: d.tokens, cost: d.cost, isToday: d.date === todayKey })),
      unit: "day",
    };
  }
  if (days.length <= MAX_CHART_WEEKS * 7) {
    const todayWeek = weekStartKey(todayKey);
    const map = new Map<string, ChartPoint>();
    for (const d of days) {
      const wk = weekStartKey(d.date);
      let p = map.get(wk);
      if (!p) {
        p = { label: wk.slice(5), tokens: 0, cost: 0, isToday: wk === todayWeek };
        map.set(wk, p);
      }
      p.tokens += d.tokens;
      p.cost += d.cost;
    }
    return { points: [...map.values()], unit: "week" };
  }
  const todayMonth = todayKey.slice(0, 7);
  const map = new Map<string, ChartPoint>();
  for (const d of days) {
    const mk = d.date.slice(0, 7);
    let p = map.get(mk);
    if (!p) {
      p = { label: mk, tokens: 0, cost: 0, isToday: mk === todayMonth };
      map.set(mk, p);
    }
    p.tokens += d.tokens;
    p.cost += d.cost;
  }
  return { points: [...map.values()], unit: "month" };
}

function buildReport(range: number | "today" | "all"): ReportData {
  const log = loadLog();
  const todayKey = localDateKey(new Date());

  let from = todayKey;
  if (range === "all") {
    const dates = log.usage
      .map((r) => localDateKey(r.ts))
      .filter((d) => d !== "")
      .sort();
    if (dates.length > 0) from = dates[0];
  } else if (typeof range === "number") {
    from = addDays(todayKey, -(Math.max(1, range) - 1));
  }
  if (daysBetween(from, todayKey) > MAX_RANGE_DAYS) {
    from = addDays(todayKey, -MAX_RANGE_DAYS);
  }

  const dayMap = new Map<string, DayBucket>();
  for (const date of enumerateDays(from, todayKey)) dayMap.set(date, emptyDay(date));

  const windowUsage: UsageRecord[] = [];
  for (const rec of log.usage) {
    const dk = localDateKey(rec.ts);
    if (!dk || dk < from || dk > todayKey) continue;
    windowUsage.push(rec);
    const b = dayMap.get(dk);
    if (!b) continue;
    if (!rec.legacy) b.requests += 1;
    b.input += rec.input;
    b.output += rec.output;
    b.cacheRead += rec.cacheRead;
    b.cacheWrite += rec.cacheWrite;
    b.reasoning += rec.reasoning ?? 0;
    b.tokens += rec.total;
    b.cost += rec.cost;
  }
  for (const rec of log.runs) {
    const dk = localDateKey(rec.ts);
    if (!dk || dk < from || dk > todayKey) continue;
    const b = dayMap.get(dk);
    if (b) b.runs += 1;
  }

  const days = [...dayMap.values()];
  const windowTokens = windowUsage.reduce((sum, r) => sum + r.total, 0);

  const modelMap = new Map<string, ModelRow>();
  for (const rec of windowUsage) {
    let row = modelMap.get(rec.key);
    if (!row) {
      row = { key: rec.key, tokens: 0, cost: 0, requests: 0, share: 0 };
      modelMap.set(rec.key, row);
    }
    row.tokens += rec.total;
    row.cost += rec.cost;
    if (!rec.legacy) row.requests += 1;
  }
  const models = [...modelMap.values()]
    .map((row) => ({ ...row, share: windowTokens > 0 ? row.tokens / windowTokens : 0 }))
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);

  const projectMap = new Map<string, ProjectRow>();
  for (const rec of windowUsage) {
    const key = rec.cwd || "(unknown)";
    let row = projectMap.get(key);
    if (!row) {
      row = { key, tokens: 0, cost: 0 };
      projectMap.set(key, row);
    }
    row.tokens += rec.total;
    row.cost += rec.cost;
  }
  const projects = [...projectMap.values()].sort((a, b) => b.tokens - a.tokens).slice(0, MAX_PROJECT_ROWS);

  const { points, unit } = buildChart(days, todayKey);

  const tb = dayMap.get(todayKey);
  const today: TodayRow | null = tb
    ? {
        date: tb.date,
        runs: tb.runs,
        requests: tb.requests,
        input: tb.input,
        output: tb.output,
        cacheRead: tb.cacheRead,
        cacheWrite: tb.cacheWrite,
        reasoning: tb.reasoning,
        tokens: tb.tokens,
        cost: tb.cost,
        cacheHitRate: cacheHitRate(tb.input, tb.cacheRead),
      }
    : null;

  const totals: ReportTotals = {
    tokens: 0,
    cost: 0,
    runs: log.runs.length,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cacheHitRate: 0,
  };
  for (const rec of log.usage) {
    totals.tokens += rec.total;
    totals.cost += rec.cost;
    totals.input += rec.input;
    totals.output += rec.output;
    totals.cacheRead += rec.cacheRead;
    totals.cacheWrite += rec.cacheWrite;
    totals.reasoning += rec.reasoning ?? 0;
    if (!rec.legacy) totals.requests += 1;
  }
  totals.cacheHitRate = cacheHitRate(totals.input, totals.cacheRead);

  return {
    generatedAt: new Date().toISOString(),
    range: { from, to: todayKey, days: days.length },
    today,
    days,
    chart: points,
    chartUnit: unit,
    models,
    projects,
    totals,
    legacy: log.legacy,
  };
}

// ---- rendering --------------------------------------------------------------

function renderPanel(report: ReportData, theme: Theme): Component {
  const fg = (color: "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text", text: string) =>
    theme.fg(color, text);
  const row2 = (label: string, value: string, label2: string, value2: string) =>
    fg("muted", padRight("  " + label, 14)) +
    fg("text", padRight(value, 16)) +
    (label2 ? fg("muted", padRight(label2, 12)) + fg("text", value2) : "");

  const lines: string[] = [];
  lines.push(fg("accent", "📊 Token Usage") + fg("muted", "  —  token-stats"));
  lines.push(fg("muted", "─".repeat(62)));

  // Today
  if (report.today) {
    const t = report.today;
    lines.push("");
    lines.push(fg("accent", `Today  ${t.date.slice(5)}`));
    lines.push(row2("Runs", String(t.runs), "Requests", String(t.requests)));
    lines.push(row2("Input", fmtTokens(t.input), "Output", fmtTokens(t.output)));
    lines.push(
      row2(
        "Cache",
        `${fmtPct(t.cacheHitRate)} hit`,
        "R/W",
        `${fmtTokens(t.cacheRead)} / ${fmtTokens(t.cacheWrite)}`,
      ),
    );
    if (t.reasoning > 0) lines.push(row2("Reasoning", fmtTokens(t.reasoning), "", ""));
    lines.push(row2("Total", fmtTokens(t.tokens) + " tokens", "Cost", fmtCost(t.cost)));
  } else {
    lines.push("");
    lines.push(fg("muted", "No usage recorded for today yet."));
  }

  // Chart
  const unitLabel =
    report.chartUnit === "day"
      ? `${report.range.days} day(s)`
      : report.chartUnit === "week"
        ? "weekly"
        : "monthly";
  lines.push("");
  lines.push(fg("accent", `History (${unitLabel})`) + fg("muted", `  ${report.range.from} → ${report.range.to}`));
  const max = Math.max(...report.chart.map((p) => p.tokens), 1);
  for (const p of report.chart) {
    lines.push(
      fg("muted", padRight(p.label, 9)) +
        fg("success", barFor(p.tokens, max)) +
        " " +
        fg("text", padLeft(fmtTokens(p.tokens), 9)) +
        " " +
        fg("dim", padLeft(fmtCost(p.cost), 9)) +
        (p.isToday ? fg("muted", "  ← today") : ""),
    );
  }

  // By model
  if (report.models.length > 0) {
    lines.push("");
    lines.push(fg("accent", "By model") + fg("muted", `  (window)`));
    for (const m of report.models.slice(0, MAX_MODEL_ROWS)) {
      lines.push(
        fg("text", padRight(m.key, 34)) +
          fg("muted", padLeft(fmtTokens(m.tokens), 9)) +
          "  " +
          fg("warning", padLeft(fmtCost(m.cost), 9)) +
          "  " +
          fg("dim", padLeft(fmtPct(m.share), 6)),
      );
    }
    if (report.models.length > MAX_MODEL_ROWS) {
      lines.push(fg("dim", `  … +${report.models.length - MAX_MODEL_ROWS} more`));
    }
  }

  // By project
  if (report.projects.length > 0) {
    lines.push("");
    lines.push(fg("accent", "By project") + fg("muted", `  (window)`));
    for (const p of report.projects) {
      lines.push(
        fg("text", padRight(p.key, 40)) +
          fg("muted", padLeft(fmtTokens(p.tokens), 9)) +
          "  " +
          fg("warning", padLeft(fmtCost(p.cost), 9)),
      );
    }
  }

  // All-time footer
  lines.push("");
  lines.push(fg("muted", "─".repeat(62)));
  let footer =
    fg("muted", "All time: ") +
    fg("text", `${fmtTokens(report.totals.tokens)} tokens`) +
    fg("muted", " · ") +
    fg("warning", fmtCost(report.totals.cost)) +
    fg("muted", " · ") +
    fg("text", `${report.totals.runs} runs`) +
    fg("muted", " · ") +
    fg("text", `${report.totals.requests} requests`);
  if (report.totals.input + report.totals.cacheRead > 0) {
    footer += fg("muted", " · ") + fg("text", `cache hit ${fmtPct(report.totals.cacheHitRate)}`);
  }
  if (report.legacy) {
    footer += fg("dim", " · includes migrated data");
  }
  lines.push(footer);

  const body = lines.join("\n");
  const text = new Text(body, 1, 1);
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(text);
  return box;
}

/** Render reports appended by v1 of this extension, which have a different shape. */
function renderLegacyPanel(data: unknown, theme: Theme): Component | undefined {
  const d = data as {
    days?: Array<{ label?: string; tokens?: number; cost?: number }>;
    totals?: { totalTokens?: number; cost?: number; runs?: number };
  };
  if (!d || !Array.isArray(d.days)) return undefined;
  const fg = (color: "accent" | "muted" | "text" | "warning" | "success", text: string) =>
    theme.fg(color, text);
  const lines: string[] = [];
  lines.push(fg("accent", "📊 Token Usage") + fg("muted", "  —  token-stats (legacy report)"));
  lines.push(fg("muted", "────────────────────────────────────"));
  for (const day of d.days.slice(-14)) {
    lines.push(
      fg("muted", padRight(String(day.label ?? ""), 8)) +
        fg("success", padLeft(fmtTokens(num(day.tokens)), 10)) +
        fg("warning", "  " + fmtCost(num(day.cost))),
    );
  }
  const totals = d.totals ?? {};
  lines.push(fg("muted", "────────────────────────────────────"));
  lines.push(
    fg("muted", "All time: ") +
      fg("text", `${fmtTokens(num(totals.totalTokens))} tokens`) +
      fg("muted", " · ") +
      fg("warning", fmtCost(num(totals.cost))) +
      fg("muted", " · ") +
      fg("text", `${num(totals.runs)} runs`),
  );
  const text = new Text(lines.join("\n"), 1, 1);
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(text);
  return box;
}

// ---- command helpers --------------------------------------------------------

async function confirmAction(ctx: ExtensionCommandContext, title: string, message: string): Promise<boolean> {
  if (!ctx.hasUI) return false;
  try {
    return await ctx.ui.confirm(title, message);
  } catch {
    return false;
  }
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function exportCsv(filePath: string): number {
  const log = loadLog();
  const rows: string[] = [
    "timestamp,date,session,project,model,input,output,cache_read,cache_write,reasoning,total,cost",
  ];
  for (const rec of log.usage) {
    rows.push(
      [
        rec.ts,
        localDateKey(rec.ts),
        rec.session,
        rec.cwd ?? "",
        rec.key,
        String(rec.input),
        String(rec.output),
        String(rec.cacheRead),
        String(rec.cacheWrite),
        String(rec.reasoning ?? 0),
        String(rec.total),
        String(rec.cost),
      ]
        .map((v) => csvEscape(v))
        .join(","),
    );
  }
  atomicWrite(filePath, rows.join("\n") + "\n");
  return log.usage.length;
}

async function handleStat(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const cmd = (parts[0] ?? "").toLowerCase();
  const yes = parts.includes("--yes");

  const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  };

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    notify(
      "/stats [today|all|N] · /stats export [file] · /stats prune N [--yes] · /stats reset [--yes]",
      "info",
    );
    return;
  }

  if (cmd === "reset") {
    const ok = yes || (await confirmAction(ctx, "Reset token stats", "Delete all recorded token usage and session cursors?"));
    if (!ok) {
      notify("Reset cancelled.", "info");
      return;
    }
    try {
      fs.rmSync(usagePath(), { force: true });
      fs.rmSync(cursorDir(), { recursive: true, force: true });
      // Mark the current session as already accounted so its existing entries
      // are not immediately re-counted on the next settle.
      try {
        const sm = ctx.sessionManager;
        const sessionId = sm.getSessionId?.() || "";
        const lastEntryId = sm.getEntries().at(-1)?.id;
        if (sessionId && lastEntryId) {
          saveCursor(sessionId, {
            lastId: lastEntryId,
            count: sm.getEntries().length,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch {
        // best-effort
      }
      notify("Token stats reset. Legacy backup (if any) was kept.", "info");
    } catch (error) {
      notify(`Reset failed: ${String(error)}`, "error");
    }
    return;
  }

  if (cmd === "export") {
    const target = parts[1]
      ? path.resolve(ctx.cwd, parts[1])
      : path.join(ctx.cwd, `token-stats-${localDateKey(new Date())}.csv`);
    try {
      syncUsage(ctx);
      const count = exportCsv(target);
      notify(`Exported ${count} usage records to ${target}`, "info");
    } catch (error) {
      notify(`Export failed: ${String(error)}`, "error");
    }
    return;
  }

  if (cmd === "prune") {
    const days = Number(parts[1]);
    if (!Number.isInteger(days) || days < 1) {
      notify("Usage: /stats prune <days> [--yes]", "warning");
      return;
    }
    const ok =
      yes ||
      (await confirmAction(
        ctx,
        "Prune token stats",
        `Delete usage records older than ${days} day(s)? Cursors are kept so sessions are not recounted.`,
      ));
    if (!ok) {
      notify("Prune cancelled.", "info");
      return;
    }
    try {
      syncUsage(ctx);
      const { kept, removed } = pruneLog(days);
      notify(`Pruned ${removed} record(s), kept ${kept}.`, "info");
    } catch (error) {
      notify(`Prune failed: ${String(error)}`, "error");
    }
    return;
  }

  let range: number | "today" | "all" = 7;
  if (cmd === "today") {
    range = "today";
  } else if (cmd === "all") {
    range = "all";
  } else if (cmd !== "") {
    const n = Number(cmd);
    if (!Number.isInteger(n) || n < 1) {
      notify(`Unknown /stats argument "${parts[0]}". Try /stats help.`, "warning");
      return;
    }
    range = Math.min(n, MAX_RANGE_DAYS);
  }

  try {
    syncUsage(ctx);
  } catch {
    // Reporting should still work with whatever is already on disk.
  }

  const report = buildReport(range);
  pi.appendEntry("token-stats-report", report);
  notify(
    `${report.range.from} → ${report.range.to} · ${fmtTokens(report.totals.tokens)} tokens (all time) · ${fmtCost(report.totals.cost)}`,
    "info",
  );
}

// ---- extension entry point --------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Final boundary: after retries and automatic compaction have settled.
  pi.on("agent_settled", (_event, ctx) => {
    try {
      syncUsage(ctx);
    } catch {
      // never crash the agent
    }
  });

  // Catch entries written before this process loaded the extension.
  pi.on("session_start", (_event, ctx) => {
    try {
      syncUsage(ctx);
    } catch {
      // never crash the agent
    }
  });

  // Render the report panel (custom entry, kept out of model context).
  pi.registerEntryRenderer("token-stats-report", (entry, _options, theme) => {
    try {
      const data = entry.data as ReportData | undefined;
      if (data && Array.isArray(data.chart) && data.range) return renderPanel(data, theme);
      return renderLegacyPanel(entry.data, theme);
    } catch {
      return undefined;
    }
  });

  pi.registerCommand("stats", {
    description: "Show token usage: /stats [today|all|N|export|prune|reset]",
    getArgumentCompletions: (prefix) => {
      const options = ["today", "all", "export", "prune", "reset", "help"];
      const matches = options.filter((o) => o.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      await handleStat(pi, args, ctx);
    },
  });
}

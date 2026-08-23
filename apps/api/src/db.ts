import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LimitsSnapshot } from "./omp-cli.js";

export interface ImportResult {
  sourcePath: string;
  sourceRecords: number;
  newRecords: number;
  totalRecords: number;
  completedAt: number;
}

// A single day is addressed by its own local calendar date, so the period is
// either one of the three named windows or the date itself. One parameter keeps
// the reports' echoed period a round trip of what was asked for.
export type DayPeriod = `${number}-${number}-${number}`;
export type DashboardPeriod = "today" | "month" | "all" | DayPeriod;

const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

// Local midnight of a calendar date, or null when the text is not one. A date
// the Date constructor would silently roll over — 2026-02-31 becomes March 3 —
// is rejected instead of answered with another day's spend.
export function parseDay(value: string): Date | null {
  const match = dayPattern.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    return null;
  }
  return start;
}

export function isDashboardPeriod(value: string): value is DashboardPeriod {
  return value === "today" || value === "month" || value === "all" || parseDay(value) !== null;
}

interface UsageRow {
  session_file: string;
  entry_id: string;
  folder: string;
  model: string;
  provider: string;
  api: string;
  timestamp: number;
  duration: number | null;
  ttft: number | null;
  stop_reason: string;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  premium_requests: number;
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_write: number;
  cost_total: number;
  agent_type: string;
  cost_no_cache_input: number | null;
  category?: UsageCategory;
  project_path?: string | null;
}

export interface ModelsReport {
  generatedAt: number;
  models: Array<{
    model: string;
    provider: string;
    cost: number;
    effectivePricePerMillion: number | null;
  }>;
}

export interface Dashboard {
  generatedAt: number;
  lastSync: {
    completedAt: number;
    sourceRecords: number;
    newRecords: number;
    totalRecords: number;
  } | null;
  summary: {
    messageCount: number;
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    cost: number;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
  };
  categories: Array<{
    category: UsageCategory;
    messageCount: number;
    totalTokens: number;
  }>;
  limits: LimitsSnapshot | null;
}

export interface ProjectsReport {
  generatedAt: number;
  period: DashboardPeriod;
  totals: {
    cost: number;
    totalTokens: number;
    messageCount: number;
    sessionCount: number;
    projectCount: number;
  };
  models: Array<{
    model: string;
    provider: string;
    cost: number;
    totalTokens: number;
  }>;
  projects: Array<{
    folder: string;
    path: string | null;
    name: string;
    cost: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    messageCount: number;
    sessionCount: number;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
    effectivePricePerMillion: number | null;
    models: Array<{
      model: string;
      provider: string;
      cost: number;
      totalTokens: number;
      messageCount: number;
    }>;
  }>;
}

// Providers that hand out a model for free still leave the question of what it
// would have cost, so those rows are estimated from the model's published
// pay-as-you-go rates instead of the zero the provider recorded. Ollama Cloud
// reports no cache hits, so every prompt token is billed at the cache-miss rate.
interface EstimatedPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  // MiniMax doubles every rate once a prompt crosses this many tokens. Moonshot
  // publishes one flat rate for Kimi, so there is no tier to cross.
  tierLimit: number | null;
}

// MiniMax M3 rates published 2026-08-15:
// https://platform.minimax.io/docs/guides/pricing-paygo
// Kimi K2.6 rates published 2026-08-19:
// https://platform.kimi.ai/docs/pricing/chat-k26
// Kimi K3 rates published 2026-08-22:
// https://platform.kimi.ai/docs/pricing/chat-k3
// GLM-5.2 rates published 2026-08-23:
// https://docs.z.ai/guides/overview/pricing
// Kimi K2.7 Code rates published 2026-06-12:
// https://platform.kimi.ai/docs/pricing/chat-k27-code
// DeepSeek V4 Pro rates published 2026-08-16:
// https://api-docs.deepseek.com/quick_start/pricing
const ESTIMATED_PRICES: Record<string, EstimatedPrice> = {
  "minimax-m3": { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.06, tierLimit: 512_000 },
  "kimi-k2.6": { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.16, tierLimit: null },
  "kimi-k3": { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, tierLimit: null },
  "glm-5.2": { inputPerMillion: 1.4, outputPerMillion: 4.4, cacheReadPerMillion: 0.26, tierLimit: null },
  "kimi-k2.7-code": { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.19, tierLimit: null },
  "deepseek-v4-pro": { inputPerMillion: 0.66, outputPerMillion: 1.98, cacheReadPerMillion: 0.022, tierLimit: null },
};

type UsageCategory =
  | "Design"
  | "Development"
  | "Debugging"
  | "Data & analytics"
  | "DevOps"
  | "Documentation"
  | "Research"
  | "Review & security"
  | "Logic & planning";

interface SessionNode {
  parentId: string | null;
  userText: string | null;
}

const CATEGORY_RULES: ReadonlyArray<{
  category: Exclude<UsageCategory, "Logic & planning">;
  pattern: RegExp;
}> = [
  {
    category: "Design",
    pattern: /\b(design|ui|ux|layout|styling|stylesheet|css|tailwind|figma|paper|visual|typography|responsive)\b/i,
  },
  {
    category: "Debugging",
    pattern: /\b(bug|debug|error|crash|broken|failing|failure|not working|regression|fix)\b/i,
  },
  {
    category: "Review & security",
    pattern: /\b(review|audit|security|vulnerab|code quality|performance|over-engineer|refactor|simplif)\w*/i,
  },
  {
    category: "DevOps",
    pattern: /\b(deploy|deployment|docker|ci|pipeline|release|commit|push|git|infrastructure|monorepo|turborepo)\b/i,
  },
  {
    category: "Data & analytics",
    pattern: /\b(database|sqlite|sql|schema|migration|analytics|token|cost|pricing|dashboard)\w*/i,
  },
  {
    category: "Documentation",
    pattern: /\b(documentation|docs|readme|copywriting|guide|changelog)\b/i,
  },
  {
    category: "Research",
    pattern: /\b(research|investigate|compare|website|find out|explain|how does|what is)\b/i,
  },
  {
    category: "Development",
    pattern: /\b(add|build|implement|create|update|change|feature|code|api|backend|frontend|component|command)\w*/i,
  },
];

function extractUserText(message: unknown): string | null {
  if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") {
    return null;
  }
  if (!("content" in message)) return null;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;

  const text: string[] = [];
  for (const item of message.content) {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      text.push(item.text);
    }
  }
  return text.length === 0 ? null : text.join("\n");
}

interface SessionFile {
  cwd: string | null;
  nodes: Map<string, SessionNode>;
}

function readSessionFile(sessionFile: string): SessionFile {
  const nodes = new Map<string, SessionNode>();
  let cwd: string | null = null;
  if (!existsSync(sessionFile)) return { cwd, nodes };

  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // An active session can end with a partially written JSONL record.
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    // The session header carries the real working directory. The folder column
    // only holds a slug where "/" and "-" both became "-", so the directory
    // boundaries cannot be recovered from it.
    if (cwd === null && "cwd" in entry && typeof entry.cwd === "string" && entry.cwd.length > 0) {
      cwd = entry.cwd;
    }
    if (!("id" in entry) || typeof entry.id !== "string") continue;

    const parentId =
      "parentId" in entry && typeof entry.parentId === "string" ? entry.parentId : null;
    const userText = "message" in entry ? extractUserText(entry.message) : null;
    nodes.set(entry.id, { parentId, userText });
  }
  return { cwd, nodes };
}

function classifyEntry(entryId: string, nodes: Map<string, SessionNode>): UsageCategory {
  let node = nodes.get(entryId);
  for (let depth = 0; node && depth <= nodes.size; depth += 1) {
    if (node.userText) {
      for (const rule of CATEGORY_RULES) {
        if (rule.pattern.test(node.userText)) return rule.category;
      }
      return "Logic & planning";
    }
    node = node.parentId ? nodes.get(node.parentId) : undefined;
  }
  return "Logic & planning";
}


const usageColumns = `
  session_file, entry_id, folder, model, provider, api, timestamp, duration,
  ttft, stop_reason, error_message, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
  cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
  agent_type, cost_no_cache_input
`;

export function getOmpStatsPath(): string {
  return resolve(process.env.OMP_STATS_DB ?? join(homedir(), ".omp", "stats.db"));
}

export function getTrackerDatabasePath(): string {
  return resolve(process.env.DATA_DIR ?? "data", "token-tracker.sqlite");
}

export function openTrackerDatabase(filePath = getTrackerDatabasePath()): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS usage_messages (
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      api TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration REAL,
      ttft REAL,
      stop_reason TEXT NOT NULL,
      error_message TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      premium_requests REAL NOT NULL,
      cost_input REAL NOT NULL,
      cost_output REAL NOT NULL,
      cost_cache_read REAL NOT NULL,
      cost_cache_write REAL NOT NULL,
      cost_total REAL NOT NULL,
      agent_type TEXT NOT NULL,
      cost_no_cache_input REAL,
      category TEXT NOT NULL,
      project_path TEXT,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (session_file, entry_id)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS usage_timestamp_idx ON usage_messages(timestamp);
    CREATE INDEX IF NOT EXISTS usage_model_idx ON usage_messages(model, provider);
    CREATE INDEX IF NOT EXISTS usage_folder_idx ON usage_messages(folder);
    CREATE INDEX IF NOT EXISTS usage_agent_idx ON usage_messages(agent_type);

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY,
      started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      source_records INTEGER NOT NULL,
      new_records INTEGER NOT NULL,
      total_records INTEGER NOT NULL
    );

    -- Provider quota limits are a single point-in-time reading, so the newest
    -- one replaces the previous row instead of accumulating history.
    CREATE TABLE IF NOT EXISTS limit_snapshots (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      captured_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );

    -- Interface choices that must outlive the window. The desktop app binds an
    -- ephemeral loopback port, so the webview origin changes on every launch and
    -- its own localStorage is a different bucket each time; only this file survives.
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  const columns = db.prepare("PRAGMA table_info(usage_messages)").all();
  if (!columns.some((column) => column.name === "category")) {
    db.exec("ALTER TABLE usage_messages ADD COLUMN category TEXT NOT NULL DEFAULT 'Logic & planning'");
  }
  if (!columns.some((column) => column.name === "project_path")) {
    db.exec("ALTER TABLE usage_messages ADD COLUMN project_path TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS usage_category_idx ON usage_messages(category)");
  return db;
}

export function importFromOmp(
  tracker: DatabaseSync,
  sourcePath = getOmpStatsPath(),
): ImportResult {
  if (!existsSync(sourcePath)) {
    throw new Error(`Oh My Pi stats database was not found at ${sourcePath}`);
  }

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const startedAt = Date.now();

  try {
    const rows = source.prepare(`SELECT ${usageColumns} FROM messages ORDER BY id`).all() as unknown as UsageRow[];

    // Session-file parsing is the slow part of a large import. Rows that are
    // already stored keep their derived category and project path, so only new
    // rows pay the cost of reading their transcript and classifying it.
    const existingByKey = new Map<string, { category: UsageCategory; project_path: string | null }>();
    const existingRows = tracker.prepare(
      "SELECT session_file, entry_id, category, project_path FROM usage_messages",
    ).all() as Array<{ session_file: string; entry_id: string; category: UsageCategory; project_path: string | null }>;
    for (const row of existingRows) {
      existingByKey.set(`${row.session_file}\0${row.entry_id}`, {
        category: row.category,
        project_path: row.project_path,
      });
    }

    const sessionFiles = new Map<string, SessionFile>();
    // Subagent transcripts carry no session header, so the working directory is
    // resolved per folder: any session that recorded one speaks for the slug.
    const pathByFolder = new Map<string, string>();
    for (const row of rows) {
      const key = `${row.session_file}\0${row.entry_id}`;
      const existing = existingByKey.get(key);
      if (existing) {
        row.category = existing.category;
        row.project_path = existing.project_path;
        continue;
      }
      let session = sessionFiles.get(row.session_file);
      if (!session) {
        session = readSessionFile(row.session_file);
        sessionFiles.set(row.session_file, session);
      }
      row.category = classifyEntry(row.entry_id, session.nodes);
      if (session.cwd !== null && !pathByFolder.has(row.folder)) {
        pathByFolder.set(row.folder, session.cwd);
      }
    }
    for (const row of rows) {
      if (row.project_path === undefined) {
        row.project_path = pathByFolder.get(row.folder) ?? null;
      }
    }
    const beforeRow = tracker.prepare("SELECT COUNT(*) AS count FROM usage_messages").get();
    if (!beforeRow || typeof beforeRow.count !== "number") {
      throw new Error("Could not count saved usage records");
    }
    const before = beforeRow.count;
    const upsert = tracker.prepare(`
      INSERT INTO usage_messages (
        ${usageColumns}, category, project_path, imported_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(session_file, entry_id) DO UPDATE SET
        folder = excluded.folder,
        model = excluded.model,
        provider = excluded.provider,
        api = excluded.api,
        timestamp = excluded.timestamp,
        duration = excluded.duration,
        ttft = excluded.ttft,
        stop_reason = excluded.stop_reason,
        error_message = excluded.error_message,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        total_tokens = excluded.total_tokens,
        premium_requests = excluded.premium_requests,
        cost_input = excluded.cost_input,
        cost_output = excluded.cost_output,
        cost_cache_read = excluded.cost_cache_read,
        cost_cache_write = excluded.cost_cache_write,
        cost_total = excluded.cost_total,
        agent_type = excluded.agent_type,
        cost_no_cache_input = excluded.cost_no_cache_input,
        category = excluded.category,
        project_path = excluded.project_path,
        imported_at = excluded.imported_at
    `);

    tracker.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        let costInput = row.cost_input;
        let costOutput = row.cost_output;
        let costCacheRead = row.cost_cache_read;
        let costCacheWrite = row.cost_cache_write;
        let costTotal = row.cost_total;
        let costNoCacheInput = row.cost_no_cache_input;

        const model = row.model.toLowerCase();
        const estimate = Object.hasOwn(ESTIMATED_PRICES, model) ? ESTIMATED_PRICES[model] : undefined;
        if (estimate) {
          const promptTokens = row.input_tokens + row.cache_read_tokens + row.cache_write_tokens;
          const tierMultiplier =
            estimate.tierLimit !== null && promptTokens > estimate.tierLimit ? 2 : 1;
          const inputRate = estimate.inputPerMillion * tierMultiplier;
          costInput = (row.input_tokens * inputRate) / 1_000_000;
          costOutput = (row.output_tokens * estimate.outputPerMillion * tierMultiplier) / 1_000_000;
          costCacheRead =
            (row.cache_read_tokens * estimate.cacheReadPerMillion * tierMultiplier) / 1_000_000;
          costCacheWrite = 0;
          costTotal = costInput + costOutput + costCacheRead;
          costNoCacheInput = (promptTokens * inputRate) / 1_000_000;
        }

        upsert.run(
          row.session_file,
          row.entry_id,
          row.folder,
          row.model,
          row.provider,
          row.api,
          row.timestamp,
          row.duration,
          row.ttft,
          row.stop_reason,
          row.error_message,
          row.input_tokens,
          row.output_tokens,
          row.cache_read_tokens,
          row.cache_write_tokens,
          row.total_tokens,
          row.premium_requests,
          costInput,
          costOutput,
          costCacheRead,
          costCacheWrite,
          costTotal,
          row.agent_type,
          costNoCacheInput,
          row.category ?? "Logic & planning",
          row.project_path ?? null,
          startedAt,
        );
      }

      const totalRow = tracker.prepare("SELECT COUNT(*) AS count FROM usage_messages").get();
      if (!totalRow || typeof totalRow.count !== "number") {
        throw new Error("Could not count imported usage records");
      }
      const totalRecords = totalRow.count;
      const completedAt = Date.now();
      const newRecords = totalRecords - before;
      tracker.prepare(`
        INSERT INTO sync_runs (
          started_at, completed_at, source_path, source_records, new_records, total_records
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(startedAt, completedAt, sourcePath, rows.length, newRecords, totalRecords);
      tracker.exec("COMMIT");

      return {
        sourcePath,
        sourceRecords: rows.length,
        newRecords,
        totalRecords,
        completedAt,
      };
    } catch (error) {
      tracker.exec("ROLLBACK");
      throw error;
    }
  } finally {
    source.close();
  }
}

function numberOrZero(value: number | null): number {
  return Number(value ?? 0);
}

function pricePerMillion(cost: number, tokens: number): number | null {
  return tokens === 0 ? null : (cost / tokens) * 1_000_000;
}

function usageRange(period: DashboardPeriod, now: number): { where: string; parameters: number[] } {
  if (period === "all") return { where: "", parameters: [] };

  let start: Date;
  if (period === "today" || period === "month") {
    start = new Date(now);
    if (period === "month") start.setDate(1);
    start.setHours(0, 0, 0, 0);
  } else {
    const day = parseDay(period);
    if (day === null) {
      throw new Error(`period must be today, month, all, or a YYYY-MM-DD date, not ${period}`);
    }
    start = day;
  }

  const end = new Date(start);
  if (period === "month") {
    end.setMonth(end.getMonth() + 1);
  } else {
    end.setDate(end.getDate() + 1);
  }

  return {
    where: "WHERE timestamp >= ? AND timestamp < ?",
    parameters: [start.getTime(), end.getTime()],
  };
}

export function saveLimitsSnapshot(tracker: DatabaseSync, snapshot: LimitsSnapshot): void {
  tracker.prepare(`
    INSERT INTO limit_snapshots (id, captured_at, payload) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET captured_at = excluded.captured_at, payload = excluded.payload
  `).run(snapshot.capturedAt, JSON.stringify(snapshot));
}

export interface Preferences {
  hiddenLimits: string[];
}

// Every interface choice is one JSON document under its own key, so adding a
// second preference later needs no schema change.
const hiddenLimitsKey = "hiddenLimits";

export function readPreferences(tracker: DatabaseSync): Preferences {
  const row = tracker.prepare("SELECT value FROM preferences WHERE key = ?").get(hiddenLimitsKey);
  const stored = row && typeof row === "object" && "value" in row ? row.value : null;
  if (typeof stored !== "string") return { hiddenLimits: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    // A document written by an older build can disagree with the current shape,
    // so a parse failure reads as "nothing hidden" instead of failing the read.
    return { hiddenLimits: [] };
  }
  if (!Array.isArray(parsed)) return { hiddenLimits: [] };
  return { hiddenLimits: parsed.filter((entry): entry is string => typeof entry === "string") };
}

export function savePreferences(tracker: DatabaseSync, preferences: Preferences): void {
  tracker.prepare(`
    INSERT INTO preferences (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(hiddenLimitsKey, JSON.stringify(preferences.hiddenLimits));
}

function readLimitsSnapshot(tracker: DatabaseSync): LimitsSnapshot | null {
  const row = tracker.prepare("SELECT payload FROM limit_snapshots WHERE id = 1").get();
  if (!row || typeof row.payload !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return null;
  }
  // A snapshot written by an older build can disagree with the current shape.
  if (!parsed || typeof parsed !== "object") return null;
  const snapshot = parsed as LimitsSnapshot;
  return typeof snapshot.capturedAt === "number" && Array.isArray(snapshot.providers) ? snapshot : null;
}

export function getModels(
  tracker: DatabaseSync,
  period: DashboardPeriod = "all",
  now = Date.now(),
): ModelsReport {
  const range = usageRange(period, now);
  const models = (tracker.prepare(`
    SELECT
      model,
      provider,
      SUM(cost_total) AS cost,
      SUM(total_tokens) AS totalTokens
    FROM usage_messages
    ${range.where}
    GROUP BY model, provider
    ORDER BY cost DESC, totalTokens DESC
  `).all(...range.parameters) as unknown as Array<{
    model: string;
    provider: string;
    cost: number | null;
    totalTokens: number | null;
  }>).map((row) => {
    const cost = numberOrZero(row.cost);
    return {
      model: row.model,
      provider: row.provider,
      cost,
      // Blended rate actually paid across input, output, and cache traffic.
      effectivePricePerMillion: pricePerMillion(cost, numberOrZero(row.totalTokens)),
    };
  });

  return {
    generatedAt: now,
    models,
  };
}

export function getDashboard(
  tracker: DatabaseSync,
  period: DashboardPeriod = "all",
  now = Date.now(),
): Dashboard {
  const range = usageRange(period, now);
  const summary = tracker.prepare(`
    SELECT
      COUNT(*) AS messageCount,
      COUNT(DISTINCT session_file) AS sessionCount,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(cache_write_tokens) AS cacheWriteTokens,
      SUM(total_tokens) AS totalTokens,
      SUM(cost_total) AS cost,
      MIN(timestamp) AS firstMessageAt,
      MAX(timestamp) AS lastMessageAt
    FROM usage_messages
    ${range.where}
  `).get(...range.parameters) as {
    messageCount: number;
    sessionCount: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    totalTokens: number | null;
    cost: number | null;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
  };

  const categories = (tracker.prepare(`
    SELECT
      category,
      COUNT(*) AS messageCount,
      SUM(total_tokens) AS totalTokens
    FROM usage_messages
    ${range.where}
    GROUP BY category
    ORDER BY totalTokens DESC
  `).all(...range.parameters) as unknown as Array<{
    category: UsageCategory;
    messageCount: number;
    totalTokens: number | null;
  }>).map((row) => ({
    category: row.category,
    messageCount: Number(row.messageCount),
    totalTokens: numberOrZero(row.totalTokens),
  }));

  const lastSync = tracker.prepare(`
    SELECT
      completed_at AS completedAt,
      source_records AS sourceRecords,
      new_records AS newRecords,
      total_records AS totalRecords
    FROM sync_runs
    ORDER BY id DESC
    LIMIT 1
  `).get() as Dashboard["lastSync"];

  return {
    generatedAt: now,
    lastSync: lastSync
      ? {
          completedAt: Number(lastSync.completedAt),
          sourceRecords: Number(lastSync.sourceRecords),
          newRecords: Number(lastSync.newRecords),
          totalRecords: Number(lastSync.totalRecords),
        }
      : null,
    summary: {
      messageCount: Number(summary.messageCount),
      sessionCount: Number(summary.sessionCount),
      inputTokens: numberOrZero(summary.inputTokens),
      outputTokens: numberOrZero(summary.outputTokens),
      cacheReadTokens: numberOrZero(summary.cacheReadTokens),
      cacheWriteTokens: numberOrZero(summary.cacheWriteTokens),
      totalTokens: numberOrZero(summary.totalTokens),
      cost: numberOrZero(summary.cost),
      firstMessageAt: summary.firstMessageAt === null ? null : Number(summary.firstMessageAt),
      lastMessageAt: summary.lastMessageAt === null ? null : Number(summary.lastMessageAt),
    },
    categories,
    limits: readLimitsSnapshot(tracker),
  };
}

// Oh My Pi records the working directory twice: as a slug where both "/" and
// "-" became "-", and verbatim in the session header. Prefer the real path,
// trimmed to the part below the home directory, because the slug alone cannot
// say where one directory ended and the next began.
function projectName(folder: string, path: string | null): string {
  if (path !== null) {
    const home = homedir();
    const relative = path === home
      ? ""
      : path.startsWith(`${home}/`)
        ? path.slice(home.length + 1)
        : path.replace(/^\/+/, "");
    if (relative !== "") return relative;
  }

  const trimmed = folder.replace(/^[-/]+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "(no workspace)" : trimmed;
}

// The macOS per-user temp root, matched by shape. os.tmpdir() only reports the
// value of TMPDIR in this process, so a server started without it would
// otherwise stop recognising /var/folders/<x>/<y>/T as scratch space.
const MACOS_TEMP_ROOT = /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/;

// Smoke tests and probes run in the system temp directory, and a session
// started from the home directory never entered a workspace at all. Neither is
// a project, so they stay out of the rollup instead of padding it with noise.
function isProject(folder: string, path: string | null): boolean {
  if (path === null) {
    const trimmed = folder.replace(/^[-/]+/, "").replace(/\/+$/, "");
    return trimmed !== "" && trimmed !== "tmp" && !trimmed.startsWith("tmp-");
  }
  if (path === homedir() || MACOS_TEMP_ROOT.test(path)) return false;
  return ![tmpdir(), "/tmp", "/private/tmp", "/var/tmp"].some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

export function getProjects(
  tracker: DatabaseSync,
  period: DashboardPeriod = "all",
  now = Date.now(),
): ProjectsReport {
  const range = usageRange(period, now);
  const rows = tracker.prepare(`
    SELECT
      folder,
      MAX(project_path) AS path,
      COUNT(*) AS messageCount,
      COUNT(DISTINCT session_file) AS sessionCount,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(cache_write_tokens) AS cacheWriteTokens,
      SUM(total_tokens) AS totalTokens,
      SUM(cost_total) AS cost,
      MIN(timestamp) AS firstMessageAt,
      MAX(timestamp) AS lastMessageAt
    FROM usage_messages
    ${range.where}
    GROUP BY folder
    ORDER BY cost DESC, totalTokens DESC
  `).all(...range.parameters) as unknown as Array<{
    folder: string;
    path: string | null;
    messageCount: number;
    sessionCount: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    totalTokens: number | null;
    cost: number | null;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
  }>;

  // One extra grouped pass keeps the per-model split on the same page load, so the
  // UI never has to fetch a second time to explain a project's spend.
  const breakdown = tracker.prepare(`
    SELECT
      folder,
      model,
      provider,
      COUNT(*) AS messageCount,
      SUM(total_tokens) AS totalTokens,
      SUM(cost_total) AS cost
    FROM usage_messages
    ${range.where}
    GROUP BY folder, model, provider
    ORDER BY cost DESC, totalTokens DESC
  `).all(...range.parameters) as unknown as Array<{
    folder: string;
    model: string;
    provider: string;
    messageCount: number;
    totalTokens: number | null;
    cost: number | null;
  }>;

  const perProjectModels = new Map<string, ProjectsReport["projects"][number]["models"]>();
  for (const row of breakdown) {
    const entries = perProjectModels.get(row.folder);
    const entry = {
      model: row.model,
      provider: row.provider,
      cost: numberOrZero(row.cost),
      totalTokens: numberOrZero(row.totalTokens),
      messageCount: Number(row.messageCount),
    };
    if (entries) entries.push(entry);
    else perProjectModels.set(row.folder, [entry]);
  }

  const projects = rows.filter((row) => isProject(row.folder, row.path)).map((row) => {
    const cost = numberOrZero(row.cost);
    const totalTokens = numberOrZero(row.totalTokens);
    return {
      folder: row.folder,
      path: row.path,
      name: projectName(row.folder, row.path),
      cost,
      totalTokens,
      inputTokens: numberOrZero(row.inputTokens),
      outputTokens: numberOrZero(row.outputTokens),
      cacheReadTokens: numberOrZero(row.cacheReadTokens),
      cacheWriteTokens: numberOrZero(row.cacheWriteTokens),
      messageCount: Number(row.messageCount),
      sessionCount: Number(row.sessionCount),
      firstMessageAt: row.firstMessageAt === null ? null : Number(row.firstMessageAt),
      lastMessageAt: row.lastMessageAt === null ? null : Number(row.lastMessageAt),
      effectivePricePerMillion: pricePerMillion(cost, totalTokens),
      models: perProjectModels.get(row.folder) ?? [],
    };
  });

  // The legend is folded up from the projects that survived the filter, so a
  // model can never appear in it without a card behind it.
  const modelTotals = new Map<string, ProjectsReport["models"][number]>();
  for (const project of projects) {
    for (const entry of project.models) {
      const key = `${entry.provider}/${entry.model}`;
      const running = modelTotals.get(key);
      if (running) {
        running.cost += entry.cost;
        running.totalTokens += entry.totalTokens;
      } else {
        modelTotals.set(key, {
          model: entry.model,
          provider: entry.provider,
          cost: entry.cost,
          totalTokens: entry.totalTokens,
        });
      }
    }
  }
  const models = [...modelTotals.values()].sort(
    (left, right) => right.cost - left.cost || right.totalTokens - left.totalTokens,
  );

  return {
    generatedAt: now,
    period,
    totals: {
      cost: projects.reduce((sum, project) => sum + project.cost, 0),
      totalTokens: projects.reduce((sum, project) => sum + project.totalTokens, 0),
      messageCount: projects.reduce((sum, project) => sum + project.messageCount, 0),
      // Session files are unique per project, so the per-project counts add up.
      sessionCount: projects.reduce((sum, project) => sum + project.sessionCount, 0),
      projectCount: projects.length,
    },
    models,
    projects,
  };
}

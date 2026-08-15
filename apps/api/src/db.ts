import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
  models: Array<{
    model: string;
    provider: string;
    cost: number;
    effectivePricePerMillion: number | null;
  }>;
  categories: Array<{
    category: UsageCategory;
    messageCount: number;
    totalTokens: number;
  }>;
  limits: LimitsSnapshot | null;
}

// Standard pay-as-you-go rates published by MiniMax on 2026-08-15.
// https://platform.minimax.io/docs/guides/pricing-paygo
const MINIMAX_M3_CONTEXT_LIMIT = 512_000;
const MINIMAX_M3_INPUT_PER_MILLION = 0.3;
const MINIMAX_M3_OUTPUT_PER_MILLION = 1.2;
const MINIMAX_M3_CACHE_READ_PER_MILLION = 0.06;
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

function readSessionNodes(sessionFile: string): Map<string, SessionNode> {
  const nodes = new Map<string, SessionNode>();
  if (!existsSync(sessionFile)) return nodes;

  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // An active session can end with a partially written JSONL record.
      continue;
    }
    if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") {
      continue;
    }

    const parentId =
      "parentId" in entry && typeof entry.parentId === "string" ? entry.parentId : null;
    const userText = "message" in entry ? extractUserText(entry.message) : null;
    nodes.set(entry.id, { parentId, userText });
  }
  return nodes;
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
  `);
  const columns = db.prepare("PRAGMA table_info(usage_messages)").all();
  if (!columns.some((column) => column.name === "category")) {
    db.exec("ALTER TABLE usage_messages ADD COLUMN category TEXT NOT NULL DEFAULT 'Logic & planning'");
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
    const sessionNodes = new Map<string, Map<string, SessionNode>>();
    for (const row of rows) {
      let nodes = sessionNodes.get(row.session_file);
      if (!nodes) {
        nodes = readSessionNodes(row.session_file);
        sessionNodes.set(row.session_file, nodes);
      }
      row.category = classifyEntry(row.entry_id, nodes);
    }
    const beforeRow = tracker.prepare("SELECT COUNT(*) AS count FROM usage_messages").get();
    if (!beforeRow || typeof beforeRow.count !== "number") {
      throw new Error("Could not count saved usage records");
    }
    const before = beforeRow.count;
    const upsert = tracker.prepare(`
      INSERT INTO usage_messages (
        ${usageColumns}, category, imported_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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

        if (row.model.toLowerCase() === "minimax-m3") {
          const promptTokens = row.input_tokens + row.cache_read_tokens + row.cache_write_tokens;
          const tierMultiplier = promptTokens > MINIMAX_M3_CONTEXT_LIMIT ? 2 : 1;
          const inputRate = MINIMAX_M3_INPUT_PER_MILLION * tierMultiplier;
          costInput = (row.input_tokens * inputRate) / 1_000_000;
          costOutput = (row.output_tokens * MINIMAX_M3_OUTPUT_PER_MILLION * tierMultiplier) / 1_000_000;
          costCacheRead =
            (row.cache_read_tokens * MINIMAX_M3_CACHE_READ_PER_MILLION * tierMultiplier) / 1_000_000;
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

export function saveLimitsSnapshot(tracker: DatabaseSync, snapshot: LimitsSnapshot): void {
  tracker.prepare(`
    INSERT INTO limit_snapshots (id, captured_at, payload) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET captured_at = excluded.captured_at, payload = excluded.payload
  `).run(snapshot.capturedAt, JSON.stringify(snapshot));
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

export function getDashboard(tracker: DatabaseSync): Dashboard {
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
  `).get() as {
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

  const models = (tracker.prepare(`
    SELECT
      model,
      provider,
      SUM(cost_total) AS cost,
      SUM(total_tokens) AS totalTokens
    FROM usage_messages
    GROUP BY model, provider
    ORDER BY cost DESC, totalTokens DESC
  `).all() as unknown as Array<{
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
  const categories = (tracker.prepare(`
    SELECT
      category,
      COUNT(*) AS messageCount,
      SUM(total_tokens) AS totalTokens
    FROM usage_messages
    GROUP BY category
    ORDER BY totalTokens DESC
  `).all() as unknown as Array<{
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
    generatedAt: Date.now(),
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
    models,
    categories,
    limits: readLimitsSnapshot(tracker),
  };
}

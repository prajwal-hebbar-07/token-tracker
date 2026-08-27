import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { LimitWindow, ProviderLimits } from "./omp-cli.js";

const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 250;
const DEFAULT_API_BASE = "https://api2.cursor.sh";
const AUTH_FAILURE =
  "Cursor is not signed in, or the stored session has expired. Sign in to Cursor and fetch again, or set CURSOR_API_KEY.";

export interface CursorUsageEvent {
  timestamp: number;
  model: string;
  kind: string;
  conversationId: string | null;
  isHeadless: boolean;
  requestsCosts: number;
  chargedCents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CursorAuth {
  accessToken: string;
  apiKey: string | null;
  email: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asCount(value: unknown): number {
  const parsed = asFiniteNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.round(parsed));
}

export function parseCursorTime(value: unknown): number | null {
  const numeric = asFiniteNumber(value);
  if (numeric !== null) return numeric;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function apiBase(): string {
  const override = asString(process.env.CURSOR_API_BASE);
  return override ?? DEFAULT_API_BASE;
}

export function cursorStateDatabasePath(): string {
  const override = asString(process.env.CURSOR_STATE_DB);
  if (override) return override;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorAuthJsonPath(): string {
  return asString(process.env.CURSOR_AUTH_JSON) ?? join(homedir(), ".cursor", "auth.json");
}

function cursorProjectsRoot(): string {
  return asString(process.env.CURSOR_PROJECTS_DIR) ?? join(homedir(), ".cursor", "projects");
}

function cursorWorkspaceStorageRoot(): string {
  const override = asString(process.env.CURSOR_WORKSPACE_STORAGE);
  if (override) return override;
  return join(dirname(dirname(cursorStateDatabasePath())), "workspaceStorage");
}

function cursorLooksInstalled(): boolean {
  return Boolean(
    asString(process.env.CURSOR_API_KEY) ||
      asString(process.env.CURSOR_ACCESS_TOKEN) ||
      existsSync(cursorStateDatabasePath()) ||
      existsSync(cursorAuthJsonPath()),
  );
}

function readItemTableValue(database: DatabaseSync, key: string): string | null {
  const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
  if (!row || typeof row.value !== "string" || row.value.length === 0) return null;
  const value = row.value.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return asString(parsed);
    } catch {
      return value;
    }
  }
  return value;
}

function openStateDatabase(path: string): DatabaseSync | null {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    // Cursor keeps this file open. A copy still reflects the last checkpoint,
    // which is enough to read the session token.
    const copy = join(tmpdir(), `token-tracker-cursor-state-${process.pid}.vscdb`);
    try {
      copyFileSync(path, copy);
      try {
        copyFileSync(`${path}-wal`, `${copy}-wal`);
      } catch {
        // No WAL sidecar to copy.
      }
      try {
        copyFileSync(`${path}-shm`, `${copy}-shm`);
      } catch {
        // No shared-memory sidecar to copy.
      }
      return new DatabaseSync(copy, { readOnly: true });
    } catch {
      try {
        rmSync(copy, { force: true });
        rmSync(`${copy}-wal`, { force: true });
        rmSync(`${copy}-shm`, { force: true });
      } catch {
        // Best-effort cleanup of a failed copy.
      }
      return null;
    }
  }
}

function readStateAuth(path: string): { accessToken: string | null; email: string | null } {
  if (!existsSync(path)) return { accessToken: null, email: null };
  const database = openStateDatabase(path);
  if (!database) return { accessToken: null, email: null };
  try {
    return {
      accessToken: readItemTableValue(database, "cursorAuth/accessToken") ?? readItemTableValue(database, "cursorAuth/token"),
      email: readItemTableValue(database, "cursorAuth/cachedEmail"),
    };
  } catch {
    return { accessToken: null, email: null };
  } finally {
    database.close();
  }
}

function readAuthJson(path: string): { accessToken: string | null; apiKey: string | null } {
  if (!existsSync(path)) return { accessToken: null, apiKey: null };
  try {
    const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
    return {
      accessToken: asString(parsed?.accessToken),
      apiKey: asString(parsed?.apiKey),
    };
  } catch {
    return { accessToken: null, apiKey: null };
  }
}

export function resolveCursorAuth(): CursorAuth | null {
  const envApiKey = asString(process.env.CURSOR_API_KEY);
  const envToken = asString(process.env.CURSOR_ACCESS_TOKEN);
  const fromState = readStateAuth(cursorStateDatabasePath());
  const fromFile = readAuthJson(cursorAuthJsonPath());
  const apiKey = envApiKey ?? fromFile.apiKey;
  const accessToken = envToken ?? fromState.accessToken ?? fromFile.accessToken;
  if (!accessToken && !apiKey) return null;
  return {
    accessToken: accessToken ?? apiKey ?? "",
    apiKey,
    email: fromState.email,
  };
}

interface DashboardResponse {
  status: number;
  payload: unknown;
}

async function dashboardPost(accessToken: string, path: string, body: unknown): Promise<DashboardResponse> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "request failed";
    throw new Error(`Could not read Cursor usage: ${detail}.`);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

async function exchangeApiKey(apiKey: string): Promise<string | null> {
  const { status, payload } = await dashboardPost(apiKey, "/auth/exchange_user_api_key", {});
  if (status < 200 || status >= 300) return null;
  return asString(asRecord(payload)?.accessToken);
}

async function withCursorToken<T>(
  auth: CursorAuth,
  run: (accessToken: string) => Promise<{ status: number; value: T | null }>,
): Promise<{ value: T | null; warning: string | null }> {
  let accessToken = auth.accessToken;
  if (accessToken.startsWith("crsr_")) {
    const exchanged = await exchangeApiKey(accessToken);
    if (!exchanged) return { value: null, warning: AUTH_FAILURE };
    accessToken = exchanged;
  }

  const first = await run(accessToken);
  if (first.status !== 401 && first.status !== 403) {
    return first.status >= 200 && first.status < 300
      ? { value: first.value, warning: null }
      : { value: null, warning: `Cursor usage returned HTTP ${first.status}.` };
  }
  if (!auth.apiKey) return { value: null, warning: AUTH_FAILURE };
  const exchanged = await exchangeApiKey(auth.apiKey);
  if (!exchanged) return { value: null, warning: AUTH_FAILURE };
  const retry = await run(exchanged);
  if (retry.status === 401 || retry.status === 403) return { value: null, warning: AUTH_FAILURE };
  return retry.status >= 200 && retry.status < 300
    ? { value: retry.value, warning: null }
    : { value: null, warning: `Cursor usage returned HTTP ${retry.status}.` };
}

export function parseCursorUsageEvent(value: unknown): CursorUsageEvent | null {
  const event = asRecord(value);
  if (!event) return null;
  const timestamp = parseCursorTime(event.timestamp);
  const model = asString(event.model);
  if (timestamp === null || !model) return null;
  const usage = asRecord(event.tokenUsage) ?? {};
  const charged =
    asFiniteNumber(event.chargedCents) ??
    asFiniteNumber(usage.totalCents) ??
    0;
  return {
    timestamp,
    model,
    kind: asString(event.kind) ?? "stop",
    conversationId: asString(event.conversationId),
    isHeadless: event.isHeadless === true,
    requestsCosts: asFiniteNumber(event.requestsCosts) ?? 0,
    chargedCents: charged,
    inputTokens: asCount(usage.inputTokens),
    outputTokens: asCount(usage.outputTokens),
    cacheReadTokens: asCount(usage.cacheReadTokens),
    cacheWriteTokens: asCount(usage.cacheWriteTokens),
  };
}

function asPercent(value: number | null): number | null {
  if (value === null) return null;
  return value <= 1 ? value * 100 : value;
}

function centsToUsd(value: number | null): number | null {
  return value === null ? null : value / 100;
}

export function parseCursorLimits(
  periodPayload: unknown,
  planPayload: unknown,
  email: string | null,
  capturedAt: number,
): ProviderLimits | null {
  const period = asRecord(periodPayload);
  if (!period) return null;
  const planUsage = asRecord(period.planUsage) ?? {};
  const planInfo = asRecord(asRecord(planPayload)?.planInfo) ?? {};
  const spendLimit = asRecord(period.spendLimitUsage) ?? {};

  const totalSpend = centsToUsd(asFiniteNumber(planUsage.totalSpend));
  const includedLimit =
    centsToUsd(asFiniteNumber(planUsage.limit)) ??
    centsToUsd(asFiniteNumber(planInfo.includedAmountCents));
  const remaining = centsToUsd(asFiniteNumber(planUsage.remaining));
  const resetsAt = parseCursorTime(period.billingCycleEnd) ?? parseCursorTime(planInfo.billingCycleEnd);
  const totalPercent = asPercent(asFiniteNumber(planUsage.totalPercentUsed));

  const windows: LimitWindow[] = [];
  if (totalSpend !== null || includedLimit !== null) {
    const used = totalSpend ?? 0;
    const limit = includedLimit;
    const usedFraction =
      limit !== null && limit > 0 ? used / limit : totalPercent === null ? null : totalPercent / 100;
    windows.push({
      id: "cursor:included",
      label: "Included usage",
      unit: "usd",
      status: "ok",
      used,
      limit,
      remaining: remaining ?? (limit === null ? null : Math.max(0, limit - used)),
      usedFraction,
      resetsAt,
    });
  }

  const pooledLimit = centsToUsd(asFiniteNumber(spendLimit.pooledLimit));
  const pooledUsed = centsToUsd(asFiniteNumber(spendLimit.pooledUsed));
  if (pooledLimit !== null && pooledLimit > 0) {
    const used = pooledUsed ?? 0;
    windows.push({
      id: "cursor:spend-limit",
      label: "Spend limit",
      unit: "usd",
      status: "ok",
      used,
      limit: pooledLimit,
      remaining: centsToUsd(asFiniteNumber(spendLimit.pooledRemaining)) ?? Math.max(0, pooledLimit - used),
      usedFraction: used / pooledLimit,
      resetsAt,
    });
  }

  if (windows.length === 0) return null;
  const notes: string[] = [];
  const display = asString(period.displayMessage);
  if (display) notes.push(display);
  notes.push("Cursor usage is billed on Cursor's cycle, not calendar months.");

  return {
    provider: "cursor",
    account: email,
    plan: asString(planInfo.planName),
    fetchedAt: capturedAt,
    windows,
    notes,
  };
}

export function cursorEventId(event: CursorUsageEvent): string {
  return [
    event.conversationId ?? "none",
    String(event.timestamp),
    event.model,
    String(event.inputTokens),
    String(event.outputTokens),
    String(event.cacheReadTokens),
    String(event.cacheWriteTokens),
  ].join(":");
}

export function cursorSessionFile(event: CursorUsageEvent): string {
  return event.conversationId ? `cursor://${event.conversationId}` : "cursor://unattributed";
}

export interface CursorConversation {
  folder: string;
  path: string | null;
  userText: string | null;
}

function pathToCursorSlug(path: string): string {
  return path.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "-");
}

function readWorkspacePaths(root: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(root)) return map;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return map;
  }
  for (const entry of entries) {
    const file = join(root, entry, "workspace.json");
    if (!existsSync(file)) continue;
    try {
      const parsed = asRecord(JSON.parse(readFileSync(file, "utf8")));
      const folder = asString(parsed?.folder);
      if (!folder?.startsWith("file:")) continue;
      const path = fileURLToPath(folder);
      if (path.length > 0) map.set(pathToCursorSlug(path), path);
    } catch {
      // A workspace folder can be missing or unreadable after the window closed.
    }
  }
  return map;
}

function extractCursorUserText(value: unknown): string | null {
  const entry = asRecord(value);
  if (!entry) return null;
  if (asString(entry.role) !== "user") return null;
  const message = entry.message ?? entry;
  const record = asRecord(message);
  if (!record || !("content" in record)) return null;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return null;
  const text: string[] = [];
  for (const item of record.content) {
    const block = asRecord(item);
    if (asString(block?.type) === "text" && asString(block?.text)) text.push(String(block?.text));
  }
  return text.length === 0 ? null : text.join("\n");
}

function readTranscriptUserText(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const text = extractCursorUserText(parsed);
      if (text) return text;
    }
  } catch {
    return null;
  }
  return null;
}

export function indexCursorConversations(
  projectsRoot = cursorProjectsRoot(),
  workspaceStorageRoot = cursorWorkspaceStorageRoot(),
): Map<string, CursorConversation> {
  const conversations = new Map<string, CursorConversation>();
  const paths = readWorkspacePaths(workspaceStorageRoot);
  if (!existsSync(projectsRoot)) return conversations;

  let projects: string[] = [];
  try {
    projects = readdirSync(projectsRoot);
  } catch {
    return conversations;
  }

  for (const folder of projects) {
    const transcriptsRoot = join(projectsRoot, folder, "agent-transcripts");
    if (!existsSync(transcriptsRoot)) continue;
    let transcripts: string[] = [];
    try {
      transcripts = readdirSync(transcriptsRoot);
    } catch {
      continue;
    }
    const path = paths.get(folder) ?? null;
    for (const conversationId of transcripts) {
      const directory = join(transcriptsRoot, conversationId);
      const preferred = join(directory, `${conversationId}.jsonl`);
      let userText = readTranscriptUserText(preferred);
      if (userText === null && existsSync(directory)) {
        try {
          for (const file of readdirSync(directory)) {
            if (!file.endsWith(".jsonl")) continue;
            userText = readTranscriptUserText(join(directory, file));
            if (userText) break;
          }
        } catch {
          // Leave the conversation unclassified when the transcript cannot be read.
        }
      }
      conversations.set(conversationId, { folder, path, userText });
    }
  }
  return conversations;
}

export async function fetchCursorUsageEvents(sinceTimestamp: number | null): Promise<{
  events: CursorUsageEvent[];
  warning: string | null;
}> {
  if (!cursorLooksInstalled()) return { events: [], warning: null };
  const auth = resolveCursorAuth();
  if (!auth) return { events: [], warning: AUTH_FAILURE };

  const fetched = await withCursorToken(auth, async (accessToken) => {
    const events: CursorUsageEvent[] = [];
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body: Record<string, unknown> = { page, pageSize: PAGE_SIZE };
      if (sinceTimestamp !== null) body.startDate = String(sinceTimestamp);
      const { status, payload } = await dashboardPost(
        accessToken,
        "/aiserver.v1.DashboardService/GetFilteredUsageEvents",
        body,
      );
      if (status < 200 || status >= 300) return { status, value: null };
      const root = asRecord(payload) ?? {};
      const rows = Array.isArray(root.usageEventsDisplay) ? root.usageEventsDisplay : [];
      for (const row of rows) {
        const event = parseCursorUsageEvent(row);
        if (event) events.push(event);
      }
      if (rows.length < PAGE_SIZE) return { status: 200, value: { events, truncated: false } };
      const total = asCount(root.totalUsageEventsCount);
      if (total > 0 && events.length >= total) return { status: 200, value: { events, truncated: false } };
      if (page === MAX_PAGES) truncated = true;
    }
    return { status: 200, value: { events, truncated } };
  });

  if (fetched.value === null) return { events: [], warning: fetched.warning };
  const warning = fetched.value.truncated
    ? "Imported the most recent Cursor events; older history was skipped."
    : fetched.warning;
  return { events: fetched.value.events, warning };
}

export async function fetchCursorLimits(): Promise<{
  report: ProviderLimits | null;
  warning: string | null;
}> {
  if (!cursorLooksInstalled()) return { report: null, warning: null };
  const auth = resolveCursorAuth();
  if (!auth) return { report: null, warning: AUTH_FAILURE };

  const fetched = await withCursorToken(auth, async (accessToken) => {
    const period = await dashboardPost(accessToken, "/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {});
    if (period.status < 200 || period.status >= 300) return { status: period.status, value: null };
    const plan = await dashboardPost(accessToken, "/aiserver.v1.DashboardService/GetPlanInfo", {});
    return {
      status: 200,
      value: parseCursorLimits(period.payload, plan.status >= 200 && plan.status < 300 ? plan.payload : {}, auth.email, Date.now()),
    };
  });

  if (fetched.value) return { report: fetched.value, warning: fetched.warning };
  return { report: null, warning: fetched.warning ?? "Cursor usage returned an unexpected shape." };
}

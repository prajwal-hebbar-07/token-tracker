import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

export interface LimitWindow {
  id: string;
  label: string;
  unit: string;
  status: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  usedFraction: number | null;
  resetsAt: number | null;
}

export interface ProviderLimits {
  provider: string;
  account: string | null;
  plan: string | null;
  fetchedAt: number | null;
  windows: LimitWindow[];
  notes: string[];
}

export interface LimitsSnapshot {
  capturedAt: number;
  generatedAt: number | null;
  providers: ProviderLimits[];
}

// Hang guard only. Session sync is incremental and usage reports are cached by
// Oh My Pi, so both calls normally return in about a second.
const TIMEOUT_MS = 600_000;
const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";
const OLLAMA_TIMEOUT_MS = 10_000;

interface OmpRun {
  stdout: string;
  warning: string | null;
}

function lastLine(text: string | null): string | null {
  if (!text) return null;
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length > 0) return line.length > 300 ? `${line.slice(0, 300)}…` : line;
  }
  return null;
}

/**
 * Runs an Oh My Pi subcommand. Never throws: every failure becomes a warning so
 * one unavailable command cannot take down the rest of an import.
 *
 * `capture` is off for commands whose stdout is not needed, because `spawnSync`
 * buffers captured output and would report ENOBUFS on a large but successful run.
 */
function runOmp(args: string[], { capture }: { capture: boolean }): OmpRun {
  const binary = process.env.OMP_BIN ?? "omp";
  const command = `${binary} ${args.join(" ")}`;
  const child = spawnSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
    timeout: TIMEOUT_MS,
  });
  const stdout = capture ? (child.stdout ?? "") : "";

  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? `\`${binary}\` was not found. Set OMP_BIN to the Oh My Pi binary path.`
        : code === "ETIMEDOUT"
          ? `\`${command}\` did not finish within ${TIMEOUT_MS / 1_000}s.`
          : `\`${command}\` failed to start: ${child.error.message}`;
    return { stdout, warning: reason };
  }

  if (child.status !== 0) {
    const exit = child.signal ? `signal ${child.signal}` : `exit code ${child.status}`;
    const detail = lastLine(child.stderr);
    return { stdout, warning: `\`${command}\` exited with ${exit}${detail ? `: ${detail}` : ""}` };
  }

  return { stdout, warning: null };
}

/**
 * Runs Oh My Pi's own session-to-stats sync so the import reads current data.
 *
 * `~/.omp/stats.db` is not written by running Oh My Pi sessions. It only advances
 * when `omp stats` tails `~/.omp/agent/sessions/` into it, so importing without
 * this step re-reads whatever snapshot the last manual `omp stats` left behind.
 * `--json` performs that sync, prints, and exits; its stdout is not needed here.
 *
 * Returns a warning when the sync could not run, in which case the caller still
 * imports the existing snapshot: a stale import beats no import.
 */
export function syncOmpSessions(): string | null {
  const { warning } = runOmp(["stats", "--json"], { capture: false });
  return warning === null ? null : `${warning}. Imported the existing snapshot, which may be stale.`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const notes: string[] = [];
  for (const entry of value) {
    const note = asString(entry);
    if (note) notes.push(note);
  }
  return notes;
}

function parseWindow(value: unknown): LimitWindow | null {
  const limit = asRecord(value);
  if (!limit) return null;
  const amount = asRecord(limit.amount) ?? {};
  const window = asRecord(limit.window);
  const id = asString(limit.id);
  if (!id) return null;
  return {
    id,
    label: asString(limit.label) ?? asString(window?.label) ?? id,
    unit: asString(amount.unit) ?? "count",
    status: asString(limit.status) ?? "unknown",
    used: asNumber(amount.used),
    limit: asNumber(amount.limit),
    remaining: asNumber(amount.remaining),
    usedFraction: asNumber(amount.usedFraction),
    resetsAt: asNumber(window?.resetsAt),
  };
}

function parseReport(value: unknown): ProviderLimits | null {
  const report = asRecord(value);
  if (!report) return null;
  const provider = asString(report.provider);
  if (!provider) return null;
  const metadata = asRecord(report.metadata) ?? {};
  const windows: LimitWindow[] = [];
  if (Array.isArray(report.limits)) {
    for (const entry of report.limits) {
      const window = parseWindow(entry);
      if (window) windows.push(window);
    }
  }
  return {
    provider,
    account: asString(metadata.email) ?? asString(metadata.accountId),
    plan: asString(metadata.planType),
    fetchedAt: asNumber(report.fetchedAt),
    windows,
    notes: asNotes(report.notes),
  };
}
function getOllamaApiKey(): string | null {
  const environmentKey = asString(process.env.OLLAMA_API_KEY);
  if (environmentKey) return environmentKey;

  const databasePath =
    process.env.OMP_AGENT_DB ?? join(homedir(), ".omp", "agent", "agent.db");
  if (!existsSync(databasePath)) return null;

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database.prepare(`
      SELECT data
      FROM auth_credentials
      WHERE provider = 'ollama-cloud' AND disabled_cause IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `).get();
    if (!row || typeof row.data !== "string") return null;
    const credential = asRecord(JSON.parse(row.data));
    return asString(credential?.key);
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function parseOllamaWindow(
  id: "session" | "weekly",
  label: string,
  value: unknown,
): LimitWindow | null {
  const usage = asNumber(asRecord(value)?.usage);
  if (usage === null || usage < 0) return null;
  const used = usage * 100;
  return {
    id: `ollama-cloud:${id}`,
    label,
    unit: "percent",
    status: "ok",
    used,
    limit: 100,
    remaining: Math.max(0, 100 - used),
    usedFraction: usage,
    resetsAt: null,
  };
}

function parseOllamaUsage(value: unknown): ProviderLimits | null {
  const limits = asRecord(asRecord(value)?.limits);
  if (!limits) return null;
  const windows = [
    parseOllamaWindow("session", "Session", limits.session),
    parseOllamaWindow("weekly", "Weekly", limits.weekly),
  ].filter((window): window is LimitWindow => window !== null);
  if (windows.length === 0) return null;
  return {
    provider: "ollama-cloud",
    account: null,
    plan: null,
    fetchedAt: Date.now(),
    windows,
    notes: ["Ollama's usage endpoint does not expose reset times."],
  };
}

async function readOllamaCloudLimits(): Promise<{
  report: ProviderLimits | null;
  warning: string | null;
}> {
  const apiKey = getOllamaApiKey();
  if (!apiKey) return { report: null, warning: null };

  let response: Response;
  try {
    response = await fetch(OLLAMA_USAGE_URL, {
      headers: { Accept: "application/json", Authorization: apiKey },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "request failed";
    return { report: null, warning: `Could not read Ollama Cloud usage: ${detail}.` };
  }
  if (!response.ok) {
    return {
      report: null,
      warning: `Ollama Cloud usage returned HTTP ${response.status}.`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { report: null, warning: "Ollama Cloud usage did not return JSON." };
  }
  const report = parseOllamaUsage(payload);
  return report
    ? { report, warning: null }
    : { report: null, warning: "Ollama Cloud usage returned an unexpected shape." };
}


/**
 * Reads provider quota limits via Oh My Pi, then fills Ollama Cloud's missing
 * report from Ollama's account usage endpoint.
 */
export async function readProviderLimits(): Promise<{
  snapshot: LimitsSnapshot | null;
  warning: string | null;
}> {
  const { stdout, warning } = runOmp(["usage", "--json"], { capture: true });
  if (warning !== null) return { snapshot: null, warning: `${warning}. Kept the previous limits.` };

  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return { snapshot: null, warning: "`omp usage --json` did not return JSON. Kept the previous limits." };
  }

  const root = asRecord(payload);
  if (!root || !Array.isArray(root.reports)) {
    return { snapshot: null, warning: "`omp usage --json` returned an unexpected shape. Kept the previous limits." };
  }

  const providers: ProviderLimits[] = [];
  for (const entry of root.reports) {
    const report = parseReport(entry);
    if (report) providers.push(report);
  }
  const ollama = await readOllamaCloudLimits();
  if (ollama.report) {
    const index = providers.findIndex((provider) => provider.provider === "ollama-cloud");
    if (index === -1) providers.push(ollama.report);
    else providers[index] = ollama.report;
  }

  return {
    snapshot: { capturedAt: Date.now(), generatedAt: asNumber(root.generatedAt), providers },
    warning: ollama.warning,
  };
}

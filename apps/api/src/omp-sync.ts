import { spawnSync } from "node:child_process";

export interface SessionSyncResult {
  command: string;
  durationMs: number;
  warning: string | null;
}

// `~/.omp/stats.db` is not written by running Oh My Pi sessions. It only advances
// when `omp stats` tails `~/.omp/agent/sessions/` into it, so importing without
// this step re-reads whatever snapshot the last manual `omp stats` left behind.
// `--json` performs that sync, prints, and exits; its stdout is not needed here.
const SYNC_ARGS = ["stats", "--json"];

// Hang guard only. The tail is incremental, so a caught-up sync takes seconds.
const SYNC_TIMEOUT_MS = 600_000;

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
 * Runs Oh My Pi's own session-to-stats sync so the import reads current data.
 *
 * Never throws: a missing or failing `omp` binary degrades to importing the
 * existing snapshot with a warning, because a stale import beats no import.
 */
export function syncOmpSessions(): SessionSyncResult {
  const binary = process.env.OMP_BIN ?? "omp";
  const command = `${binary} ${SYNC_ARGS.join(" ")}`;
  const startedAt = Date.now();
  const child = spawnSync(binary, SYNC_ARGS, {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: SYNC_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;
  const detail = lastLine(child.stderr);

  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? `\`${binary}\` was not found. Set OMP_BIN to the Oh My Pi binary path.`
        : code === "ETIMEDOUT"
          ? `\`${command}\` did not finish within ${SYNC_TIMEOUT_MS / 1_000}s.`
          : `\`${command}\` failed to start: ${child.error.message}`;
    return { command, durationMs, warning: `${reason} Imported the existing snapshot, which may be stale.` };
  }

  if (child.status !== 0) {
    const exit = child.signal ? `signal ${child.signal}` : `exit code ${child.status}`;
    const suffix = detail ? `: ${detail}` : "";
    return {
      command,
      durationMs,
      warning: `\`${command}\` exited with ${exit}${suffix}. Imported the existing snapshot, which may be stale.`,
    };
  }

  return { command, durationMs, warning: null };
}

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { serveTrackerDashboard } from "@token-tracker/api/dist/dashboard-host.js";

const DEFAULT_PORT = 17333;

let started: { url: string; close: () => void } | undefined;

export function resolveDashboardBundleRoot(): string | null {
  const override = process.env.TOKEN_TRACKER_WEB;
  if (override) return existsSync(join(override, "index.html")) ? override : null;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "web"), join(here, "..", "..", "web", "out")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

/**
 * Serves the same dashboard the desktop app and editor panel use, on loopback,
 * so Cursor's Browser pane can show it. Reuses a single bind for the MCP
 * process lifetime.
 */
export async function ensureDashboard(tracker: DatabaseSync): Promise<{ url: string }> {
  if (started) return { url: started.url };
  const bundleRoot = resolveDashboardBundleRoot();
  if (bundleRoot === null) {
    throw new Error("Dashboard files are missing. Reinstall Token Tracker MCP from the GitHub release, or run `pnpm --filter @token-tracker/mcp build`.");
  }
  const preferred = Number(process.env.TOKEN_TRACKER_PORT ?? DEFAULT_PORT);
  try {
    const handle = await serveTrackerDashboard(tracker, bundleRoot, {
      port: Number.isFinite(preferred) ? preferred : DEFAULT_PORT,
      closeTrackerOnStop: false,
    });
    started = { url: `http://127.0.0.1:${handle.port}`, close: handle.close };
    return { url: started.url };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "EADDRINUSE") throw error;
    const handle = await serveTrackerDashboard(tracker, bundleRoot, { port: 0, closeTrackerOnStop: false });
    started = { url: `http://127.0.0.1:${handle.port}`, close: handle.close };
    return { url: started.url };
  }
}

export function stopDashboard(): void {
  started?.close();
  started = undefined;
}

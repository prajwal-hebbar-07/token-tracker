import { createServer, type ServerResponse } from "node:http";
import {
  getDashboard,
  getProjects,
  type ImportResult,
  importFromOmp,
  openTrackerDatabase,
  saveLimitsSnapshot,
} from "./db.js";
import { readProviderLimits, syncOmpSessions } from "./omp-cli.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
const tracker = openTrackerDatabase();

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": process.env.WEB_ORIGIN ?? "http://localhost:3000",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

  if (request.method === "OPTIONS") {
    sendJson(response, 204, null);
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      const period = url.searchParams.get("period") ?? "all";
      if (period !== "today" && period !== "month" && period !== "all") {
        sendJson(response, 400, { error: "period must be today, month, or all" });
        return;
      }
      sendJson(response, 200, getDashboard(tracker, period));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      const period = url.searchParams.get("period") ?? "all";
      if (period !== "today" && period !== "month" && period !== "all") {
        sendJson(response, 400, { error: "period must be today, month, or all" });
        return;
      }
      sendJson(response, 200, getProjects(tracker, period));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/import") {
      const warnings: string[] = [];
      const syncWarning = syncOmpSessions();
      if (syncWarning) warnings.push(syncWarning);

      let result: ImportResult;
      try {
        result = importFromOmp(tracker);
      } catch (error) {
        if (!syncWarning) throw error;
        const message = error instanceof Error ? error.message : "Import failed";
        throw new Error(`${message} (session sync also failed: ${syncWarning})`);
      }

      const limits = await readProviderLimits();
      if (limits.warning) warnings.push(limits.warning);
      if (limits.snapshot) saveLimitsSnapshot(tracker, limits.snapshot);

      sendJson(response, 200, { result, warnings, dashboard: getDashboard(tracker) });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error(error);
    sendJson(response, 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`Token Tracker API listening at http://${host}:${port}`);
});

function shutDown(): void {
  server.close(() => {
    tracker.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);

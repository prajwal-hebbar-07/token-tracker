import { createServer, type ServerResponse } from "node:http";
import {
  getDashboard,
  getModels,
  getProjects,
  type ImportResult,
  importFromOmp,
  isDashboardPeriod,
  openTrackerDatabase,
  readPreferences,
  saveLimitsSnapshot,
  savePreferences,
} from "./db.js";
import { readProviderLimits, syncOmpSessions } from "./omp-cli.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
const tracker = openTrackerDatabase();

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
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

    if (request.method === "GET" && (url.pathname === "/api/dashboard" || url.pathname === "/api/models" || url.pathname === "/api/projects")) {
      const period = url.searchParams.get("period") ?? "all";
      if (!isDashboardPeriod(period)) {
        sendJson(response, 400, { error: "period must be today, month, all, or a YYYY-MM-DD date" });
        return;
      }
      const payload = url.pathname === "/api/dashboard"
        ? getDashboard(tracker, period)
        : url.pathname === "/api/models"
          ? getModels(tracker, period)
          : getProjects(tracker, period);
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/import") {
      const stage = url.searchParams.get("stage");
      const validStages = ["sessions", "usage", "limits"];
      if (stage !== null && !validStages.includes(stage)) {
        sendJson(response, 400, { error: "stage must be sessions, usage, or limits" });
        return;
      }

      const warnings: string[] = [];
      let result: ImportResult | undefined;

      if (stage === null || stage === "sessions") {
        const syncWarning = syncOmpSessions();
        if (syncWarning) warnings.push(syncWarning);
      }

      if (stage === null || stage === "usage") {
        try {
          result = importFromOmp(tracker);
        } catch (error) {
          if (stage !== null) {
            const message = error instanceof Error ? error.message : "Import failed";
            throw new Error(message);
          }
          // In the full-run path, preserve the original behavior of including the
          // session-sync warning when the usage import fails.
          const syncWarning = warnings[0];
          if (!syncWarning) throw error;
          const message = error instanceof Error ? error.message : "Import failed";
          throw new Error(`${message} (session sync also failed: ${syncWarning})`);
        }
      }

      if (stage === null || stage === "limits") {
        const limits = await readProviderLimits();
        if (limits.warning) warnings.push(limits.warning);
        if (limits.snapshot) saveLimitsSnapshot(tracker, limits.snapshot);
      }

      sendJson(response, 200, { result, warnings, dashboard: getDashboard(tracker) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/preferences") {
      sendJson(response, 200, readPreferences(tracker));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/preferences") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(response, 400, { error: "preferences must be a JSON object" });
        return;
      }
      if (!parsed || typeof parsed !== "object" || !("hiddenLimits" in parsed) || !Array.isArray(parsed.hiddenLimits)) {
        sendJson(response, 400, { error: "preferences must be a JSON object" });
        return;
      }
      const preferences = {
        hiddenLimits: parsed.hiddenLimits.filter((entry): entry is string => typeof entry === "string"),
      };
      savePreferences(tracker, preferences);
      sendJson(response, 200, preferences);
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

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import {
  getDashboard,
  getModels,
  getProjects,
  isDashboardPeriod,
  readPreferences,
  savePreferences,
} from "./db.js";
import { isImportStage, runImport } from "./import.js";

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Origin": process.env.WEB_ORIGIN ?? "http://localhost:3000",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

/**
 * Answers `/health` and `/api/*` against one tracker database, and reports
 * whether it answered at all. A host that also serves the dashboard bundle from
 * the same origin — the VS Code extension does — falls through to its own static
 * handling when this returns false, so both hosts share one copy of the routes.
 */
export async function handleApiRequest(
  tracker: DatabaseSync,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const isApi = url.pathname === "/health" || url.pathname.startsWith("/api/");
  if (!isApi) return false;

  if (request.method === "OPTIONS") {
    sendJson(response, 204, null);
    return true;
  }

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return true;
    }

    if (request.method === "GET" && (url.pathname === "/api/dashboard" || url.pathname === "/api/models" || url.pathname === "/api/projects")) {
      const period = url.searchParams.get("period") ?? "all";
      if (!isDashboardPeriod(period)) {
        sendJson(response, 400, { error: "period must be today, month, all, or a YYYY-MM-DD date" });
        return true;
      }
      const payload = url.pathname === "/api/dashboard"
        ? getDashboard(tracker, period)
        : url.pathname === "/api/models"
          ? getModels(tracker, period)
          : getProjects(tracker, period);
      sendJson(response, 200, payload);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/import") {
      const stage = url.searchParams.get("stage");
      if (stage !== null && !isImportStage(stage)) {
        sendJson(response, 400, { error: "stage must be sessions, usage, cursor, or limits" });
        return true;
      }

      const { result, warnings } = await runImport(tracker, stage);
      sendJson(response, 200, { result, warnings, dashboard: getDashboard(tracker) });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/preferences") {
      sendJson(response, 200, readPreferences(tracker));
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/preferences") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(response, 400, { error: "preferences must be a JSON object" });
        return true;
      }
      if (!parsed || typeof parsed !== "object" || !("hiddenLimits" in parsed) || !Array.isArray(parsed.hiddenLimits)) {
        sendJson(response, 400, { error: "preferences must be a JSON object" });
        return true;
      }
      const preferences = {
        hiddenLimits: parsed.hiddenLimits.filter((entry): entry is string => typeof entry === "string"),
      };
      savePreferences(tracker, preferences);
      sendJson(response, 200, preferences);
      return true;
    }

    sendJson(response, 404, { error: "Not found" });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error(error);
    sendJson(response, 500, { error: message });
    return true;
  }
}

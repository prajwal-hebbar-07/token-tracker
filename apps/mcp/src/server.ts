#!/usr/bin/env node
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  type DashboardPeriod,
  getDashboard,
  getModels,
  getProjects,
  isDashboardPeriod,
  openTrackerDatabase,
} from "@token-tracker/api/dist/db.js";
import { runImport } from "@token-tracker/api/dist/import.js";
import { formatImport, formatUsage } from "./format.js";
import { resolveTrackerDatabasePath } from "./paths.js";

const FALLBACK_PROTOCOL = "2025-03-26";
const SERVER_INFO = { name: "token-tracker", version: "1.2.0" };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const TOOLS = [
  {
    name: "refresh_usage",
    description:
      "Import the latest Oh My Pi and Cursor token usage into the local tracker, then refresh provider quotas. Call this before answering spend questions when the user wants current numbers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_usage",
    description:
      "Read saved token usage, spend, model mix, projects, and account limits. period is today, month, all, or a YYYY-MM-DD date. Defaults to month.",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          description: "today, month, all, or a YYYY-MM-DD date",
        },
      },
      additionalProperties: false,
    },
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function periodFrom(params: unknown): DashboardPeriod {
  const period = asRecord(params)?.period;
  if (typeof period !== "string" || period.length === 0) return "month";
  if (!isDashboardPeriod(period)) {
    throw new Error("period must be today, month, all, or a YYYY-MM-DD date");
  }
  return period;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textResult(text: string, isError = false): unknown {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export async function dispatch(
  tracker: DatabaseSync,
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const method = message.method;
  if (method === undefined) {
    if (message.id === undefined) return null;
    return fail(message.id ?? null, -32600, "Invalid request");
  }

  if (message.id === undefined) return null;

  const id = message.id;

  try {
    if (method === "initialize") {
      const requested = asRecord(message.params)?.protocolVersion;
      return ok(id, {
        protocolVersion: typeof requested === "string" ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === "ping") return ok(id, {});
    if (method === "tools/list") return ok(id, { tools: TOOLS });
    if (method === "resources/list") return ok(id, { resources: [] });
    if (method === "prompts/list") return ok(id, { prompts: [] });
    if (method === "tools/call") {
      const params = asRecord(message.params);
      const name = typeof params?.name === "string" ? params.name : "";
      const args = params?.arguments;
      if (name === "refresh_usage") {
        const imported = await runImport(tracker);
        return ok(id, textResult(formatImport(imported.warnings, imported.result?.newRecords)));
      }
      if (name === "get_usage") {
        const period = periodFrom(args);
        return ok(
          id,
          textResult(
            formatUsage(period, getDashboard(tracker, period), getModels(tracker, period), getProjects(tracker, period)),
          ),
        );
      }
      return fail(id, -32601, `Unknown tool: ${name}`);
    }
    return fail(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unexpected MCP error";
    if (method === "tools/call") return ok(id, textResult(detail, true));
    return fail(id, -32000, detail);
  }
}

export function startStdio(tracker: DatabaseSync): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const shutDown = (): void => {
    try {
      tracker.close();
    } catch {
      // Already closed.
    }
    process.exit(0);
  };
  process.on("SIGINT", shutDown);
  process.on("SIGTERM", shutDown);
  lines.on("close", shutDown);
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(fail(null, -32700, "Parse error"))}\n`);
      return;
    }
    const request = asRecord(parsed) ?? {};
    void dispatch(tracker, {
      jsonrpc: typeof request.jsonrpc === "string" ? request.jsonrpc : undefined,
      id: "id" in request ? (request.id as string | number | null) : undefined,
      method: typeof request.method === "string" ? request.method : undefined,
      params: request.params,
    }).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : "Unexpected MCP error";
      process.stderr.write(`${detail}\n`);
    });
  });
}

function main(): void {
  startStdio(openTrackerDatabase(resolveTrackerDatabasePath()));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openTrackerDatabase } from "./db.js";
import { handleApiRequest, sendJson } from "./handler.js";

const contentTypes: Record<string, string> = {
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/vnd.microsoft.icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

function readUnder(root: string, relative: string): Buffer | null {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(root + sep)) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Resolves a request path against the exported dashboard bundle.
 *
 * Next writes both `projects.html` and `projects/index.html` depending on the
 * route, so both shapes are tried. A path that names no file and no extension is
 * a client-side route, which the shell page answers.
 */
export function staticReply(
  root: string,
  pathname: string,
): { status: number; body: Buffer; contentType: string; cacheControl: string } {
  const trimmed = pathname.replace(/^\/+/, "");
  const candidates = trimmed === ""
    ? ["index.html"]
    : [trimmed, `${trimmed}.html`, `${trimmed}/index.html`];

  for (const candidate of candidates) {
    const body = readUnder(root, candidate);
    if (body) {
      const extension = candidate.slice(candidate.lastIndexOf(".") + 1);
      return {
        status: 200,
        body,
        contentType: contentTypes[extension] ?? "application/octet-stream",
        cacheControl: candidate.startsWith("_next/static/") ? "public, max-age=31536000, immutable" : "no-store",
      };
    }
  }

  const looksLikeAsset = trimmed.startsWith("_next/") || trimmed.slice(trimmed.lastIndexOf("/") + 1).includes(".");
  const fallback = looksLikeAsset ? null : readUnder(root, "index.html");
  if (fallback) {
    return { status: 200, body: fallback, contentType: "text/html; charset=utf-8", cacheControl: "no-store" };
  }

  const notFound = readUnder(root, "404.html");
  return notFound
    ? { status: 404, body: notFound, contentType: "text/html; charset=utf-8", cacheControl: "no-store" }
    : { status: 404, body: Buffer.from("Not found"), contentType: "text/plain; charset=utf-8", cacheControl: "no-store" };
}

export interface Dashboard {
  port: number;
  close: () => void;
}

export interface ServeDashboardOptions {
  port?: number;
  host?: string;
  closeTrackerOnStop?: boolean;
}

/**
 * Serves the dashboard bundle and `/api` from one loopback origin. Relative
 * `fetch("/api/…")` calls from the page stay on that origin.
 */
export function serveTrackerDashboard(
  tracker: DatabaseSync,
  bundleRoot: string,
  options: ServeDashboardOptions = {},
): Promise<Dashboard> {
  const root = resolve(bundleRoot);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const closeTrackerOnStop = options.closeTrackerOnStop === true;

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (await handleApiRequest(tracker, request, response, url)) return;

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const reply = staticReply(root, decodeURIComponent(url.pathname));
    response.writeHead(reply.status, {
      "Cache-Control": reply.cacheControl,
      "Content-Length": reply.body.byteLength,
      "Content-Type": reply.contentType,
    });
    response.end(request.method === "HEAD" ? undefined : reply.body);
  });

  return new Promise<Dashboard>((fulfil, reject) => {
    server.once("error", (error) => {
      if (closeTrackerOnStop) tracker.close();
      reject(error);
    });
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        if (closeTrackerOnStop) tracker.close();
        reject(new Error("The dashboard server bound no port."));
        return;
      }
      fulfil({
        port: address.port,
        close: () => {
          server.close();
          if (closeTrackerOnStop) tracker.close();
        },
      });
    });
  });
}

/**
 * Opens a tracker database and serves the dashboard. Used by the editor
 * extension, which owns that file for the life of the panel.
 */
export function startDashboard(bundleRoot: string, databasePath: string): Promise<Dashboard> {
  return serveTrackerDashboard(openTrackerDatabase(databasePath), bundleRoot, {
    port: 0,
    closeTrackerOnStop: true,
  });
}

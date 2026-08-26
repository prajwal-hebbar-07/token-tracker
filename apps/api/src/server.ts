import { createServer } from "node:http";
import { openTrackerDatabase } from "./db.js";
import { handleApiRequest, sendJson } from "./handler.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
const tracker = openTrackerDatabase();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  if (await handleApiRequest(tracker, request, response, url)) return;
  sendJson(response, 404, { error: "Not found" });
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

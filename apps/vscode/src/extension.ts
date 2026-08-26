import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { type Dashboard, startDashboard } from "./server.js";

// The panel shows the dashboard in an iframe pointed at the extension's own
// loopback server, because that is the only way the exported bundle reaches its
// own /api on one origin. Webview resource URIs would give the page a different
// origin from its data and break every relative fetch in it.

let dashboard: Dashboard | undefined;
let panel: vscode.WebviewPanel | undefined;

async function open(context: vscode.ExtensionContext): Promise<void> {
  if (dashboard === undefined) {
    // globalStorageUri is per install and outlives the window, which is what the
    // stored preferences and the imported usage need. Its directory is not
    // created for us.
    mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    dashboard = await startDashboard(
      join(context.extensionPath, "media", "web"),
      join(context.globalStorageUri.fsPath, "token-tracker.sqlite"),
    );
  }

  if (panel !== undefined) {
    panel.reveal();
    return;
  }

  panel = vscode.window.createWebviewPanel("tokenTracker.dashboard", "Token Tracker", vscode.ViewColumn.Active, {
    enableScripts: true,
    // The page holds a fetched report and a period selection, so a hidden tab
    // that reloads from scratch would throw away both and re-run the import.
    retainContextWhenHidden: true,
  });
  panel.onDidDispose(() => {
    panel = undefined;
  });

  // asExternalUri keeps the panel working over Remote SSH and Codespaces, where
  // the port has to be forwarded before the webview can reach it.
  const source = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${dashboard.port}`));
  panel.webview.html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <!-- style-src has to be spelled out: without it the default-src fallback is
         'none', which blocks this stylesheet and leaves the iframe at its 300x150
         intrinsic size inside the 20px body padding the webview host injects. -->
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src ${source.scheme}://${source.authority};" />
    <style>
      /* Fixed rather than a percentage-height chain, so the panel is filled edge
         to edge whatever the host's own body padding is. */
      iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
    </style>
  </head>
  <body><iframe src="${source.toString()}" title="Token Tracker"></iframe></body>
</html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTracker.open", async () => {
      try {
        await open(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Token Tracker failed to start.";
        void vscode.window.showErrorMessage(`Token Tracker: ${message}`);
      }
    }),
  );
}

export function deactivate(): void {
  dashboard?.close();
  dashboard = undefined;
}

import type { DatabaseSync } from "node:sqlite";
import {
  fetchCursorLimits,
  fetchCursorUsageEvents,
  indexCursorConversations,
} from "./cursor.js";
import {
  cursorWatermark,
  type ImportResult,
  importFromCursor,
  importFromOmp,
  overlayProviderLimits,
  saveLimitsSnapshot,
} from "./db.js";
import { readProviderLimits, syncOmpSessions } from "./omp-cli.js";

export const IMPORT_STAGES = ["sessions", "usage", "cursor", "limits"] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];

export function isImportStage(value: string): value is ImportStage {
  return (IMPORT_STAGES as readonly string[]).includes(value);
}

export interface ImportRun {
  result: ImportResult | undefined;
  warnings: string[];
}

/**
 * Runs one import stage, or every stage when `stage` is omitted. Failures from
 * a single source become warnings so Cursor can still import when Oh My Pi is
 * missing, and the other way around.
 */
export async function runImport(
  tracker: DatabaseSync,
  stage: ImportStage | null = null,
): Promise<ImportRun> {
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
      const message = error instanceof Error ? error.message : "Import failed";
      warnings.push(message);
    }
  }

  if (stage === null || stage === "cursor") {
    try {
      const fetched = await fetchCursorUsageEvents(cursorWatermark(tracker));
      if (fetched.warning) warnings.push(fetched.warning);
      if (fetched.events.length > 0) {
        result = importFromCursor(tracker, fetched.events, indexCursorConversations());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not import Cursor usage";
      warnings.push(message);
    }
  }

  if (stage === null || stage === "limits") {
    const limits = await readProviderLimits();
    if (limits.warning) warnings.push(limits.warning);
    let snapshot = limits.snapshot;
    try {
      const cursor = await fetchCursorLimits();
      if (cursor.warning) warnings.push(cursor.warning);
      if (cursor.report) snapshot = overlayProviderLimits(tracker, snapshot, cursor.report);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read Cursor limits";
      warnings.push(message);
    }
    if (snapshot) saveLimitsSnapshot(tracker, snapshot);
  }

  return { result, warnings };
}

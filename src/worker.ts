/// <reference lib="webworker" />
// Postgres lives here, off the main thread. Each version's database is built from the migrations once,
// and every run gets its own clone, so runs never see each other's writes.

import { LabDatabase } from "./engine/database";
import type { Version } from "./engine/migrations";
import { runScenario } from "./engine/scenarios";
import type { RunRequest, RunResponse } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const templates = new Map<Version, Promise<LabDatabase>>();

function template(version: Version): Promise<LabDatabase> {
  let db = templates.get(version);
  if (!db) {
    db = LabDatabase.create(version);
    // A failed build shouldn't stick: drop it so the next run tries again.
    db.catch(() => templates.delete(version));
    templates.set(version, db);
  }
  return db;
}

async function handle({ id, scenarioId, version, persona }: RunRequest): Promise<RunResponse> {
  const started = performance.now();
  try {
    const db = await (await template(version)).clone();
    try {
      const run = await runScenario(db, scenarioId, persona);
      return { id, ok: true, run, elapsedMs: Math.round(performance.now() - started) };
    } finally {
      await db.close();
    }
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// One run at a time: PGlite is single-threaded anyway, and this keeps the order of replies predictable.
let queue: Promise<unknown> = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<RunRequest>) => {
  queue = queue.then(async () => self.postMessage(await handle(event.data)));
});

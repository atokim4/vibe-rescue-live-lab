import type { Persona } from "./engine/personas";
import type { Version } from "./engine/migrations";
import type { ScenarioId, ScenarioRun } from "./engine/scenarios";
import type { RunRequest, RunResponse } from "./protocol";

export interface RunResult {
  run: ScenarioRun;
  elapsedMs: number;
}

/** Talks to the Postgres worker: one promise per request, matched by id. */
export class LabClient {
  private readonly worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private readonly pending = new Map<number, { resolve: (r: RunResult) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor() {
    this.worker.addEventListener("message", (event: MessageEvent<RunResponse>) => {
      const reply = event.data;
      const waiting = this.pending.get(reply.id);
      if (!waiting) return;
      this.pending.delete(reply.id);
      if (reply.ok) waiting.resolve({ run: reply.run, elapsedMs: reply.elapsedMs });
      else waiting.reject(new Error(reply.error));
    });
    this.worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "The database worker failed to start.");
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
    });
  }

  run(scenarioId: ScenarioId, version: Version, persona: Persona): Promise<RunResult> {
    const request: RunRequest = { id: this.nextId++, scenarioId, version, persona };
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }
}

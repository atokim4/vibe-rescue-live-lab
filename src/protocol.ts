import type { Persona } from "./engine/personas";
import type { Version } from "./engine/migrations";
import type { ScenarioId, ScenarioRun } from "./engine/scenarios";

export interface RunRequest {
  id: number;
  scenarioId: ScenarioId;
  version: Version;
  persona: Persona;
}

export type RunResponse =
  { id: number; ok: true; run: ScenarioRun; elapsedMs: number } | { id: number; ok: false; error: string };

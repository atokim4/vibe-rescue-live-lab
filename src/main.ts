import "./styles.css";
import type { Persona } from "./engine/personas";
import { MIGRATIONS, SUPABASE_SHIM, type Version } from "./engine/migrations";
import { SCENARIOS, effectivePersona, type Scenario, type ScenarioRun } from "./engine/scenarios";
import { LabClient } from "./lab-client";
import { h, withCode } from "./ui/dom";
import { stepView, verdictBadge } from "./ui/render";

const REPO = "https://github.com/atokim4/vibe-rescue-nextjs-supabase";
const BUG_ANCHORS: Record<number, string> = {
  2: "2-row-level-security-that-lets-everyone-read-everything",
  3: "3-stripe-webhook-that-never-upgrades-anyone-and-trusts-anybody",
  6: "6-paywall-that-only-exists-in-the-ui",
};

const PERSONAS: { id: Persona; label: string; hint: string }[] = [
  { id: "anon", label: "Anonymous", hint: "only the public anon key" },
  { id: "alice", label: "Alice", hint: "signed in, owns 1 note" },
  { id: "bob", label: "Bob", hint: "signed in, no notes" },
];

const VERSIONS: { id: Version; label: string; ref: string }[] = [
  { id: "before", label: "Before", ref: "v0-broken" },
  { id: "after", label: "After", ref: "main" },
];

const client = new LabClient();
let persona: Persona = "bob";
/** Set after the first run comes back: until then the worker is still downloading and starting Postgres. */
let databaseReady = false;

function radioGroup<T extends string>(
  name: string,
  legend: string,
  options: { id: T; label: string; detail: string }[],
  selected: T,
  onChange: (value: T) => void,
): HTMLFieldSetElement {
  const fieldset = h(
    "fieldset",
    { class: "segmented" },
    h("legend", { class: "visually-hidden" }, legend),
    options.map((option) => {
      const input = h("input", { type: "radio", name, value: option.id, checked: option.id === selected });
      input.addEventListener("change", () => input.checked && onChange(option.id));
      return h(
        "label",
        {},
        input,
        h("span", { class: "segment" }, h("strong", {}, option.label), h("small", {}, option.detail)),
      );
    }),
  );
  return fieldset;
}

class ScenarioCard {
  readonly element: HTMLElement;
  private version: Version = "before";
  private latest = 0;
  private readonly status: HTMLElement;
  private readonly note: HTMLElement;
  private readonly steps: HTMLOListElement;

  constructor(
    private readonly scenario: Scenario,
    number: number,
  ) {
    const headingId = `scenario-${scenario.id}`;
    this.status = h("p", { class: "run-status", role: "status" });
    this.note = h("p", { class: "persona-note" });
    this.steps = h("ol", { class: "steps" });

    this.element = h(
      "section",
      { class: "scenario", "aria-labelledby": headingId, "data-scenario": scenario.id },
      h(
        "header",
        { class: "scenario-head" },
        h("h2", { id: headingId }, `${number}. ${scenario.title}`),
        h(
          "a",
          { href: `${REPO}/blob/main/BUGS.md#${BUG_ANCHORS[scenario.bug]}`, target: "_blank", rel: "noopener" },
          `Bug ${scenario.bug} in BUGS.md`,
        ),
      ),
      h("p", { class: "summary" }, ...withCode(scenario.summary)),
      radioGroup(
        `version-${scenario.id}`,
        `Migrations for “${scenario.title}”`,
        VERSIONS.map((v) => ({ id: v.id, label: v.label, detail: v.ref })),
        this.version,
        (version) => {
          this.version = version;
          void this.refresh();
        },
      ),
      this.note,
      this.status,
      this.steps,
    );
  }

  get usesPersona(): boolean {
    return this.scenario.personas !== null;
  }

  async refresh(): Promise<void> {
    const id = ++this.latest;
    const version = this.version;
    const actual = effectivePersona(this.scenario, persona);
    this.note.textContent = this.personaNote(actual);
    this.element.setAttribute("aria-busy", "true");
    this.status.replaceChildren(
      databaseReady
        ? `Running on a fresh ${version === "before" ? "v0-broken" : "main"} database…`
        : "Starting Postgres in your browser. The first run takes a few seconds…",
    );
    try {
      const { run, elapsedMs } = await client.run(this.scenario.id, version, persona);
      databaseReady = true;
      if (id !== this.latest) return; // a newer toggle already replaced this run
      this.render(run, elapsedMs);
    } catch (error) {
      if (id !== this.latest) return;
      this.steps.replaceChildren();
      this.status.replaceChildren(
        verdictBadge("bug", "Error"),
        ` The in-browser database failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (id === this.latest) this.element.removeAttribute("aria-busy");
    }
  }

  private personaNote(actual: Persona): string {
    if (!this.scenario.personas) return "The persona doesn't apply here: the caller is whoever can reach the URL.";
    if (actual !== persona) return `Runs as ${actual === "bob" ? "Bob" : actual}: an anonymous visitor has no plan.`;
    return "";
  }

  private render(run: ScenarioRun, elapsedMs: number): void {
    const bugs = run.steps.filter((step) => step.verdict === "bug").length;
    const ref = run.version === "before" ? "v0-broken" : "main";
    this.status.replaceChildren(
      bugs > 0 ? verdictBadge("bug", "Bug reproduced") : verdictBadge("safe", "Fixed"),
      ` ${ref} migrations, fresh database, ${elapsedMs} ms`,
    );
    this.steps.replaceChildren(...run.steps.map(stepView));
  }
}

function migrationsPanel(): HTMLElement {
  return h(
    "details",
    { class: "migrations" },
    h("summary", {}, "The SQL behind the toggle"),
    h(
      "p",
      {},
      "Every run starts from a new database: the Supabase stand-in, then the migrations of the chosen version, " +
        "then the sample data (Alice, Bob, one note of Alice's). The files are copied unchanged from the case-study repo.",
    ),
    VERSIONS.map((version) =>
      h(
        "div",
        { class: "migration-set" },
        h("h3", {}, `${version.label}: ${version.ref}`),
        [SUPABASE_SHIM, ...MIGRATIONS[version.id]].map((file) =>
          h(
            "details",
            {},
            h("summary", {}, h("code", {}, file.name)),
            h("pre", { class: "code" }, h("code", {}, file.sql)),
          ),
        ),
      ),
    ),
  );
}

function mount(root: HTMLElement): void {
  const cards = SCENARIOS.map((scenario, i) => new ScenarioCard(scenario, i + 1));

  const personaPicker = radioGroup(
    "persona",
    "Who is sending the requests",
    PERSONAS.map((p) => ({ id: p.id, label: p.label, detail: p.hint })),
    persona,
    (value) => {
      persona = value;
      for (const card of cards) if (card.usesPersona) void card.refresh();
    },
  );

  root.replaceChildren(
    h(
      "header",
      { class: "page-head" },
      h("h1", {}, "Jotpad rescue: live lab"),
      h(
        "p",
        { class: "lede" },
        "Four bugs from my Next.js + Supabase + Stripe rescue case study, replayed against the real migrations. " +
          "Flip each one between the broken version and the fix and watch what Postgres lets through.",
      ),
      h(
        "p",
        { class: "banner", role: "note" },
        "Personal project. Postgres runs in your browser via PGlite with a Supabase stand-in for the roles and " +
          "auth.uid(); PostgREST and Supabase Auth are not emulated. No server, no account, no keys. ",
        h("a", { href: REPO, target: "_blank", rel: "noopener" }, "Case-study repo"),
        " · ",
        h("a", { href: `${REPO}/blob/main/BUGS.md`, target: "_blank", rel: "noopener" }, "BUGS.md"),
      ),
    ),
    h(
      "div",
      { class: "persona-bar" },
      h("p", { class: "label", id: "persona-label" }, "Send requests as"),
      personaPicker,
    ),
    h(
      "main",
      {},
      cards.map((card) => card.element),
      migrationsPanel(),
    ),
    h(
      "footer",
      {},
      "Sample data only. Written by Sunnatulla E. · MIT licence · ",
      h("a", { href: "https://github.com/atokim4/vibe-rescue-live-lab", target: "_blank", rel: "noopener" }, "Source"),
    ),
  );
  personaPicker.setAttribute("aria-labelledby", "persona-label");
  for (const card of cards) void card.refresh();
}

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing from index.html");
mount(root);

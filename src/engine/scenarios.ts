// The four bugs the lab replays: the requests from the case study's `npm run e2e:before` transcript, plus the
// 3-note limit and a correctly signed webhook. Each step records the SQL that reached Postgres and what came back.

import type { LabDatabase, QueryRecord } from "./database";
import { formatValue } from "./format";
import type { Version } from "./migrations";
import { USERS, type Actor, type Persona } from "./personas";
import { signPayload } from "./stripe-signature";
import { handleWebhook, LAB_WEBHOOK_SECRET, type WebhookRequest } from "./webhook";

/** bug = the step shows the vulnerability, safe = the request was refused or did no harm, info = context. */
export type Verdict = "bug" | "safe" | "info";

export interface Step {
  title: string;
  /** Who sends the request: a database actor, an unknown HTTP caller, or Stripe itself. */
  sender: Actor | "internet" | "stripe";
  /** The client call or HTTP request a real app or attacker would make. */
  request: string;
  queries: QueryRecord[];
  response?: { status: number; body: Record<string, unknown> };
  verdict: Verdict;
  finding: string;
}

export type ScenarioId = "read-notes" | "write-notes" | "paywall" | "webhook";

export interface Scenario {
  id: ScenarioId;
  title: string;
  /** Section of BUGS.md in the case-study repo. */
  bug: number;
  summary: string;
  /** Personas the scenario can run as; `null` when the persona doesn't matter (the webhook). */
  personas: Persona[] | null;
  /** Runs on `db`, a fresh database of either version; `db.version` says which. */
  run(db: LabDatabase, persona: Persona): Promise<Step[]>;
}

const name = (persona: Persona) => (persona === "anon" ? "An anonymous visitor" : USERS[persona].name);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const idOf = (persona: Persona) => (persona === "anon" ? null : USERS[persona].id);

function rowsOf(record: QueryRecord): Record<string, unknown>[] {
  return record.outcome.ok ? record.outcome.rows : [];
}

function errorOf(record: QueryRecord): string {
  return record.outcome.ok ? "" : record.outcome.message;
}

const readNotes: Scenario = {
  id: "read-notes",
  title: "Reading other people's notes",
  bug: 2,
  summary:
    "The notes page has no user filter because it trusts RLS. At v0-broken the select policy is `using (true)`, " +
    "so the list is everyone's notes, and the anon key from the browser bundle reads them without logging in.",
  personas: ["anon", "alice", "bob"],
  async run(db, persona) {
    const query = await db.run(persona, "select title, user_id from public.notes");
    const rows = rowsOf(query);
    const others = rows.filter((row) => row.user_id !== idOf(persona)).length;
    let verdict: Verdict = others > 0 ? "bug" : "safe";
    let finding =
      others > 0
        ? `${name(persona)} reads ${plural(others, "note")} owned by someone else.`
        : persona === "anon"
          ? `${plural(rows.length, "row")}: nothing is readable without signing in.`
          : `${plural(rows.length, "row")}: ${name(persona)} sees only their own notes.`;
    if (persona === "alice" && others === 0 && rows.length > 0) {
      verdict = "info";
      finding = "Alice sees her note, but she owns the only note there is. Switch to Bob or anon to see the leak.";
    }
    return [
      {
        title: `${name(persona)} lists notes`,
        sender: persona,
        request: 'supabase.from("notes").select("title, user_id")',
        queries: [query],
        verdict,
        finding,
      },
    ];
  },
};

const writeNotes: Scenario = {
  id: "write-notes",
  title: "Writing into someone else's account",
  bug: 2,
  summary:
    "The insert policy at v0-broken is `with check (true)` for any signed-in user, and `user_id` comes from the " +
    "request body. Anyone with an account can plant notes in anyone else's.",
  personas: ["anon", "alice", "bob"],
  async run(db, persona) {
    const target = persona === "alice" ? "bob" : "alice";
    const title = `Planted by ${persona === "anon" ? "an anonymous visitor" : USERS[persona].name}`;
    const insert = await db.run(persona, "insert into public.notes (user_id, title) values ($1, $2) returning id", [
      USERS[target].id,
      title,
    ]);
    const planted = insert.outcome.ok;
    const steps: Step[] = [
      {
        title: `${name(persona)} inserts a note with user_id = ${USERS[target].name}`,
        sender: persona,
        request: `supabase.from("notes").insert({ user_id: "${USERS[target].id}", title: "${title}" })`,
        queries: [insert],
        verdict: planted ? "bug" : "safe",
        finding: planted
          ? `Accepted: the note is now in ${USERS[target].name}'s account.`
          : `Refused: ${errorOf(insert)}.`,
      },
    ];
    if (persona === "anon") {
      steps[0].finding += " Even v0-broken scoped inserts to signed-in users, so signing up is all it takes.";
    }

    const check = await db.run(target, "select title from public.notes where user_id = auth.uid()");
    const titles = rowsOf(check).map((row) => row.title);
    steps.push({
      title: `${USERS[target].name} opens the dashboard`,
      sender: target,
      request: 'supabase.from("notes").select("title").eq("user_id", user.id)',
      queries: [check],
      verdict: titles.includes(title) ? "bug" : "info",
      finding: titles.includes(title)
        ? `${USERS[target].name} finds a note they never wrote.`
        : `${USERS[target].name} sees only their own ${plural(titles.length, "note")}.`,
    });
    return steps;
  },
};

const FREE_NOTE_LIMIT = 3;

const paywall: Scenario = {
  id: "paywall",
  title: "Free user makes themselves Pro",
  bug: 6,
  summary:
    "The 3-note limit was an `if` in the React form and the profile update policy covered every column, plan " +
    "included. Both are one browser-console call away. Fix 6 moved the limit into the insert policy and dropped " +
    "the update policy, so only the server (the Stripe webhook) can change a plan.",
  personas: ["alice", "bob"],
  async run(db, persona) {
    if (persona === "anon") throw new Error("The paywall scenario needs a signed-in user");
    const user = USERS[persona];
    const count = await db.run(persona, "select count(*)::int as notes from public.notes where user_id = auth.uid()");
    const existing = Number(rowsOf(count)[0]?.notes ?? 0);

    const fill: QueryRecord[] = [count];
    for (let n = existing + 1; n <= FREE_NOTE_LIMIT; n++) {
      fill.push(
        await db.run(persona, "insert into public.notes (user_id, title) values (auth.uid(), $1) returning id", [
          `${user.name}'s note ${n}`,
        ]),
      );
    }
    const filled = fill.slice(1).every((record) => record.outcome.ok);

    const extra = await db.run(
      persona,
      "insert into public.notes (user_id, title) values (auth.uid(), $1) returning id",
      [`${user.name}'s note ${FREE_NOTE_LIMIT + 1}`],
    );
    const upgrade = await db.run(
      persona,
      "update public.profiles set plan = 'pro' where id = auth.uid() returning plan",
    );
    const upgraded = rowsOf(upgrade).length > 0;
    const plan = await db.run(persona, "select plan from public.profiles where id = auth.uid()");

    return [
      {
        title: `${user.name} fills the free plan (${FREE_NOTE_LIMIT} notes)`,
        sender: persona,
        request: 'supabase.from("notes").insert({ title }) // until there are 3',
        queries: fill,
        verdict: "info",
        finding: filled
          ? `${user.name} had ${plural(existing, "note")} and now has ${FREE_NOTE_LIMIT}, the most a free plan allows.`
          : `Filling up failed: ${errorOf(fill.find((record) => !record.outcome.ok) ?? count)}.`,
      },
      {
        title: `${user.name} adds note ${FREE_NOTE_LIMIT + 1} straight through the API`,
        sender: persona,
        request: 'supabase.from("notes").insert({ title: "one more" })',
        queries: [extra],
        verdict: extra.outcome.ok ? "bug" : "safe",
        finding: extra.outcome.ok
          ? "Accepted: the limit only exists in the form, the database takes any number of notes."
          : `Refused by the insert policy (can_add_note()): ${errorOf(extra)}.`,
      },
      {
        title: `${user.name} sets their own plan to "pro"`,
        sender: persona,
        request: `supabase.from("profiles").update({ plan: "pro" }).eq("id", "${user.id}").select("plan")`,
        queries: [upgrade],
        verdict: upgraded ? "bug" : "safe",
        finding: upgraded
          ? `1 row updated: ${user.name} is on Pro without paying.`
          : upgrade.outcome.ok
            ? "0 rows updated: no policy lets a user update a profile, so RLS filters the row out."
            : `Refused: ${errorOf(upgrade)}.`,
      },
      {
        title: `${user.name}'s plan afterwards`,
        sender: persona,
        request: 'supabase.from("profiles").select("plan").single()',
        queries: [plan],
        verdict: "info",
        finding: `plan = ${formatValue(rowsOf(plan)[0]?.plan)}`,
      },
    ];
  },
};

function checkoutEvent(id: string, userId: string, customer: string): string {
  return JSON.stringify({
    id,
    type: "checkout.session.completed",
    data: { object: { object: "checkout.session", client_reference_id: userId, customer, payment_status: "paid" } },
  });
}

function describeRequest(request: WebhookRequest): string {
  const headers = Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`);
  const body = JSON.stringify(JSON.parse(request.body) as unknown, null, 2);
  return ["POST /api/stripe/webhook", ...headers, "", body].join("\n");
}

const webhook: Scenario = {
  id: "webhook",
  title: "Forged Stripe webhook",
  bug: 3,
  summary:
    "v0-broken parses the webhook body without checking the Stripe-Signature header and writes with the " +
    "cookie-based client, which runs as anon because Stripe sends no session. The lab calls the handler directly; " +
    "in the real broken app the auth proxy also redirected Stripe to /login (307) before this code ran.",
  personas: null,
  async run(db) {
    const bob = USERS.bob;
    const send = (request: WebhookRequest) => handleWebhook(db.version, db, request);
    const steps: Step[] = [];

    const unsignedRequest: WebhookRequest = {
      headers: { "content-type": "application/json" },
      body: checkoutEvent("evt_forged_1", bob.id, "cus_forged"),
    };
    const unsigned = await send(unsignedRequest);
    steps.push({
      title: "Someone posts a checkout event with no signature",
      sender: "internet",
      request: describeRequest(unsignedRequest),
      queries: unsigned.queries,
      response: { status: unsigned.status, body: unsigned.body },
      verdict: unsigned.status === 200 ? "bug" : "safe",
      finding:
        unsigned.status === 200
          ? "200: the handler accepts an event anyone can send. It didn't make Bob Pro only because of the " +
            "second bug (the update runs as anon, 0 rows). Fix that one alone and anyone can upgrade anyone."
          : `${unsigned.status}: rejected before any database work.`,
    });

    const fakeRequest: WebhookRequest = {
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`,
      },
      body: checkoutEvent("evt_forged_2", bob.id, "cus_forged"),
    };
    const fake = await send(fakeRequest);
    steps.push({
      title: "The same event with a made-up signature",
      sender: "internet",
      request: describeRequest(fakeRequest),
      queries: fake.queries,
      response: { status: fake.status, body: fake.body },
      verdict: fake.status === 200 ? "bug" : "safe",
      finding:
        fake.status === 200
          ? "200: the header is never read."
          : `${fake.status}: the HMAC doesn't match the endpoint secret.`,
    });

    const realBody = checkoutEvent("evt_lab_paid", bob.id, "cus_lab_bob");
    const realRequest: WebhookRequest = {
      headers: {
        "content-type": "application/json",
        "stripe-signature": await signPayload(realBody, LAB_WEBHOOK_SECRET),
      },
      body: realBody,
    };
    const real = await send(realRequest);
    const affected = real.queries.reduce(
      (sum, record) => sum + (record.outcome.ok ? record.outcome.affectedRows : 0),
      0,
    );
    steps.push({
      title: "Bob really pays: a correctly signed event",
      sender: "stripe",
      request: describeRequest(realRequest),
      queries: real.queries,
      response: { status: real.status, body: real.body },
      verdict: real.status === 200 && affected > 0 ? "safe" : "bug",
      finding:
        real.status === 200 && affected > 0
          ? "200 after the signature check, and the service-role update changed Bob's row."
          : `${real.status} with ${plural(affected, "row")} updated: Stripe sees success and won't retry, so a ` +
            "paying customer stays on the free plan.",
    });

    const plan = await db.run("service_role", "select plan, stripe_customer_id from public.profiles where id = $1", [
      bob.id,
    ]);
    const row = rowsOf(plan)[0];
    steps.push({
      title: "Bob's profile afterwards (read with the service role)",
      sender: "service_role",
      request: 'admin.from("profiles").select("plan, stripe_customer_id").eq("id", bob.id)',
      queries: [plan],
      verdict: "info",
      finding: `plan = ${formatValue(row?.plan)}, stripe_customer_id = ${formatValue(row?.stripe_customer_id)}`,
    });
    return steps;
  },
};

export const SCENARIOS: readonly Scenario[] = [readNotes, writeNotes, paywall, webhook];

export function scenarioById(id: ScenarioId): Scenario {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`Unknown scenario: ${id}`);
  return scenario;
}

/** The persona a scenario actually runs as: the chosen one if it supports it, else its last (Bob). */
export function effectivePersona(scenario: Scenario, persona: Persona): Persona {
  if (!scenario.personas) return "anon";
  return scenario.personas.includes(persona) ? persona : scenario.personas[scenario.personas.length - 1];
}

export interface ScenarioRun {
  scenarioId: ScenarioId;
  version: Version;
  persona: Persona;
  steps: Step[];
}

/** Runs one scenario on `db`, which must be a fresh database of `db.version`. */
export async function runScenario(db: LabDatabase, id: ScenarioId, persona: Persona): Promise<ScenarioRun> {
  const scenario = scenarioById(id);
  const actual = effectivePersona(scenario, persona);
  return { scenarioId: id, version: db.version, persona: actual, steps: await scenario.run(db, actual) };
}

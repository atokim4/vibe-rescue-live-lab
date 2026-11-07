import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LabDatabase } from "../src/engine/database";
import { USERS, type Persona } from "../src/engine/personas";
import type { Version } from "../src/engine/migrations";
import { runScenario, type ScenarioId, type Verdict } from "../src/engine/scenarios";

// One database per version built from the migrations; every test runs on its own clone.
const templates = {} as Record<Version, LabDatabase>;

beforeAll(async () => {
  templates.before = await LabDatabase.create("before");
  templates.after = await LabDatabase.create("after");
}, 60_000);

afterAll(async () => {
  await Promise.all(Object.values(templates).map((db) => db.close()));
});

async function run(id: ScenarioId, version: Version, persona: Persona) {
  const db = await templates[version].clone();
  try {
    return await runScenario(db, id, persona);
  } finally {
    await db.close();
  }
}

const verdicts = (steps: { verdict: Verdict }[]) => steps.map((step) => step.verdict);

describe("1. reading other people's notes", () => {
  test.each([
    ["before", "bob", 1, "bug"],
    ["before", "anon", 1, "bug"],
    ["after", "bob", 0, "safe"],
    ["after", "anon", 0, "safe"],
    ["before", "alice", 1, "info"],
    ["after", "alice", 1, "info"],
  ] as const)("%s, as %s: %i rows", async (version, persona, rows, verdict) => {
    const { steps } = await run("read-notes", version, persona);
    const outcome = steps[0].queries[0].outcome;
    expect(outcome.ok && outcome.rows.length).toBe(rows);
    expect(steps[0].verdict).toBe(verdict);
  });

  test("before, Bob's rows are Alice's note", async () => {
    const outcome = (await run("read-notes", "before", "bob")).steps[0].queries[0].outcome;
    expect(outcome.ok && outcome.rows).toEqual([{ title: "Alice's sample note", user_id: USERS.alice.id }]);
  });
});

describe("2. writing into someone else's account", () => {
  test("before: Bob's note owned by Alice is accepted and shows up on her dashboard", async () => {
    const { steps } = await run("write-notes", "before", "bob");
    expect(steps[0].queries[0].outcome.ok).toBe(true);
    expect(verdicts(steps)).toEqual(["bug", "bug"]);
  });

  test("after: the insert fails the WITH CHECK and Alice's notes are untouched", async () => {
    const { steps } = await run("write-notes", "after", "bob");
    const outcome = steps[0].queries[0].outcome;
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe("42501");
    expect(!outcome.ok && outcome.message).toMatch(/row-level security policy/);
    expect(verdicts(steps)).toEqual(["safe", "info"]);
  });

  test.each(["before", "after"] as const)("%s: anon can't insert at all", async (version) => {
    const { steps } = await run("write-notes", version, "anon");
    expect(steps[0].queries[0].outcome.ok).toBe(false);
    expect(steps[0].verdict).toBe("safe");
  });
});

describe("3. free user makes themselves Pro", () => {
  test("before: a 4th note and a self-upgrade both go through", async () => {
    const { steps } = await run("paywall", "before", "bob");
    expect(verdicts(steps)).toEqual(["info", "bug", "bug", "info"]);
    expect(steps[3].finding).toBe("plan = pro");
  });

  test("after: the 4th note is refused and the update matches 0 rows", async () => {
    const { steps } = await run("paywall", "after", "bob");
    expect(verdicts(steps)).toEqual(["info", "safe", "safe", "info"]);
    const extra = steps[1].queries[0].outcome;
    expect(!extra.ok && extra.code).toBe("42501");
    const upgrade = steps[2].queries[0].outcome;
    expect(upgrade.ok && upgrade.affectedRows).toBe(0);
    expect(steps[3].finding).toBe("plan = free");
  });

  test("Alice starts with one note, so filling up adds two", async () => {
    const { steps } = await run("paywall", "after", "alice");
    expect(steps[0].queries).toHaveLength(3);
    expect(steps[0].queries.every((record) => record.outcome.ok)).toBe(true);
  });

  test("anon has no plan, so the scenario runs as Bob", async () => {
    expect((await run("paywall", "after", "anon")).persona).toBe("bob");
  });
});

describe("4. forged Stripe webhook", () => {
  test("before: forged events get 200, and a real payment changes 0 rows", async () => {
    const { steps } = await run("webhook", "before", "anon");
    expect(steps.slice(0, 3).map((step) => step.response?.status)).toEqual([200, 200, 200]);
    expect(steps[2].queries.map((record) => [record.actor, record.outcome.ok && record.outcome.affectedRows])).toEqual([
      ["anon", 0],
    ]);
    expect(verdicts(steps)).toEqual(["bug", "bug", "bug", "info"]);
    expect(steps[3].finding).toBe("plan = free, stripe_customer_id = null");
  });

  test("after: no or bad signature is a 400 with no SQL, a signed payment makes Bob Pro", async () => {
    const { steps } = await run("webhook", "after", "anon");
    expect(steps.slice(0, 3).map((step) => step.response?.status)).toEqual([400, 400, 200]);
    expect(steps[0].queries).toHaveLength(0);
    expect(steps[1].queries).toHaveLength(0);
    expect(steps[2].queries[0].actor).toBe("service_role");
    expect(verdicts(steps)).toEqual(["safe", "safe", "safe", "info"]);
    expect(steps[3].finding).toBe("plan = pro, stripe_customer_id = cus_lab_bob");
  });
});

test("clones are independent: a scenario never sees another one's writes", async () => {
  await run("write-notes", "before", "bob");
  const { steps } = await run("read-notes", "before", "alice");
  const outcome = steps[0].queries[0].outcome;
  expect(outcome.ok && outcome.rows).toHaveLength(1);
});

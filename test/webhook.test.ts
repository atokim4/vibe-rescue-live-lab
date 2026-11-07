import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LabDatabase } from "../src/engine/database";
import { USERS } from "../src/engine/personas";
import { signPayload } from "../src/engine/stripe-signature";
import { handleWebhook, LAB_WEBHOOK_SECRET } from "../src/engine/webhook";

let db: LabDatabase;

beforeAll(async () => {
  db = await LabDatabase.create("after");
}, 60_000);

afterAll(() => db.close());

async function signed(event: unknown) {
  const body = JSON.stringify(event);
  return { headers: { "stripe-signature": await signPayload(body, LAB_WEBHOOK_SECRET) }, body };
}

const session = (overrides: Record<string, unknown>) => ({
  id: "evt_test",
  type: "checkout.session.completed",
  data: { object: { client_reference_id: USERS.alice.id, customer: "cus_test", payment_status: "paid", ...overrides } },
});

describe("fixed handler (main)", () => {
  test("ignores other event types without touching the database", async () => {
    const res = await handleWebhook("after", db, await signed({ id: "evt_x", type: "invoice.paid" }));
    expect(res).toMatchObject({ status: 200, body: { ignored: "invoice.paid" }, queries: [] });
  });

  test("ignores an unpaid session and a session without a user", async () => {
    for (const overrides of [{ payment_status: "unpaid" }, { client_reference_id: null }]) {
      const res = await handleWebhook("after", db, await signed(session(overrides)));
      expect(res).toMatchObject({ status: 200, body: { ignored: "unpaid or anonymous session" }, queries: [] });
    }
  });

  test("answers 500 so Stripe retries when no profile matches", async () => {
    const res = await handleWebhook(
      "after",
      db,
      await signed(session({ client_reference_id: "00000000-0000-4000-8000-000000000000" })),
    );
    expect(res.status).toBe(500);
  });

  test("rejects a signature made with another secret", async () => {
    const body = JSON.stringify(session({}));
    const res = await handleWebhook("after", db, {
      headers: { "stripe-signature": await signPayload(body, "whsec_someone_else") },
      body,
    });
    expect(res).toMatchObject({ status: 400, body: { error: "Invalid signature" }, queries: [] });
  });
});

describe("broken handler (v0-broken)", () => {
  test("a body that isn't JSON crashes the route (500)", async () => {
    const res = await handleWebhook("before", db, { headers: {}, body: "not json" });
    expect(res.status).toBe(500);
  });

  test("other event types still get 200 without a signature", async () => {
    const res = await handleWebhook("before", db, { headers: {}, body: JSON.stringify({ type: "invoice.paid" }) });
    expect(res).toMatchObject({ status: 200, queries: [] });
  });
});

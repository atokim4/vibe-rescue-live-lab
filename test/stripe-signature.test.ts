import Stripe from "stripe";
import { describe, expect, test } from "vitest";
import { SignatureError, signPayload, verifySignature } from "../src/engine/stripe-signature";

const secret = "whsec_lab_test_secret";
const payload = JSON.stringify({ id: "evt_test", type: "checkout.session.completed" });
// The SDK is only used here, as the reference implementation. No API calls are made.
const stripe = new Stripe("sk_test_not_used");

describe("Stripe webhook signature", () => {
  test("a header we sign is accepted by the Stripe SDK", async () => {
    const header = await signPayload(payload, secret);
    expect(stripe.webhooks.constructEvent(payload, header, secret).id).toBe("evt_test");
  });

  test("a header the Stripe SDK signs is accepted by us", async () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    await expect(verifySignature(payload, header, secret)).resolves.toBeUndefined();
  });

  test("rejects a header without a v1 signature", async () => {
    await expect(verifySignature(payload, "t=1700000000", secret)).rejects.toThrow(SignatureError);
    await expect(verifySignature(payload, "", secret)).rejects.toThrow(SignatureError);
  });

  test("rejects a made-up signature, a wrong secret and a changed body", async () => {
    const header = await signPayload(payload, secret);
    await expect(
      verifySignature(payload, `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`, secret),
    ).rejects.toThrow(SignatureError);
    await expect(verifySignature(payload, header, "whsec_other")).rejects.toThrow(SignatureError);
    await expect(verifySignature(payload.replace("evt_test", "evt_other"), header, secret)).rejects.toThrow(
      SignatureError,
    );
  });

  test("rejects a replayed delivery older than the tolerance, like the SDK", async () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    const header = await signPayload(payload, secret, old);
    await expect(verifySignature(payload, header, secret)).rejects.toThrow("tolerance");
    expect(() => stripe.webhooks.constructEvent(payload, header, secret)).toThrow();
  });

  test("accepts the header when any of several v1 signatures matches (secret rotation)", async () => {
    const header = await signPayload(payload, secret);
    const [t, v1] = header.split(",");
    await expect(verifySignature(payload, `${t},v1=${"f".repeat(64)},${v1}`, secret)).resolves.toBeUndefined();
  });
});

// In-browser ports of the case study's src/app/api/stripe/webhook/route.ts at v0-broken and at main.
// Same branches and status codes; the Next.js Request/Response and the Supabase client calls are replaced by
// a plain request object and the SQL those calls send. Each handler returns the queries it ran.

import type { LabDatabase, QueryRecord } from "./database";
import type { Version } from "./migrations";
import { SignatureError, verifySignature } from "./stripe-signature";

/** The lab's endpoint secret. A made-up test value; the lab never talks to Stripe. */
export const LAB_WEBHOOK_SECRET = "whsec_live_lab_demo_only";

export interface WebhookRequest {
  headers: Record<string, string>;
  body: string;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
  queries: QueryRecord[];
}

interface CheckoutSession {
  client_reference_id?: string | null;
  customer?: string | null;
  payment_status?: string;
}

interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: CheckoutSession };
}

const UPDATE_PLAN = "update public.profiles set plan = 'pro', stripe_customer_id = $1 where id = $2";

/**
 * v0-broken: no signature check, and the update goes through the cookie-based Supabase client. Stripe sends no
 * session cookie, so the update runs as `anon`; RLS matches no row and nobody looks at the result.
 * (In the real broken app the proxy also answered 307 → /login before this code ran.)
 */
async function handleBefore(db: LabDatabase, request: WebhookRequest): Promise<WebhookResponse> {
  const queries: QueryRecord[] = [];
  let event: StripeEvent;
  try {
    event = JSON.parse(request.body) as StripeEvent;
  } catch {
    // Next.js turns the uncaught JSON.parse error into a bare 500.
    return { status: 500, body: { error: "Internal Server Error" }, queries };
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object ?? {};
    queries.push(await db.run("anon", UPDATE_PLAN, [session.customer ?? null, session.client_reference_id ?? null]));
  }
  return { status: 200, body: { received: true }, queries };
}

/** main: verify the signature on the raw body, then update with the service role and check that it worked. */
async function handleAfter(db: LabDatabase, request: WebhookRequest, secret: string): Promise<WebhookResponse> {
  const queries: QueryRecord[] = [];
  const signature = request.headers["stripe-signature"];
  if (!signature) return { status: 400, body: { error: "Missing Stripe-Signature header" }, queries };

  try {
    await verifySignature(request.body, signature, secret);
  } catch (error) {
    if (!(error instanceof SignatureError)) throw error;
    return { status: 400, body: { error: "Invalid signature" }, queries };
  }

  // A signed body is Stripe's own JSON, so parsing can't fail here (constructEvent parses it in the route).
  const event = JSON.parse(request.body) as StripeEvent;
  if (event.type !== "checkout.session.completed") {
    return { status: 200, body: { received: true, ignored: event.type }, queries };
  }

  const session = event.data?.object ?? {};
  const userId = session.client_reference_id;
  if (session.payment_status !== "paid" || !userId) {
    return { status: 200, body: { received: true, ignored: "unpaid or anonymous session" }, queries };
  }

  const update = await db.run("service_role", `${UPDATE_PLAN} returning id`, [session.customer ?? null, userId]);
  queries.push(update);
  if (!update.outcome.ok || update.outcome.rows.length === 0) {
    return { status: 500, body: { error: "Could not update the plan" }, queries };
  }
  return { status: 200, body: { received: true }, queries };
}

export function handleWebhook(
  version: Version,
  db: LabDatabase,
  request: WebhookRequest,
  secret = LAB_WEBHOOK_SECRET,
): Promise<WebhookResponse> {
  return version === "before" ? handleBefore(db, request) : handleAfter(db, request, secret);
}

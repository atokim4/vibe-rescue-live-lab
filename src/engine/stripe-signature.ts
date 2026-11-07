// Stripe's webhook signature scheme with Web Crypto, so it runs in the browser:
// header `Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the endpoint secret>`.
// It accepts the same headers as stripe.webhooks.constructEvent (test/stripe-signature.test.ts checks both ways).

export const DEFAULT_TOLERANCE_SECONDS = 300;

export class SignatureError extends Error {
  override name = "SignatureError";
}

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings without returning early, so the time taken doesn't reveal how much matched. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Builds a header the way Stripe signs a delivery (what `stripe trigger` sends to a local endpoint). */
export async function signPayload(payload: string, secret: string, timestamp = nowSeconds()): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${payload}`)}`;
}

/**
 * Throws a SignatureError unless `header` carries a v1 signature of `payload` made with `secret`
 * no more than `toleranceSeconds` ago. The payload must be the raw body: re-serialised JSON won't match.
 */
export async function verifySignature(
  payload: string,
  header: string,
  secret: string,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = nowSeconds() } = {},
): Promise<void> {
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s.trim());
    if (key === "t") timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (!Number.isInteger(timestamp) || signatures.length === 0) {
    throw new SignatureError("Unable to extract timestamp and signatures from header");
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  if (!signatures.some((signature) => timingSafeEqual(signature, expected))) {
    throw new SignatureError("No signatures found matching the expected signature for payload");
  }
  if (toleranceSeconds > 0 && Math.abs(now - timestamp) > toleranceSeconds) {
    throw new SignatureError("Timestamp outside the tolerance zone");
  }
}

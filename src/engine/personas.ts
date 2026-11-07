// Who the lab can act as. Kept free of PGlite so the UI can import it without loading the database.

/** Who the lab acts as. The first three are what the browser can be; `service_role` is the server's key. */
export type Persona = "anon" | "alice" | "bob";
export type Actor = Persona | "service_role";

export interface SampleUser {
  id: string;
  email: string;
  name: string;
}

/** Sample accounts. Fixed ids keep the SQL on screen readable. */
export const USERS: Record<Exclude<Persona, "anon">, SampleUser> = {
  alice: { id: "a11ce000-0000-4000-8000-000000000001", email: "alice@example.test", name: "Alice" },
  bob: { id: "b0b00000-0000-4000-8000-000000000002", email: "bob@example.test", name: "Bob" },
};

export const ALICE_NOTE_TITLE = "Alice's sample note";

/** The JWT claims PostgREST would put in `request.jwt.claims` for this actor's request. */
export function claimsFor(actor: Actor): Record<string, string> {
  if (actor === "anon" || actor === "service_role") return { role: actor };
  return { sub: USERS[actor].id, role: "authenticated" };
}

export function dbRoleFor(actor: Actor): "anon" | "authenticated" | "service_role" {
  return actor === "alice" || actor === "bob" ? "authenticated" : actor;
}

/** How a SQL value reads on screen: `null`, JSON for objects, the plain string otherwise. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return value instanceof Date ? value.toISOString() : JSON.stringify(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString();
  return typeof value;
}

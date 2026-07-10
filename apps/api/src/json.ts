/** Converts domain BigInts into lossless decimal strings for HTTP JSON. */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if (typeof (value as { toSnapshot?: unknown }).toSnapshot === "function") {
      return jsonSafe((value as unknown as { toSnapshot(): unknown }).toSnapshot());
    }
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return jsonSafe((value as unknown as { toJSON(): unknown }).toJSON());
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, jsonSafe(nested)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(jsonSafe(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

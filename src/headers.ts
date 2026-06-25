import { HEADERS_OVERRIDE, HEADERS_REMOVE, HOP_BY_HOP } from "./config.js";

export function buildProxyHeaders(
  original: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const h: Record<string, string> = {};

  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HEADERS_REMOVE.has(lower)) continue;
    if (HOP_BY_HOP.has(lower)) continue;
    h[lower] = Array.isArray(value) ? value.join(", ") : value;
  }

  for (const [k, v] of Object.entries(HEADERS_OVERRIDE)) {
    h[k.toLowerCase()] = v;
  }

  return h;
}

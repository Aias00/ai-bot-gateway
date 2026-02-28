import path from "node:path";

export function parsePathListEnv(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  return raw
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

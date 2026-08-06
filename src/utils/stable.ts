import { promises as fs } from "node:fs";
import path from "node:path";

import type { JsonValue } from "../types.js";

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function safeRecordEntry(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => safeRecordEntry(entry));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareText)) {
      const child = record[key];
      if (child !== undefined) {
        next[key] = safeRecordEntry(child);
      }
    }
    return next;
  }
  return value;
}

export function stableValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return safeRecordEntry(value) as T;
  }
  if (value !== null && typeof value === "object") {
    return safeRecordEntry(value) as T;
  }
  return value;
}

export function stableJson(value: unknown, pretty = false): string {
  return `${JSON.stringify(stableValue(value), null, pretty ? 2 : undefined)}\n`;
}

export function stableJsonLine(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export async function atomicWriteIfChanged(filePath: string, content: string): Promise<boolean> {
  try {
    if ((await fs.readFile(filePath, "utf8")) === content) return false;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}

export function asJsonValue(value: unknown): JsonValue {
  return stableValue(value) as JsonValue;
}

export function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index] as T;
      if (value === undefined) return;
      results[index] = await operation(value, index);
    }
  });
  await Promise.all(workers);
  return results;
}

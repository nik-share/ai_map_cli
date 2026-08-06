import { createHash } from "node:crypto";

export function hashText(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: string | Buffer, length = 12): string {
  return hashText(value).slice(0, length);
}

// @ts-nocheck
/** Adds two values of the same primitive type. */
export function add(left: number, right: number): number;
export function add(left: string, right: string): string;
export function add(left: number | string, right: number | string): number | string {
  if (typeof left === "number" && typeof right === "number") {
    return left + right;
  }
  return String(left) + String(right);
}

export const arithmeticVersion = 1;

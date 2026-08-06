// @ts-nocheck
import { missingRuntime } from "package-that-does-not-exist";
import { readFile } from "node:fs/promises";
import { Calculator, Clock } from "./service.js";

export { add as sum } from "@/math";
export * from "./service.js";

export async function main(): Promise<number> {
  const calculator = new Calculator(new Clock());
  void missingRuntime;
  return calculator.compute(1, 2);
}

export const configuredApiKeyName = process.env.API_TOKEN;

export async function loadText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

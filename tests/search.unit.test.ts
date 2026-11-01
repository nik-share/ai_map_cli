import { describe, expect, it } from "vitest";

import { findSymbols } from "../src/search.js";
import type { CodeMap, SymbolRecord } from "../src/types.js";

const hash = "a".repeat(64);

function symbol(
  id: string,
  name: string,
  file: string,
  kind: SymbolRecord["kind"] = "function",
): SymbolRecord {
  return {
    schemaVersion: 4,
    id,
    name,
    kind,
    file,
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
    exported: true,
    facts: {},
    sourceHash: hash,
  };
}

const notificationMethod = symbol(
  "method:src/notifications/manager.ts#NotificationManager.markNotificationsAsViewed",
  "markNotificationsAsViewed",
  "src/notifications/manager.ts",
  "method",
);
const managerChangeService = symbol(
  "class:src/requests/manager-change.ts#ManagerChangeRequestService",
  "ManagerChangeRequestService",
  "src/requests/manager-change.ts",
  "class",
);
const symbols = [
  notificationMethod,
  managerChangeService,
  symbol(
    "function:src/requests/manager-change.ts#changeManager",
    "changeManager",
    "src/requests/manager-change.ts",
  ),
  symbol("function:src/alpha.ts#updateUser", "updateUser", "src/alpha.ts"),
  symbol("function:src/beta.ts#updateUser", "updateUser", "src/beta.ts"),
];

const map = { symbols } as CodeMap;

describe("findSymbols", () => {
  it("prioritizes exact stable IDs and names", () => {
    const byId = findSymbols(map, managerChangeService.id);
    const byName = findSymbols(map, "ManagerChangeRequestService");

    expect(byId.matches.map((item) => item.id)).toEqual([managerChangeService.id]);
    expect(byName.matches.map((item) => item.id)).toEqual([managerChangeService.id]);
  });

  it("finds multiword names and a bounded typo", () => {
    expect(findSymbols(map, "manager change").matches.map((item) => item.name)).toContain(
      "ManagerChangeRequestService",
    );
    expect(findSymbols(map, "markNotificatonsAsViewed").matches.map((item) => item.name)).toEqual([
      "markNotificationsAsViewed",
    ]);

    const typoOnlyMap = {
      symbols: [symbol("function:src/foo.ts#foo", "foo", "src/foo.ts")],
    } as CodeMap;
    expect(findSymbols(typoOnlyMap, "foa").matches).toEqual([]);

    const longName = `${"a".repeat(128)}b`;
    const longTypoMap = {
      symbols: [symbol("function:src/long.ts#long", longName, "src/long.ts")],
    } as CodeMap;
    expect(findSymbols(longTypoMap, `${"a".repeat(128)}c`).matches).toEqual([]);
  });

  it("resolves qualified method guesses only within their file", () => {
    const result = findSymbols(
      map,
      "src/notifications/manager.ts#NotificationManager.markNotificationsAsViewed",
    );

    expect(result.matches.map((item) => item.id)).toEqual([notificationMethod.id]);
  });

  it("validates limits and reports deterministic truncation", () => {
    expect(() => findSymbols(map, "update", { limit: 0 })).toThrow(RangeError);
    expect(() => findSymbols(map, "update", { limit: 51 })).toThrow(RangeError);
    expect(() => findSymbols(map, "update", { limit: 1.5 })).toThrow(RangeError);
    expect(() => findSymbols(map, "update", { limit: Number.NaN })).toThrow(RangeError);
    expect(() => findSymbols(map, " ")).toThrow("must not be empty");

    const result = findSymbols(map, "update", { limit: 1 });
    expect(result).toMatchObject({ total: 2, truncated: true });
    expect(result.matches.map((item) => item.id)).toEqual(["function:src/alpha.ts#updateUser"]);

    const reversed = { symbols: [...symbols].reverse() } as CodeMap;
    expect(findSymbols(reversed, "update").matches.map((item) => item.id)).toEqual([
      "function:src/alpha.ts#updateUser",
      "function:src/beta.ts#updateUser",
    ]);

    const defaultLimitMap = {
      symbols: Array.from({ length: 11 }, (_, index) =>
        symbol(
          `function:src/entries/${index}.ts#entry${index}`,
          `entry${index}`,
          `src/entries/${index}.ts`,
        ),
      ),
    } as CodeMap;
    expect(findSymbols(defaultLimitMap, "entry")).toMatchObject({ total: 11, truncated: true });
    expect(findSymbols(defaultLimitMap, "entry").matches).toHaveLength(10);
  });

  it("returns an empty, non-truncated result when nothing matches", () => {
    expect(findSymbols(map, "doesNotExist")).toMatchObject({
      total: 0,
      truncated: false,
      matches: [],
    });
  });
});

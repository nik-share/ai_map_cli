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
  it("finds notification actions from partially matching task words and reports missing terms", () => {
    const fixtures = {
      symbols: [
        symbol(
          "class:src/notifications/mark.ts#Manager",
          "Manager",
          "src/notifications/mark.ts",
          "class",
        ),
        symbol(
          "function:src/notifications/query.ts#fetchNotifications",
          "fetchNotifications",
          "src/notifications/query.ts",
        ),
        symbol(
          "hook:src/notifications/hooks.ts#useMarkAsViewed",
          "useMarkAsViewed",
          "src/notifications/hooks.ts",
          "react-hook",
        ),
        notificationMethod,
      ],
    } as CodeMap;
    const result = findSymbols(fixtures, "notification mark read", { limit: 1 });
    expect(result).toMatchObject({
      total: 2,
      truncated: true,
      matches: [{ id: notificationMethod.id, unmatchedTerms: ["read"] }],
    });
    expect(
      findSymbols(
        { symbols: [...fixtures.symbols].reverse() } as CodeMap,
        "notification mark read",
      ),
    ).toEqual(findSymbols(fixtures, "notification mark read"));
  });

  it("ranks full word matches above partial matches and name matches above path-only matches", () => {
    const exact = symbol(
      "function:src/notifications/read.ts#markNotificationsAsRead",
      "markNotificationsAsRead",
      "src/notifications/read.ts",
    );
    const pathOnly = symbol(
      "class:src/notification/mark/read.ts#Configuration",
      "Configuration",
      "src/notification/mark/read.ts",
      "class",
    );
    const result = findSymbols(
      { symbols: [notificationMethod, pathOnly, exact] } as CodeMap,
      "notification mark read",
    );
    expect(result.matches.map((item) => item.id)).toEqual([
      exact.id,
      pathOnly.id,
      notificationMethod.id,
    ]);
    expect(result.matches.slice(0, 2).every((item) => !("unmatchedTerms" in item))).toBe(true);
    expect(
      findSymbols({ symbols: [notificationMethod, exact] } as CodeMap, notificationMethod.id)
        .matches[0]?.id,
    ).toBe(notificationMethod.id);
  });

  it("requires meaningful coverage and never broadens a qualified selector to unrelated files", () => {
    expect(findSymbols(map, "notification delete archive").matches).toEqual([]);
    expect(findSymbols(map, "notification mark zebra rocket lunar").matches).toEqual([]);
    expect(findSymbols(map, "notification read").matches).toEqual([]);
    expect(findSymbols(map, "src/other.ts#markNotificationsAsViewed").matches).toEqual([]);
    expect(findSymbols(map, "notification notification read").matches).toEqual([]);
  });

  it("normalizes common plurals without merging process, status, or class words", () => {
    expect(findSymbols(map, "notification mark").matches[0]?.id).toBe(notificationMethod.id);
    const fixtures = {
      symbols: [
        symbol("function:src/query.ts#queryCategories", "queryCategories", "src/query.ts"),
        symbol(
          "class:src/process/status.ts#ProcessStatusClass",
          "ProcessStatusClass",
          "src/process/status.ts",
          "class",
        ),
      ],
    } as CodeMap;
    expect(findSymbols(fixtures, "query category").matches.map((item) => item.name)).toEqual([
      "queryCategories",
    ]);
    expect(findSymbols(fixtures, "process status class").matches.map((item) => item.name)).toEqual([
      "ProcessStatusClass",
    ]);
  });

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

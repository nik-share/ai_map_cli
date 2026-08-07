import { describe, expect, it } from "vitest";

import { classifyRelationForBenchmark } from "../scripts/benchmark-real-world.js";

describe("real-world benchmark relation classification", () => {
  // Rejects classifying only the `to` endpoint: a derived inverse points from the unresolved
  // external identity to an internal caller and must not inflate the resolved-internal group.
  it.each([
    {
      name: "derived inverse with unresolved from endpoint",
      from: "external:unresolved#callback",
      to: "function:src/index.ts#caller",
      classification: "derived",
      explanation: "inverse of calls",
      expected: { target: "internal", resolution: "unresolved", inverseFromUnresolved: true },
    },
    {
      name: "forward relation with unresolved to endpoint",
      from: "function:src/index.ts#caller",
      to: "external:unresolved#callback",
      classification: "heuristic",
      explanation: "unresolved call syntax",
      expected: { target: "external", resolution: "unresolved", inverseFromUnresolved: false },
    },
    {
      name: "heuristic evidence with ordinary endpoints",
      from: "function:src/index.ts#caller",
      to: "function:src/value.ts#value",
      classification: "heuristic",
      explanation: "syntax-only relation",
      expected: { target: "internal", resolution: "unresolved", inverseFromUnresolved: false },
    },
    {
      name: "exact internal relation remains resolved",
      from: "function:src/index.ts#caller",
      to: "function:src/value.ts#value",
      classification: "exact",
      explanation: "TypeScript symbol resolution",
      expected: { target: "internal", resolution: "resolved", inverseFromUnresolved: false },
    },
  ])("classifies $name", ({ from, to, classification, explanation, expected }) => {
    expect(
      classifyRelationForBenchmark({
        type: "calls",
        confidence: classification === "exact" ? 1 : 0.35,
        from,
        to,
        origin: {
          file: "src/index.ts",
          line: 1,
          explanation,
          classification,
        },
      }),
    ).toMatchObject({ classification, ...expected });
  });
});

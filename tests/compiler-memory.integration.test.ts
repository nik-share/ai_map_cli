import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import ts from "typescript";
import { afterEach, expect, it } from "vitest";

import { checkFreshness, scanProject, TypeScriptSemanticResolver } from "../src/index.js";
import { createEmptyProject, removeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeProject));
});

it("preserves compiler facts, JavaScript JSDoc types, and freshness across isolated units", async () => {
  const root = await createEmptyProject();
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), '{"name":"memory-contract","type":"module"}');
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { allowJs: true, strict: true }, include: ["src/**/*"] }),
  );
  await writeFile(
    join(root, "src/value.js"),
    "/** @param {number} input @returns {number} */\nexport function twice(input) { return input * 2; }\n",
  );
  await writeFile(
    join(root, "src/index.ts"),
    'import { twice } from "./value.js";\n/** Public documentation.\n * @see twice\n * @link twice\n */\nexport function result() { return twice(2); }\n',
  );
  await writeFile(
    join(root, "orphan.ts"),
    'import { result } from "./src/index.js";\nexport const fallback = () => result();\n',
  );

  const isolated = await scanProject({ root });
  const reference = await scanProject({
    root,
    output: join(root, ".ai/reference"),
    semanticResolver: new TypeScriptSemanticResolver(),
  });
  for (const key of ["project", "files", "symbols", "relations", "diagnostics"] as const) {
    expect(isolated.map[key]).toEqual(reference.map[key]);
  }
  expect(isolated.map.manifest.semanticInputs).toEqual(reference.map.manifest.semanticInputs);
  expect(isolated.map.symbols.find((symbol) => symbol.name === "twice")?.signature).toContain(
    "(input: number): number",
  );
  expect(isolated.map.files.find((file) => file.path === "orphan.ts")?.compilerUnit).toContain(
    "fallback",
  );
  expect((await scanProject({ root })).wrote).toBe(false);
  await writeFile(
    join(root, "src/value.js"),
    "/** @param {string} input @returns {string} */\nexport function twice(input) { return input + input; }\n",
  );
  expect((await checkFreshness({ root })).current).toBe(false);
  const changed = await scanProject({ root });
  expect(changed.map.symbols.find((symbol) => symbol.name === "twice")?.signature).toContain(
    "(input: string): string",
  );

  let documentation: string | undefined;
  await scanProject({
    root,
    analyzers: [
      {
        name: "documentation-reader",
        supports: () => true,
        analyze(context) {
          for (const statement of context.sourceFile.statements) {
            if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== "result") continue;
            const symbol = context.checker.getSymbolAtLocation(statement.name);
            documentation = ts.displayPartsToString(
              symbol?.getDocumentationComment(context.checker),
            );
          }
          return {};
        },
      },
    ],
  });
  expect(documentation).toBe("Public documentation.");
});

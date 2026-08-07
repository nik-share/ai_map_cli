import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { z, type ZodType } from "zod";

import { SCHEMA_VERSION } from "../src/constants.js";
import {
  CodeMapSchema,
  ConfigSchema,
  DiagnosticRecordSchema,
  FileRecordSchema,
  ManifestRecordSchema,
  ProjectRecordSchema,
  RelationRecordSchema,
  SymbolRecordSchema,
} from "../src/schemas.js";
import { stableJson } from "../src/utils/stable.js";

interface SchemaTarget {
  file: string;
  id: string;
  title: string;
  schema: ZodType;
  io?: "input" | "output";
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const targets: SchemaTarget[] = [
  {
    file: "config.schema.json",
    id: "urn:ai-code-map:config:1",
    title: "ai-code-map configuration",
    schema: ConfigSchema,
    io: "input",
  },
  {
    file: "schemas/manifest.schema.json",
    id: `urn:ai-code-map:manifest:${SCHEMA_VERSION}`,
    title: "ai-code-map manifest record",
    schema: ManifestRecordSchema,
  },
  {
    file: "schemas/project.schema.json",
    id: `urn:ai-code-map:project:${SCHEMA_VERSION}`,
    title: "ai-code-map project record",
    schema: ProjectRecordSchema,
  },
  {
    file: "schemas/file.schema.json",
    id: `urn:ai-code-map:file:${SCHEMA_VERSION}`,
    title: "ai-code-map file record",
    schema: FileRecordSchema,
  },
  {
    file: "schemas/symbol.schema.json",
    id: `urn:ai-code-map:symbol:${SCHEMA_VERSION}`,
    title: "ai-code-map symbol record",
    schema: SymbolRecordSchema,
  },
  {
    file: "schemas/relation.schema.json",
    id: `urn:ai-code-map:relation:${SCHEMA_VERSION}`,
    title: "ai-code-map relation record",
    schema: RelationRecordSchema,
  },
  {
    file: "schemas/diagnostics.schema.json",
    id: `urn:ai-code-map:diagnostics:${SCHEMA_VERSION}`,
    title: "ai-code-map diagnostics artifact",
    schema: z.array(DiagnosticRecordSchema),
  },
  {
    file: "schemas/code-map.schema.json",
    id: `urn:ai-code-map:complete:${SCHEMA_VERSION}`,
    title: "complete in-memory ai-code-map",
    schema: CodeMapSchema,
  },
];

const check = process.argv.includes("--check");
let stale = false;
for (const target of targets) {
  const generated = z.toJSONSchema(target.schema, {
    target: "draft-2020-12",
    reused: "ref",
    io: target.io ?? "output",
  }) as Record<string, unknown>;
  const content = stableJson({ ...generated, $id: target.id, title: target.title }, true);
  const destination = path.join(ROOT, target.file);
  if (check) {
    const current = await fs.readFile(destination, "utf8").catch(() => undefined);
    if (current !== content) {
      console.error(`${target.file} is stale; run pnpm schema:generate.`);
      stale = true;
    }
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, "utf8");
  }
}

if (stale) process.exitCode = 1;

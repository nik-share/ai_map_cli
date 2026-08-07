import { promises as fs } from "node:fs";
import path from "node:path";

import { getPackages } from "@manypkg/get-packages";

import { packageEntryPoints } from "./package-metadata.js";
import type { WorkspaceDiscovery, WorkspaceDiscoveryResult, WorkspacePackage } from "./types.js";
import {
  isPathInside,
  isSafeRegularFile,
  normalizeStoredPath,
  readFileInsideRoot,
} from "./utils/path.js";
import { compareText } from "./utils/stable.js";

export class ManypkgWorkspaceDiscovery implements WorkspaceDiscovery {
  readonly name = "manypkg";

  async discover(root: string): Promise<WorkspaceDiscoveryResult> {
    try {
      if (!(await isWorkspaceRoot(root))) {
        return { tool: "single-package", packages: [] };
      }
      const discovered = await getPackages(root);
      const [selectedRoot, discoveredRoot] = await Promise.all([
        fs.realpath(root),
        fs.realpath(discovered.rootDir),
      ]);
      // getPackages searches ancestors. A scan rooted at a child package must not silently
      // expand to its parent workspace and expose sibling metadata.
      if (selectedRoot !== discoveredRoot) return { tool: "single-package", packages: [] };

      const packages: WorkspacePackage[] = [];
      for (const workspace of discovered.packages) {
        const realDirectory = await fs.realpath(workspace.dir);
        if (realDirectory === selectedRoot || !isPathInside(selectedRoot, realDirectory)) continue;
        const manifestPath = path.join(realDirectory, "package.json");
        if (!(await isSafeRegularFile(selectedRoot, manifestPath))) continue;
        const manifest = JSON.parse(
          (await readFileInsideRoot(selectedRoot, manifestPath)).toString("utf8"),
        ) as Record<string, unknown>;
        packages.push({
          name: typeof manifest.name === "string" ? manifest.name : path.basename(realDirectory),
          path: normalizeStoredPath(path.relative(selectedRoot, realDirectory)),
          entryPoints: packageEntryPoints(manifest),
        });
      }
      packages.sort((a, b) => compareText(a.path, b.path));
      return { tool: discovered.tool.type, packages };
    } catch {
      // A malformed or unsupported workspace manifest must not prevent single-package scanning.
      return { tool: "single-package", packages: [] };
    }
  }
}

export function createWorkspaceDiscovery(): WorkspaceDiscovery {
  return new ManypkgWorkspaceDiscovery();
}

async function isWorkspaceRoot(root: string): Promise<boolean> {
  for (const marker of ["pnpm-workspace.yaml", "pnpm-workspace.yml", "lerna.json", "rush.json"]) {
    if (await isSafeRegularFile(root, path.join(root, marker))) return true;
  }
  try {
    const packageJson = JSON.parse(
      (await readFileInsideRoot(root, path.join(root, "package.json"))).toString("utf8"),
    ) as { workspaces?: unknown };
    return (
      Array.isArray(packageJson.workspaces) ||
      Boolean(
        packageJson.workspaces &&
        typeof packageJson.workspaces === "object" &&
        "packages" in packageJson.workspaces,
      )
    );
  } catch {
    return false;
  }
}

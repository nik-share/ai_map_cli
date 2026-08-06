import { promises as fs } from "node:fs";
import path from "node:path";

import { getPackages } from "@manypkg/get-packages";

import { packageEntryPoints } from "./package-metadata.js";
import type { WorkspaceDiscovery, WorkspaceDiscoveryResult, WorkspacePackage } from "./types.js";
import { isPathInside, normalizeStoredPath } from "./utils/path.js";
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
        packages.push({
          name: workspace.packageJson.name,
          path: normalizeStoredPath(path.relative(selectedRoot, realDirectory)),
          entryPoints: packageEntryPoints(
            workspace.packageJson as unknown as Record<string, unknown>,
          ),
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
    try {
      if ((await fs.stat(path.join(root, marker))).isFile()) return true;
    } catch {
      // Missing marker files are expected.
    }
  }
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
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

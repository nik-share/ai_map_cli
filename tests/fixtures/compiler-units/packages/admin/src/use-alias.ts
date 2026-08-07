// @ts-nocheck
import { workspaceAliasValue } from "@local/value";

export function useAdminAlias(): string {
  return workspaceAliasValue();
}

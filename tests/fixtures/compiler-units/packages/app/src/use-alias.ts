// @ts-nocheck
import { workspaceAliasValue } from "@local/value";

export function useAppAlias(): string {
  return workspaceAliasValue();
}

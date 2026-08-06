// @ts-nocheck
import { useCallback, useState } from "react";

export function useSelection(initialId?: string) {
  const [selectedId, setSelectedId] = useState(initialId);
  const select = useCallback((id: string) => setSelectedId(id), []);
  return { selectedId, select };
}

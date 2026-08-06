// @ts-nocheck
import { Badge } from "./Badge";

export interface UserRowProps {
  id: string;
  name: string;
  onSelect: (id: string) => void;
}

export function UserRow({ id, name, onSelect }: UserRowProps) {
  return (
    <button onClick={() => onSelect(id)}>
      <Badge label={name} />
    </button>
  );
}

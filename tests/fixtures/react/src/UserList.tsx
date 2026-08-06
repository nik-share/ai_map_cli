// @ts-nocheck
import { memo, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { UserRow } from "./UserRow";
import { useSelection } from "./useSelection";

export interface User {
  id: string;
  name: string;
}

export interface UserListProps {
  users: User[];
  onSelect: (id: string) => void;
}

export const UserList = memo(function UserList({ users, onSelect }: UserListProps) {
  const [search, setSearch] = useState("");
  const [descending, toggleDescending] = useReducer((value: boolean) => !value, false);
  const { selectedId, select } = useSelection();
  const visibleUsers = useMemo(
    () =>
      users
        .filter((user) => user.name.includes(search))
        .sort((left, right) =>
          descending ? right.name.localeCompare(left.name) : left.name.localeCompare(right.name),
        ),
    [users, search, descending],
  );
  const handleSelect = useCallback(
    (id: string) => {
      select(id);
      onSelect(id);
    },
    [onSelect, select],
  );

  useEffect(() => {
    document.title = `${visibleUsers.length} users`;
  }, [visibleUsers.length]);

  return (
    <section data-selected={selectedId}>
      <input value={search} onChange={(event) => setSearch(event.target.value)} />
      <button onClick={toggleDescending}>reverse</button>
      {visibleUsers.map((user) => (
        <UserRow key={user.id} {...user} onSelect={handleSelect} />
      ))}
    </section>
  );
});

import { useEffect, useState } from "react";

type StateShape = {
  name: string;
  active: boolean;
};

export const PartialInvalidCard = ({ initial }: { initial: string }) => {
  const [name, setName] = useState(initial);
  const [entries, setEntries] = useState<StateShape[]>([]);

  useEffect(() => {
    setEntries((current) => [...current, { name, active: Boolean(name.length) }]);
  }, [name]);

  return (
    <article>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <ul>
        {entries.map((entry) => (
          <li key={entry.name}>{entry.name}</li>
        ))}
      </ul>
    </article>

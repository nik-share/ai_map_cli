import { useCallback, useMemo, useState } from "react";

type CardProps = {
  title: string;
  count: number;
};

function useLocalCounter(): [number, (value: number) => void] {
  const [count, setCount] = useState(0);

  const set = useCallback((value: number) => {
    setCount(value);
  }, []);

  return [count, set];
}

export const UserCard = ({ title, count }: CardProps): JSX.Element => {
  const [isOpen, setOpen] = useState(false);
  const [value, setValue] = useLocalCounter();
  const status = useMemo(() => `card:${title}:${count}`, [title, count]);

  const onToggle = useCallback(() => {
    setOpen((next) => !next);
    setValue(count);
  }, [count, setValue]);

  return (
    <section>
      <h3>{title}</h3>
      <p>{status}</p>
      <p>{value}</p>
      <button onClick={onToggle}>{isOpen ? "open" : "closed"}</button>
    </section>
  );
};

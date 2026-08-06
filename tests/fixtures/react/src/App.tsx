// @ts-nocheck
import { UserList, type User } from "./UserList";

const users: User[] = [{ id: "one", name: "Ada" }];

export function App() {
  return <UserList users={users} onSelect={() => undefined} />;
}

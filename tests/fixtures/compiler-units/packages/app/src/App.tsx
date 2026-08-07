// @ts-nocheck
import { LibraryValue, LibraryWidget, makeLibraryValue } from "@fixture/library";

export function App() {
  const item = makeLibraryValue();
  const constructed = new LibraryValue(item.value);
  return <LibraryWidget label={constructed.value} />;
}

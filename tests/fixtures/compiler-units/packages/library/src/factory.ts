// @ts-nocheck
export class LibraryValue {
  constructor(public readonly value: string) {}
}

export function makeLibraryValue(): LibraryValue {
  return new LibraryValue("library");
}

// @ts-nocheck
export interface LibraryWidgetProps {
  label: string;
}

export function LibraryWidget({ label }: LibraryWidgetProps) {
  return <strong>{label}</strong>;
}

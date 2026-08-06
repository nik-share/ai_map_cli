// @ts-nocheck
"use client";

import { useState } from "react";

export function ClientProduct({ id }: { id: string }) {
  const [quantity, setQuantity] = useState(1);
  return <button onClick={() => setQuantity(quantity + 1)}>{id}:{quantity}</button>;
}

// @ts-nocheck
import { add as calculate } from "@/math";

export class Clock {
  now(): number {
    return Date.now();
  }
}

export class Calculator {
  constructor(private readonly clock: Clock) {}

  async compute(left: number, right: number): Promise<number> {
    this.clock.now();
    return calculate(left, right) as number;
  }
}

import type { Clock, Sleeper } from "../../src/domain/runtime";

/** Test doubles shared by unit tests: no sockets, no delays, no wall clock. */

export class FakeClock implements Clock {
  private current: number;

  constructor(startIso = "2024-01-01T00:00:00.000Z") {
    this.current = Date.parse(startIso);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Records requested delays and optionally advances a FakeClock with them. */
export class RecordingSleeper implements Sleeper {
  readonly delays: number[] = [];
  private readonly clock: FakeClock | undefined;

  constructor(clock?: FakeClock) {
    this.clock = clock;
  }

  async sleep(ms: number): Promise<void> {
    this.delays.push(ms);
    this.clock?.advance(ms);
  }
}

export const halfRandom = { next: () => 0.5 };

/** Injected time/randomness/sleep so tests run without wall-clock or delays. */

export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/** Uniform source in [0, 1), used for retry jitter. */
export interface RandomSource {
  next(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const systemSleeper: Sleeper = {
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export const systemRandom: RandomSource = {
  next: () => Math.random(),
};

export function isoFrom(clock: Clock): string {
  return clock.now().toISOString();
}

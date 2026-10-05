import { InvalidArgumentError } from "commander";
import { ALLOWED_IMAGE_BATCHES, MAX_SEED } from "../config/defaults";

/**
 * Flag parsers (§6.2): bounds are enforced before any service is constructed, so
 * an invalid invocation exits with usage code 2 and never reaches the provider.
 */

export function boundedNumber(flag: string, min: number, max: number): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new InvalidArgumentError(`${flag} must be a number.`);
    }
    if (parsed < min || parsed > max) {
      throw new InvalidArgumentError(`${flag} must be between ${min} and ${max}.`);
    }
    return parsed;
  };
}

export function boundedInteger(flag: string, min: number, max: number): (value: string) => number {
  const parseNumber = boundedNumber(flag, min, max);
  return (value: string): number => {
    const parsed = parseNumber(value);
    if (!Number.isInteger(parsed)) {
      throw new InvalidArgumentError(`${flag} must be an integer.`);
    }
    return parsed;
  };
}

export function imageBatch(value: string): 1 | 4 {
  const parsed = Number(value);
  if (!ALLOWED_IMAGE_BATCHES.includes(parsed as 1 | 4)) {
    throw new InvalidArgumentError(`--batch must be one of ${ALLOWED_IMAGE_BATCHES.join(", ")}.`);
  }
  return parsed as 1 | 4;
}

export function seedValue(value: string): number {
  return boundedInteger("--seed", 0, MAX_SEED)(value);
}

export function unitInterval(flag: string): (value: string) => number {
  return boundedNumber(flag, 0, 1);
}

export function positiveInteger(flag: string, max: number): (value: string) => number {
  return boundedInteger(flag, 1, max);
}

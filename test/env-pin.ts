import { afterEach, beforeEach } from "bun:test";

/** Unsets the given variables for each test and puts the machine's values back after it, so limits never leak in. */
export function pinEnv(keys: readonly string[]): void {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of keys) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

export const AUTOPILOT_ENV = [
  "DORI_MAX_LANES",
  "DORI_MAX_STARTS",
  "DORI_MAX_LOAD",
  "DORI_AUTOSTART",
  "DORI_IDLE_HOURS",
];

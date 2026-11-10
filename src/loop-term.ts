/**
 * SIGTERM for the duty and hourly loops: `dori self-update` stops them to start the new code, and a loop killed
 * mid-pass could leave a nudge half-typed in a pane or deliver an inbox batch twice. The signal only sets a flag and
 * wakes the sleep between passes, so the pass that is running finishes and the next one never starts.
 */
export type Term = {
  /** True once SIGTERM arrived: the caller finishes its pass and leaves the loop. */
  readonly stopped: () => boolean;
  /** Sleeps `ms`, or returns at once when SIGTERM already arrived or arrives while sleeping. */
  readonly wait: (ms: number) => Promise<void>;
  /** Unregisters the handler; SIGTERM then kills the process again. */
  readonly off: () => void;
};

export function onTerm(): Term {
  let stop = false;
  let wake: (() => void) | undefined;
  const handler = (): void => {
    stop = true;
    wake?.();
  };
  process.on("SIGTERM", handler);
  return {
    stopped: () => stop,
    wait: (ms) =>
      stop
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              wake = undefined;
              resolve();
            }, ms);
            wake = () => {
              clearTimeout(timer);
              wake = undefined;
              resolve();
            };
          }),
    off: () => {
      process.off("SIGTERM", handler);
    },
  };
}

/** What the board shows about missions: who handed what to whom, and each row's mission card. */
/** A recurring job (the morning assignment, the hourly loop, duty) and when it last ran; `for`: the row kinds it serves. */
export type Routine = { name: string; when: string; last: number | null; for: string[] };
export type MissionStatus = "대기" | "진행" | "완료" | "막힘";
/** `needs`: the operator's turn (a READY lane to merge); `wait`: assigned but not handed over yet. */
export type StepState = "ok" | "run" | "wait" | "stuck" | "needs";
/** A participant: a board row id (`lead`, `bot:x`, `lane:x`, `standing:x`) or an outside place (`gh:owner/repo`, `muse`). */
export type Actor = { id: string; label: string; sub: string };
/** One hand-over: `from` gave `to` what `what` says, at `at`. */
export type Step = { at: number; from: string; to: string; what: string; state: StepState; href: string | null };
export type Mission = {
  id: string;
  title: string;
  status: MissionStatus;
  at: number;
  actors: Actor[];
  steps: Step[];
  /** The row the operator should open (a READY lane), if any. */
  needs: string | null;
};
/** The mission card on a bot, standing lead or lane row and at the top of its record. */
export type MissionCard = {
  role: string;
  note: string | null;
  mission: string;
  status: MissionStatus;
  result: string | null;
  href: string | null;
  missionId: string | null;
};

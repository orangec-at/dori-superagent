/** A refused command: the CLI prints its message and exits 1. */
export class Refusal extends Error {}

/** A session found gone after a message was queued for it: the message stays in its inbox and must not be sent again. */
export class PaneGone extends Refusal {}

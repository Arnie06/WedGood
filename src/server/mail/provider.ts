import "server-only";

/**
 * Replaceable transactional mail adapter (docs/09 "Integrations"). No provider exists yet, so the
 * only implementation reports `unconfigured`. Callers must treat anything other than `succeeded`
 * as "not sent" and must never record a delivery or show a success message for it.
 */
export type MailMessage = { to: string; subject: string; text: string; idempotencyKey: string };

export type MailOutcome =
  | { status: "unconfigured" }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | { status: "failed"; reason: string }
  | { status: "succeeded"; providerReceipt: string };

export interface MailProvider {
  /** Short stable name recorded with each send ("dev-sink" for the local test sink). */
  readonly id: string;
  readonly configured: boolean;
  /** True when messages are only captured locally and never reach anyone (UX-16 dev sink). */
  readonly captureOnly: boolean;
  send(message: MailMessage): Promise<MailOutcome>;
}

export const unconfiguredMailProvider: MailProvider = {
  id: "none",
  configured: false,
  captureOnly: false,
  async send() {
    return { status: "unconfigured" };
  },
};

/**
 * Local test sink (UX-16, docs/09 "dev mail sink labeled"). It accepts a message and delivers it
 * nowhere: the text is already stored on the guest_messages row, so the sink keeps nothing and logs
 * nothing (no addresses in logs). The receipt says "dev-sink" so the UI can label the message
 * "captured locally, not delivered". Never used in production.
 */
export const devSinkMailProvider: MailProvider = {
  id: "dev-sink",
  configured: true,
  captureOnly: true,
  async send(message) {
    return { status: "succeeded", providerReceipt: `dev-sink:${message.idempotencyKey}` };
  },
};

/**
 * Which adapter MAIL_PROVIDER names. Only "dev-sink" exists. A production build refuses it unless
 * MAIL_ALLOW_DEV_SINK=true (the local E2E suite runs a production build); any other value is
 * unconfigured. Pure so the rule is testable.
 */
export function selectMailProvider(env: {
  provider: string | undefined;
  allowDevSink: string | undefined;
  production: boolean;
}): MailProvider {
  const name = env.provider?.trim().toLowerCase();
  const allowed = !env.production || env.allowDevSink?.trim().toLowerCase() === "true";
  if (name === "dev-sink" && allowed) return devSinkMailProvider;
  return unconfiguredMailProvider;
}

/** The one place the app asks for a mail provider; wiring a real adapter later changes only this. */
export function getMailProvider(): MailProvider {
  return selectMailProvider({
    provider: process.env.MAIL_PROVIDER,
    allowDevSink: process.env.MAIL_ALLOW_DEV_SINK,
    production: process.env.NODE_ENV === "production",
  });
}

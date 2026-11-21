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
  readonly configured: boolean;
  send(message: MailMessage): Promise<MailOutcome>;
}

export const unconfiguredMailProvider: MailProvider = {
  configured: false,
  async send() {
    return { status: "unconfigured" };
  },
};

/** The one place the app asks for a mail provider; wiring a real adapter later changes only this. */
export function getMailProvider(): MailProvider {
  return unconfiguredMailProvider;
}

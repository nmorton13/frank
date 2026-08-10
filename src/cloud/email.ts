import { htmlEscape, HttpError } from "./http";

export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailDelivery = (message: TransactionalEmail) => Promise<void>;

export function cloudflareEmailDelivery(env: Env): EmailDelivery {
  return async (message) => {
    if (String(env.EMAIL_ENABLED) !== "true") {
      throw new HttpError(503, "Email delivery is not configured");
    }
    await env.EMAIL.send({
      to: message.to,
      from: { email: String(env.EMAIL_FROM), name: "Frank" },
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  };
}

export function claimEmail(to: string, verificationUrl: string): TransactionalEmail {
  return {
    to,
    subject: "Verify your Frank workspace",
    text: `Verify your email and claim your Frank workspace:\n\n${verificationUrl}\n\nThis link expires in 30 minutes and can be used once.`,
    html: `<p>Verify your email and claim your Frank workspace.</p><p><a href="${htmlEscape(verificationUrl)}">Verify and open Frank</a></p><p>This link expires in 30 minutes and can be used once.</p>`,
  };
}

export function loginEmail(to: string, loginUrl: string): TransactionalEmail {
  return {
    to,
    subject: "Your Frank sign-in link",
    text: `Open your private Frank workspace:\n\n${loginUrl}\n\nThis link expires in 20 minutes and can be used once.`,
    html: `<p>Open your private Frank workspace.</p><p><a href="${htmlEscape(loginUrl)}">Sign in to Frank</a></p><p>This link expires in 20 minutes and can be used once.</p>`,
  };
}

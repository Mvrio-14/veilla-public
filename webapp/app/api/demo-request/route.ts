import { NextResponse } from "next/server";
import { Resend } from "resend";

/**
 * Sales contact endpoint — fed by ContactModal, which is mounted both on
 * the landing and in the in-app account menu. Validates the
 * minimal {name, email, message} payload, rate-limits by IP (3 requests
 * per 10 minutes), and forwards a plain-text email to the operator via
 * Resend. No persistence — the email IS the record.
 *
 * Returns 429 with `{ error: "rate_limited" }` when the IP burst cap is
 * hit, 400 on bad input, 500 on Resend failure. 200 on success.
 *
 * Requires `RESEND_API_KEY` in env. The destination address is the
 * operator's mail (mario@veilla.app — the .app domain is reserved for
 * email/prospection, .io is the web domain). Kept in a constant rather
 * than env so a misconfiguration on deploy doesn't silently send leads
 * to a blank/legacy address.
 */

const TO_EMAIL = "mario@veilla.app";
const FROM_EMAIL = "Veilla Landing <hello@veilla.io>";

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 3;

// In-memory rate-limit store. Keyed by IP, value is a list of recent
// request timestamps (ms). Survives only within a single function
// instance — on Vercel that is enough for a low-traffic demo form; a
// real abuse case would warrant a shared store such as Upstash/KV.
const recentByIp = new Map<string, number[]>();

function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const list = (recentByIp.get(ip) ?? []).filter((t) => t > cutoff);
  if (list.length >= RATE_MAX) {
    recentByIp.set(ip, list);
    return true;
  }
  list.push(now);
  recentByIp.set(ip, list);
  return false;
}

function isValidEmail(s: string): boolean {
  // Pragmatic check, not RFC-strict. Resend itself will reject malformed.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

export async function POST(req: Request): Promise<Response> {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "bad_payload" }, { status: 400 });
  }
  const { name, email, message } = body as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    typeof email !== "string" ||
    typeof message !== "string"
  ) {
    return NextResponse.json({ error: "bad_payload" }, { status: 400 });
  }
  const cleanName = name.trim().slice(0, 200);
  const cleanEmail = email.trim().slice(0, 254);
  const cleanMessage = message.trim().slice(0, 5000);
  // Message is required alongside the other two. The browser enforces it
  // as well, which is where a person meets the rule — this is the copy
  // that holds for anything not driving the form by hand.
  if (!cleanName || !cleanEmail || !cleanMessage) {
    return NextResponse.json({ error: "empty_field" }, { status: 400 });
  }
  if (!isValidEmail(cleanEmail)) {
    return NextResponse.json({ error: "bad_email" }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[demo-request] RESEND_API_KEY not set");
    return NextResponse.json({ error: "config" }, { status: 500 });
  }

  const resend = new Resend(apiKey);
  const subject = `Veilla — demo request from ${cleanName}`;
  const text = [
    `New demo request from the landing page.`,
    ``,
    `Name:    ${cleanName}`,
    `Email:   ${cleanEmail}`,
    `IP:      ${ip}`,
    `When:    ${new Date().toISOString()}`,
    ``,
    `Message:`,
    cleanMessage,
  ].join("\n");

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: TO_EMAIL,
      replyTo: cleanEmail,
      subject,
      text,
    });
    if (error) {
      console.error("[demo-request] Resend error", error);
      return NextResponse.json({ error: "send_failed" }, { status: 500 });
    }
  } catch (err) {
    console.error("[demo-request] Resend threw", err);
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

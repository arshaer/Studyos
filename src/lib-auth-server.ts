import "server-only";

import { createHash } from "node:crypto";
import { createNeonAuth } from "@neondatabase/auth/next/server";

function required(name: "NEON_AUTH_BASE_URL") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value.replace(/\/$/, "");
}

function cookieSecret() {
  const configured = process.env.NEON_AUTH_COOKIE_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) {
      throw new Error("NEON_AUTH_COOKIE_SECRET must be at least 32 characters");
    }
    return configured;
  }

  // Existing Phase 3.1 deployments did not include the new cookie-secret
  // variable. Derive a stable, non-reversible secret from the server-only
  // database credential so the auth fix can deploy without exposing it.
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("NEON_AUTH_COOKIE_SECRET is not configured");
  }
  return createHash("sha256")
    .update(`studyos-neon-auth-cookie:${databaseUrl}`)
    .digest("hex");
}

export const auth = createNeonAuth({
  baseUrl: required("NEON_AUTH_BASE_URL"),
  cookies: { secret: cookieSecret() },
});

"use client";

import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = process.env.NEXT_PUBLIC_NEON_AUTH_URL || "https://ep-hidden-pond-awwxcrbm.neonauth.c-12.us-east-1.aws.neon.tech/neondb/auth";

export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter(),
});

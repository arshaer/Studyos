"use client";

import { createAuthClient } from "@neondatabase/auth/next";

// The Next.js client intentionally talks to our same-origin /api/auth route.
// The server route then proxies requests to Neon Auth and owns session cookies.
export const authClient = createAuthClient();

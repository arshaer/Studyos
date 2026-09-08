import "server-only";

import { currentUserId } from "@/lib-user";

export function configuredAdminIds() {
  return new Set((process.env.ADMIN_USER_IDS || "").split(",").map(value => value.trim()).filter(Boolean));
}

export async function requireAdmin() {
  const userId = await currentUserId();
  if (!userId || !configuredAdminIds().has(userId)) return "";
  return userId;
}

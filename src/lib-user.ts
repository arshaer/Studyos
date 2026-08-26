import "server-only";

import { auth } from "@/lib-auth-server";

export async function currentUserId() {
  const { data } = await auth.getSession();
  return data?.user?.id ? String(data.user.id) : "";
}

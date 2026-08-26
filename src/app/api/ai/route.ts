import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const mode = body?.mode ?? "tutor";
  return NextResponse.json({
    ok: true,
    mode,
    status: "AI gateway hook ready",
    message: "This endpoint is intentionally provider-agnostic in the first build. Connect document retrieval + model generation in the next implementation stage.",
  });
}

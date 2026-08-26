import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { currentUserId } from "@/lib-user";

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;
    const userId = await currentUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        const requestedUserId = clientPayload ? String(JSON.parse(clientPayload)?.userId || "") : "";
        if (requestedUserId && requestedUserId !== userId) throw new Error("Upload ownership mismatch");
        return {
          allowedContentTypes: [
            "application/pdf",
            "text/plain",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          ],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId }),
        };
      },
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(response);
  } catch (error) {
    console.error("blob upload", error);
    return NextResponse.json({ error: (error as Error).message || "Upload failed" }, { status: 400 });
  }
}

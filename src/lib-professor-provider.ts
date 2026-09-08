import "server-only";

import { configuredAiProvider, type AiGenerationRequest, type AiProvider } from "@/lib-ai";

export type ProfessorProviderContext = {
  userId: string;
  documentId: string;
  sessionId: string;
  requestId: string;
};

export interface ProfessorProviderAdapter {
  readonly name: string;
  readonly model: string;
  generate(request: AiGenerationRequest): ReturnType<AiProvider["generate"]>;
}

/**
 * Pre-paid implementation: Professor runs through the existing free gateway.
 * Paid activation is deliberately isolated here and remains disabled until the
 * rest of Professor V2 has passed its checkpoint.
 */
export function professorProvider(context: ProfessorProviderContext): ProfessorProviderAdapter {
  return configuredAiProvider("professor", {
    ...context,
    protectedContext: true,
  });
}

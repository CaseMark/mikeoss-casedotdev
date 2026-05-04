import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";
import { completeCaseText, streamCaseChat } from "../caseClient";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const provider = providerForModel(params.model);
    if (provider === "case") {
        const usageContext = params.apiKeys?.caseUsageContext
            ? {
                  ...params.apiKeys.caseUsageContext,
                  service: "llm" as const,
                  operation: "llm.chat_stream",
              }
            : undefined;
        return streamCaseChat({
            ...params,
            apiKey: params.apiKeys?.case,
            usageContext,
        });
    }
    if (provider === "claude") return streamClaude(params);
    return streamGemini(params);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const provider = providerForModel(params.model);
    if (provider === "case") {
        const usageContext = params.apiKeys?.caseUsageContext
            ? {
                  ...params.apiKeys.caseUsageContext,
                  service: "llm" as const,
                  operation: "llm.chat_completion",
              }
            : undefined;
        return completeCaseText({
            ...params,
            apiKey: params.apiKeys?.case,
            usageContext,
        });
    }
    if (provider === "claude") return completeClaudeText(params);
    return completeGeminiText(params);
}

import OpenAI from "openai";

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

// ── Types ────────────────────────────────────────────────────────────

export type ToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

export type ToolDefinition = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type Message =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string; tool_calls?: undefined }
    | { role: "assistant"; content: null; tool_calls: ToolCall[] }
    | { role: "tool"; content: string; tool_call_id: string };

// ── Functions ────────────────────────────────────────────────────────

export type ChatResponse =
    | { content: string; toolCalls: null }
    | { content: null; toolCalls: ToolCall[] };

export async function chat(
    messages: Message[],
    systemPrompt: string,
    tools?: ToolDefinition[]
): Promise<ChatResponse> {
    const apiMessages = [
        { role: "system" as const, content: systemPrompt },
        ...messages,
    ];

    const response = await client.chat.completions.create({
        model: "anthropic/claude-sonnet-4",
        messages: apiMessages as OpenAI.ChatCompletionMessageParam[],
        ...(tools ? { tools: tools as OpenAI.ChatCompletionTool[] } : {}),
    });

    const choice = response.choices[0];
    if (!choice) {
        throw new Error("OpenRouter returned an empty choices array");
    }

    const content = choice.message.content ?? null;
    const toolCalls = choice.message.tool_calls
        ? (choice.message.tool_calls as unknown as ToolCall[])
        : null;

    if (toolCalls) {
        return { content: null, toolCalls };
    }

    if (content) {
        return { content, toolCalls: null };
    }

    throw new Error("OpenRouter returned neither content nor tool_calls");
}

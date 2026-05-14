import OpenAI from "openai";

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

export async function chat(
    messages: Array<{ role: "user" | "assistant"; content: string }>
): Promise<string> {
    const response = await client.chat.completions.create({
        model: "anthropic/claude-sonnet-4",
        messages,
    });

    return response.choices[0]?.message?.content ?? "";
}

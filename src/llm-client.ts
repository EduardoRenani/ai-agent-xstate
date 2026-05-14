import OpenAI from "openai";

const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

// ── Types ────────────────────────────────────────────────────────────

// Formato que a API retorna quando o LLM pede para executar uma tool.
// Cada ToolCall tem um id único (gerado pela API) que vincula o pedido ao resultado.
type ToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

// Definição unificada de uma tool: o que o LLM vê (description, parameters)
// e o que roda quando ele pede (execute).
export type Tool = {
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => string;
};

// Todos os tipos de mensagem que compõem uma conversa.
// O array de messages é enviado integralmente à API a cada chamada.
export type Message =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string; tool_calls?: undefined }
    | { role: "assistant"; content: null; tool_calls: ToolCall[] }
    | { role: "tool"; content: string; tool_call_id: string };

// ── Functions ────────────────────────────────────────────────────────

/**
 * Envia mensagens ao LLM e retorna as novas mensagens geradas.
 *
 * Se `tools` é fornecido, o LLM pode pedir para executar tools em vez de
 * responder diretamente. Nesse caso, esta função:
 *   1. Executa as tools pedidas
 *   2. Envia os resultados de volta ao LLM
 *   3. Repete até o LLM produzir uma resposta de texto
 *
 * Retorna TODAS as mensagens geradas durante o processo:
 *   - Sem tools: [assistant text]
 *   - Com 1 tool call: [assistant tool_calls, tool result, assistant text]
 *   - Com N tool calls: [assistant tool_calls, tool result, ..., assistant text]
 */
export async function chat(
    messages: Message[],
    systemPrompt: string,
    tools?: Record<string, Tool>
): Promise<Message[]> {
    // workingMessages: histórico completo que vai à API (inclui messages originais + novas).
    // newMessages: apenas as mensagens geradas nesta chamada (retornado ao caller).
    const workingMessages = [...messages];
    const newMessages: Message[] = [];

    // Converte o formato unificado Tool para o formato que a API espera.
    // Isso é feito uma vez, fora do loop — as definições não mudam entre iterações.
    const apiTools = tools
        ? Object.entries(tools).map(([name, tool]) => ({
            type: "function" as const,
            function: {
                name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }))
        : undefined;

    while (true) {
        // Monta o array de mensagens para a API: system prompt + histórico.
        const apiMessages = [
            { role: "system" as const, content: systemPrompt },
            ...workingMessages,
        ];

        const response = await client.chat.completions.create({
            model: "anthropic/claude-sonnet-4",
            messages: apiMessages as OpenAI.ChatCompletionMessageParam[],
            ...(apiTools ? { tools: apiTools as OpenAI.ChatCompletionTool[] } : {}),
        });

        const choice = response.choices[0];
        if (!choice) {
            throw new Error("OpenRouter returned an empty choices array");
        }

        const content = choice.message.content ?? null;
        const toolCalls = choice.message.tool_calls
            ? (choice.message.tool_calls as unknown as ToolCall[])
            : null;

        // ── Caso 1: LLM pediu tool calls ─────────────────────────────
        // O LLM não respondeu ao usuário — ele quer dados de tools primeiro.
        // Executamos cada tool e voltamos ao início do loop para chamar o LLM
        // novamente com os resultados.
        if (toolCalls) {
            // Registra o pedido do LLM no histórico.
            const assistantMessage: Message = { role: "assistant", content: null, tool_calls: toolCalls };
            workingMessages.push(assistantMessage);
            newMessages.push(assistantMessage);

            // Executa cada tool e registra o resultado.
            for (const toolCall of toolCalls) {
                const tool = tools?.[toolCall.function.name];
                let result: string;
                if (tool) {
                    const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
                    result = tool.execute(args);
                } else {
                    // Tool desconhecida — retorna erro como string para o LLM tentar se recuperar.
                    result = `Unknown tool: ${toolCall.function.name}`;
                }
                const toolMessage: Message = {
                    role: "tool",
                    content: result,
                    tool_call_id: toolCall.id,
                };
                workingMessages.push(toolMessage);
                newMessages.push(toolMessage);
            }
            // Volta ao início do loop — chama o LLM de novo com os resultados.
            continue;
        }

        // ── Caso 2: LLM respondeu com texto ──────────────────────────
        // Fim do ciclo. Retorna todas as mensagens geradas.
        if (content) {
            const assistantMessage: Message = { role: "assistant", content };
            newMessages.push(assistantMessage);
            return newMessages;
        }

        // ── Caso 3: Nem texto nem tool calls ─────────────────────────
        // Não deveria acontecer. Erro na API.
        throw new Error("OpenRouter returned neither content nor tool_calls");
    }
}

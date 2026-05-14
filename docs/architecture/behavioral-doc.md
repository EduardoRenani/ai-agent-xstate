# SPEC: Documentação Comportamental — Máquinas de Estado (filha)

**Você é invocado pelo orquestrador `entry-point.md`. Não execute esta spec diretamente.**

## 0. Input recebido

```
{
  "mode": "initial" | "incremental",
  "feature_ref": "<branch | PR | commit range>",
  "repo_root": "<caminho>",
  "language": "<idioma>",
  "output_dir": "<repo_root>/docs/architecture/behavioral",
  "reflection_log_path": "<...>/.reflection-log.md",
  "siblings_output": {
    "c4": ["<paths dos .mmd de c4>"]   // use para referenciar componentes
  }
}
```

## 1. Output esperado

Retorne ao orquestrador o objeto da seção 5 do pai. Se nenhuma entidade do código atende ao critério de aplicabilidade (seção 3): retorne `status: "no_op"` com reason explicando.

## 2. Escopo

Você produz:

| Arquivo | Tipo | Quando |
|---|---|---|
| `state-machines/<entidade>.mmd` | `stateDiagram-v2` | Por entidade que atende seção 3 |
| `state-machines/<entidade>.md` | markdown | Quando seção 6 obriga |

Foco: comportamento interno de entidades com estado explícito + agentes LLM com loops.

## 3. Critério de Aplicabilidade

Crie máquina de estado SOMENTE se TODOS verdadeiros:
- Existe entidade com estado explícito (campo `status`/`state`, enum, state pattern, switch governado por estado)
- Transições são governadas por regras (não mutação livre)
- Mais de 2 estados não-triviais

NÃO crie para:
- CRUD simples sem estado relevante
- Variáveis de controle internas de função
- Booleanos isolados (`isActive`, `isDeleted`)

### 3.1 Casos típicos que JUSTIFICAM
- Pedidos, assinaturas, processos de aprovação, tickets
- Ciclos de vida de documentos
- Sessões com fases (autenticado, MFA pendente, expirado)
- **Agentes LLM com loops** (ReAct, Plan-and-Execute) — ver seção 8
- Workflows de pagamento, reembolso, cobrança
- Estados de jobs/tarefas assíncronas

## 4. Fluxo de Execução

```
1. ler artefatos existentes em <output_dir> (se incremental)
2. ler siblings_output.c4 para mapear componentes disponíveis
3. inventariar_entidades_com_estado()       // seção 5
4. filtrar_por_aplicabilidade()             // seção 3
5. para cada entidade selecionada:
     mapear_estados_transicoes_guards_side_effects()
     gerar_mmd()
     se cumpre_seção_6: gerar_md_complementar()
     ligar_ao_c4()                          // seção 7
6. para cada artefato produzido:
     loop_reflection()                       // seção 11
7. compor index_entries
8. retornar contrato (seção 5 do pai)
```

## 5. Inventário de Entidades com Estado

Sinais a procurar no código:

| Sinal | Padrão |
|---|---|
| Enum de status | `enum OrderStatus { ... }`, `STATUSES = [...]` |
| Campo de estado | `status`, `state`, `phase`, `lifecycle_state` |
| State pattern | Classe abstrata + implementações por estado |
| Máquina implícita | Cadeia de `if/switch` sobre campo de estado |
| Agente com loop | Harness identificado no C4 que tem condição de saída |

Liste todos. Filtre na seção 4.

## 6. Estrutura Obrigatória de Cada Diagrama

### 6.1 Estados
- Estado inicial (`[*] -->`)
- Ao menos um terminal (`--> [*]`)
- Todos os intermediários presentes no código

### 6.2 Transições

Sintaxe:
```
EstadoA --> EstadoB: trigger [guard] / side_effect
```

Cada transição especifica:
- **Trigger**: evento, ação ou comando que dispara (obrigatório)
- **Guard**: condição que precisa ser verdadeira (quando aplicável)
- **Side effect**: emissão de evento, escrita em DB, chamada externa (quando relevante)

Exemplos válidos:
```
Submitted --> UnderReview: assign_reviewer
UnderReview --> Approved: approve [score >= 0.8] / publish_event
PaymentPending --> Failed: timeout / notify_user
```

### 6.3 Anotações de tipo de estado (recomendado)

Use `note` para distinguir:
```
state Submitted
note right of Submitted: aguardando reviewer (input externo)
```

Categorias úteis: "aguardando input externo", "processando autonomamente", "bloqueado por dependência externa".

## 7. Documentação Textual Complementar (`<entidade>.md`)

OBRIGATÓRIA quando QUALQUER:
- Máquina tem mais de 8 estados
- Existe pelo menos um guard com lógica não-trivial
- Entidade é central ao domínio (pedido, pagamento, contrato)

Conteúdo mínimo:
- Descrição de cada estado (1-2 frases sobre semântica, não o óbvio)
- Detalhamento de guards complexos
- Side effects detalhados com referência a componente do C4
- Invariantes (afirmações sempre verdadeiras em cada estado)
- Timeouts (se algum estado tem expiração automática)

## 8. Conexão Obrigatória com o C4

Todo `.mmd` inicia com cabeçalho expandido:

```
%% Spec: behavioral-doc.md
%% Modo: <inicial|incremental>
%% Atualizado: <YYYY-MM-DD>
%% Fonte: <arquivos do código>
%% Componente C4: <ID do componente em c3-<modulo>.mmd>
%% Container C4: <ID em c2-container.mmd>
%% Externos que disparam transições: <lista, ou "nenhum">
```

Use `siblings_output.c4` para validar que os IDs referenciados existem nos `.mmd` de C4. Se não existir, é falha de validação Nível 3.

## 9. Caso Especial: Agentes LLM

Sempre que o C4 identificou um nó `harness`, você DEVE gerar uma máquina de estado correspondente.

### 9.1 Estados típicos de um agente

- `Receiving` — recebendo input
- `Reasoning` — chamando LLM para decidir próximo passo
- `ToolSelected` — LLM decidiu invocar uma tool
- `ExecutingTool` — tool sendo executada
- `WaitingExternal` — aguardando resposta externa
- `Reflecting` — avaliando se objetivo foi atingido
- `Finalized` — produziu output final
- `Aborted` — saiu por limite (iterações, custo, erro)

### 9.2 Conteúdo obrigatório para máquina de agente

- Condição de saída do loop EXPLÍCITA (max iterações, score de confiança, sinal do LLM)
- Estados de espera externa marcados
- Transições de "abort" representadas (com triggers: timeout, max_iter, budget exceeded)

## 10. Limites de Granularidade

| Métrica | Limite | Se estourar |
|---|---|---|
| Estados por máquina | 15 | Decompor em sub-máquinas via `state X { ... }` |
| Transições por máquina | 30 | Idem |
| Profundidade de aninhamento | 2 | Achatar ou separar em arquivo próprio |

## 11. Reflection — Critérios Específicos

### 11.1 Nível 1 (sintático)
```bash
npx -p @mermaid-js/mermaid-cli mmdc -i <arquivo>.mmd -o /tmp/<arquivo>.svg
```

### 11.2 Nível 2 (visual) — checklist sobre o SVG
- Estados não se sobrepõem
- Transições legíveis, sem cruzamento por cima de estados
- Notas (`note`) bem posicionadas, não sobrepondo conteúdo
- Sub-estados (quando usados) visualmente contidos

Se falhar, aplique antes de re-renderizar:
1. Reduzir número de transições explícitas (consolidar similares)
2. Quebrar em sub-máquinas
3. Mover notas longas para o `.md` complementar

### 11.3 Nível 3 (semântico) — checklist por arquivo

Para CADA `.mmd`:
- [ ] Cabeçalho de rastreabilidade + ligação C4 (seção 8) presente
- [ ] Tem estado inicial e ao menos um terminal
- [ ] Toda transição mostra trigger
- [ ] Guards complexos documentados (no diagrama ou no `.md`)
- [ ] Side effects relevantes anotados
- [ ] Componente C4 referenciado existe em `siblings_output.c4`
- [ ] Limites da seção 10 respeitados
- [ ] (Se agente) condição de saída de loop explícita
- [ ] (Se agente) transições de abort representadas

Para o conjunto:
- [ ] Toda entidade que atende seção 3 tem máquina documentada
- [ ] Todo `harness` identificado no C4 tem máquina correspondente
- [ ] `<entidade>.md` existe quando seção 7 obriga

## 12. Modo Incremental — Tabela de Diff

| Mudança no código | Arquivo |
|---|---|
| Nova entidade com estado relevante | criar `state-machines/<entidade>.mmd` |
| Novo estado em entidade existente | atualizar `<entidade>.mmd` |
| Nova transição em entidade existente | atualizar `<entidade>.mmd` |
| Mudança em guard ou side effect | atualizar `<entidade>.mmd` (e `.md` se aplicável) |
| Novo agente/harness com loop | criar `<agente>.mmd` |
| Entidade removida | remover `<entidade>.mmd` |

Se nenhuma linha se aplica: retorne `status: "no_op"` com reason.

## 13. Anti-Patterns (rejeite)

- ❌ Máquina para entidade CRUD trivial
- ❌ Estados sem trigger explícito de entrada
- ❌ Transições sem trigger ("muda sozinho")
- ❌ Máquina sem ligação a componente C4
- ❌ Múltiplas entidades no mesmo arquivo
- ❌ Agente sem condição de saída de loop

## 14. Exemplos de Referência

### 14.1 Entidade de domínio

```mermaid
%% Spec: behavioral-doc.md
%% Modo: inicial
%% Atualizado: 2026-05-07
%% Fonte: src/orders/Order.ts, src/orders/OrderService.ts
%% Componente C4: orderService (c3-orders.mmd)
%% Container C4: ordersApi (c2-container.mmd)
%% Externos que disparam transições: Stripe (webhook), Carrier API
---
title: Máquina de estado — Pedido
---
stateDiagram-v2
    [*] --> Draft

    Draft --> Submitted: submit / validate_items
    Submitted --> PaymentPending: confirm
    PaymentPending --> Paid: payment_received [amount == total] / emit_paid_event
    PaymentPending --> Failed: timeout_24h / notify_user
    PaymentPending --> Cancelled: user_cancel

    Paid --> Fulfilling: warehouse_assigned
    Fulfilling --> Shipped: dispatch / emit_shipped_event
    Shipped --> Delivered: carrier_confirmation
    Delivered --> [*]

    Failed --> [*]
    Cancelled --> [*]

    note right of PaymentPending
        Aguarda webhook Stripe.
        Timeout via env STRIPE_TIMEOUT_HOURS.
    end note
```

### 14.2 Agente LLM

```mermaid
%% Spec: behavioral-doc.md
%% Modo: inicial
%% Atualizado: 2026-05-07
%% Fonte: src/agents/ResearchHarness.ts
%% Componente C4: researchHarness (c3-agents.mmd)
%% Container C4: agentRuntime (c2-container.mmd)
%% Externos que disparam transições: OpenAI API, Search Tool
---
title: Máquina de estado — Research Agent
---
stateDiagram-v2
    [*] --> Receiving

    Receiving --> Reasoning: query_received
    Reasoning --> ToolSelected: llm_decides_tool
    Reasoning --> Finalized: llm_decides_answer / emit_response
    Reasoning --> Aborted: max_iterations_reached

    ToolSelected --> ExecutingTool: invoke
    ExecutingTool --> WaitingExternal: external_call
    WaitingExternal --> Reasoning: result_received [iterations < MAX_ITER]
    WaitingExternal --> Aborted: timeout

    Finalized --> [*]
    Aborted --> [*]

    note right of Reasoning
        Saída do loop:
        - LLM retorna answer (Finalized)
        - iterations >= MAX_ITER (Aborted)
        - cumulative_cost >= BUDGET (Aborted)
    end note
```

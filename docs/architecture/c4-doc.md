# SPEC: Documentação C4 (filha)

**Você é invocado pelo orquestrador `entry-point.md`. Não execute esta spec diretamente.**

## 0. Input recebido

```
{
  "mode": "initial" | "incremental",
  "feature_ref": "<branch | PR | commit range>",
  "repo_root": "<caminho>",
  "language": "<idioma do projeto>",
  "output_dir": "<repo_root>/docs/architecture/c4",
  "reflection_log_path": "<...>/.reflection-log.md",
  "siblings_output": { ... }
}
```

## 1. Output esperado

Ao final, retorne ao orquestrador o objeto definido na seção 5 do pai. Se nada no código se enquadra no escopo desta spec (sistema sem entradas mapeáveis — improvável), retorne `status: "no_op"`.

## 2. Escopo

Você produz:

| Arquivo | Tipo Mermaid | Quando |
|---|---|---|
| `c1-context.mmd` | `flowchart LR` | Sempre |
| `c2-container.mmd` | `flowchart LR` | Sempre |
| `c3-<modulo>.mmd` | `flowchart LR` | Por módulo que atende seção 4 |
| `flows/<caso>.mmd` | `sequenceDiagram` | Um por caminho feliz |

Foco: estrutura estática + fluxos de dados + interfaces + interações externas. Categorização explícita Agente vs Código vs Externo.

## 3. Fluxo de Execução

```
1. ler artefatos existentes em <output_dir> (se incremental)
2. inventariar_entradas()                    // seção 5
3. mapear_fluxos()                            // seção 6
4. categorizar_componentes()                  // seção 7
5. se mode == initial:
     gerar_c1, gerar_c2, gerar_c3s, gerar_sequences
   se mode == incremental:
     aplicar_diff_por_tabela()                // seção 11
6. para cada .mmd produzido/alterado:
     loop_reflection()                        // seção 12
7. compor index_entries
8. retornar contrato (seção 5 do pai)
```

## 4. Critério para criar C3

Crie `c3-<modulo>.mmd` SOMENTE se o módulo atende AMBOS:
- Mais de 3 componentes internos identificáveis
- Tem orquestração interna não-trivial (não é CRUD)

Senão, não crie. O C2 já o representa.

## 5. Inventário de Entradas (passo obrigatório)

Liste no código todas as entradas. Use estes sinais:

| Tipo | Como detectar |
|---|---|
| HTTP | Decoradores/anotações de rota, definições de router, OpenAPI |
| Eventos | Consumers de Kafka/SQS/RabbitMQ, handlers de webhook |
| Cron | Schedulers, decoradores `@cron`, configs de cron |
| UI | Handlers de comandos iniciados pela UI |

Filtre: ignore health checks, métricas, endpoints administrativos triviais.

## 6. Mapeamento de Fluxos

Para cada entrada inventariada, rastreie no código até o(s) efeito(s) final(is): resposta HTTP, escrita em DB, publicação de evento, chamada externa concluída.

Cada caminho rastreado vira um candidato a `flows/<caso>.mmd`.

## 7. Categorização Visual (paleta C4)

Toda caixa em todo diagrama recebe UMA destas classes:

| Classe | classDef | Quando aplicar |
|---|---|---|
| `agent` | `fill:#9333ea,stroke:#6b21a8,color:#fff` | Chamada a LLM, geração de texto/embedding |
| `tool` | `fill:#c026d3,stroke:#86198f,color:#fff` | Tool exposta a LLM (interface, não impl) |
| `harness` | `fill:#7c3aed,stroke:#5b21b6,color:#fff` | Loop de raciocínio, ReAct, orquestração de agentes |
| `code` | `fill:#2563eb,stroke:#1e40af,color:#fff` | Lógica de negócio determinística |
| `external` | `fill:#dc2626,stroke:#991b1b,color:#fff` | API de terceiro, SaaS, gateway |
| `storage` | `fill:#059669,stroke:#065f46,color:#fff` | DB, cache, object storage, fila |
| `entry` | `fill:#ea580c,stroke:#9a3412,color:#fff` | Endpoint HTTP, consumer, scheduler |

### 7.1 Regras de desambiguação

- Componente que parece código mas chama LLM internamente: `harness` se orquestra, `agent` se é o próprio raciocínio
- `tool` é a INTERFACE exposta ao LLM. A implementação por trás é `code` ou `external`
- Múltiplos agentes com mesmo provider: nós SEPARADOS, não fundidos
- Em dúvida real: pergunte ao humano via mecanismo do orquestrador

### 7.2 Legenda obrigatória

`c2-container.mmd` deve incluir um subgraph "Legenda" com um nó representativo de cada categoria.

## 8. Regras de Renderização (flowcharts)

### 8.1 Cabeçalho fixo

Todo `flowchart` começa com:

```
%% Spec: c4-doc.md
%% Modo: <inicial|incremental>
%% Atualizado: <YYYY-MM-DD>
%% Fonte: <arquivos>
---
config:
  layout: elk
  flowchart:
    nodeSpacing: 80
    rankSpacing: 100
---
flowchart LR
```

NÃO use `dagre`. NÃO use `TD` exceto se o fluxo for genuinamente sequencial e raso.

### 8.2 Subgraphs

Se o diagrama tem >10 nós, agrupe em `subgraph` por:
- Camada (Entrada / Backend / Agentes / Persistência / Externos), OU
- Bounded context

Não misture categorias dentro do mesmo subgraph.

### 8.3 Labels de arestas

Toda aresta tem rótulo. Escolha UMA estratégia por diagrama:

**A — labels curtos (≤25 chars):**
```
api -->|HTTP POST| service
```

**B — referências numeradas (use se >8 arestas com payload):**
```
api -->|1| service
service -->|2| db
```
+ tabela ao final do `.mmd` (em comentário) ou no índice:
```
%% | # | Origem → Destino | Protocolo | Payload |
%% | 1 | api → service | HTTP POST /v1/analyze | documentId + userContext |
```

### 8.4 Conteúdo dos rótulos

Cada aresta especifica:
- **Protocolo**: `HTTP POST`, `gRPC`, `evento Kafka`, `chamada in-process`, `SQL`, etc.
- **Payload conceitual**: o que trafega (não schema completo)

Para arestas para nós `external`:
- Nomear o provider (`OpenAI API`, `Stripe`)
- Indicar `síncrono` ou `assíncrono`

## 9. Sequence Diagrams

Para cada caminho feliz mapeado, gere um `flows/<caso>.mmd`:

- Tipo: `sequenceDiagram`
- Participantes com prefixo de categoria: `[ENTRY]`, `[CODE]`, `[HARNESS]`, `[AGENT]`, `[TOOL]`, `[EXT]`, `[DB]`
- Pontos de decisão dentro do caminho feliz: blocos `alt` / `opt`
- Loops de agente: bloco `loop` com **condição de saída anotada**

## 10. Limites de Granularidade

| Tipo | Limite | Se estourar |
|---|---|---|
| C1 Context | 15 nós | Subir nível de abstração |
| C2 Container | 20 nós | Quebrar em macro + C3s |
| C3 Component | 25 nós | Dividir o módulo |
| Sequence | 12 participantes | Dividir em fases sequenciais |

Não afrouxe os limites. Divida em vez disso.

## 11. Modo Incremental — Tabela de Diff

Detecte no código (entre `feature_ref` e estado anterior) e atualize:

| Mudança no código | Arquivo a atualizar |
|---|---|
| Novo ator ou sistema externo | `c1-context.mmd` |
| Novo container, banco, fila | `c2-container.mmd` |
| Novo componente em módulo existente | `c3-<modulo>.mmd` |
| Novo módulo com complexidade interna | criar `c3-<modulo>.mmd` |
| Novo caso de uso | criar `flows/<caso>.mmd` |
| Caso de uso existente alterado | atualizar `flows/<caso>.mmd` |
| Componente removido | remover do(s) arquivo(s) afetado(s) |

Se nenhuma das linhas se aplica: retorne `status: "no_op"` com reason `"feature contida em [componente X], sem impacto arquitetural"`.

Toda alteração inclui justificativa em comentário no commit:
```
Atualização em c3-orders.mmd: adicionado componente PaymentValidator
Fonte: src/orders/PaymentValidator.ts (criado em <feature_ref>)
```

## 12. Reflection — Critérios Específicos

### 12.1 Nível 1 (sintático)
```bash
npx -p @mermaid-js/mermaid-cli mmdc -i <arquivo>.mmd -o /tmp/<arquivo>.svg
```

### 12.2 Nível 2 (visual) — checklist sobre o SVG
- Nenhum label de aresta sobrepõe outro label ou nó
- Nenhuma aresta cruza por cima de um nó
- Textos legíveis sem zoom extremo
- Subgraphs visualmente distintos (quando usados)

Se falhar, aplique nesta ordem antes de re-renderizar:
1. Verificar cabeçalho ELK
2. Trocar `TD` por `LR`
3. Adicionar subgraphs por categoria
4. Migrar para Estratégia B de labels
5. Se ainda falha: dividir o diagrama

### 12.3 Nível 3 (semântico) — checklist por arquivo

Para CADA `.mmd`:
- [ ] Cabeçalho de rastreabilidade presente (seção 8.1)
- [ ] Todo nó tem `classDef` aplicada da paleta da seção 7
- [ ] Toda aresta tem rótulo (Estratégia A ou B)
- [ ] Toda chamada `external` tem provider + sync/async no rótulo
- [ ] Componentes Agente/Tool/Harness visivelmente diferenciados
- [ ] Limites da seção 10 respeitados
- [ ] (Se C2) inclui subgraph "Legenda"
- [ ] (Se sequence) participantes têm prefixo de categoria
- [ ] (Se sequence) loops de agente têm condição de saída

Para o conjunto:
- [ ] Toda entrada do inventário (seção 5) tem ao menos um `flows/<caso>.mmd`
- [ ] Todos os arquivos da seção 2 existem (exceto C3s não obrigatórios)

## 13. Anti-Patterns (rejeite)

- ❌ Detalhar implementação interna de funções
- ❌ Class diagrams, deployment diagrams (escopo é C4)
- ❌ Misturar `LR` e `TD` no mesmo nível
- ❌ Múltiplos agentes fundidos por usarem mesmo provider
- ❌ >3 arestas saindo/entrando do mesmo nó sem subgraph
- ❌ Labels com `<br/>` >2 linhas
- ❌ Documentar erros/exceções (já proibido pelo pai)

## 14. Exemplo de Referência

```mermaid
%% Spec: c4-doc.md
%% Modo: inicial
%% Atualizado: 2026-05-07
%% Fonte: src/api/, src/orchestrator/, src/agents/
---
config:
  layout: elk
  flowchart:
    nodeSpacing: 80
    rankSpacing: 100
---
flowchart LR
    user[Usuário]:::entry

    subgraph backend [Backend]
        api[API Gateway]:::code
        orchestrator[Agent Orchestrator]:::harness
    end

    subgraph agentLayer [Camada de Agentes]
        llm[LLM Reasoning]:::agent
        searchTool[Search Tool]:::tool
    end

    subgraph storage [Persistência]
        db[(PostgreSQL)]:::storage
    end

    subgraph externals [Externos]
        openai[OpenAI API]:::external
    end

    user -->|1| api
    api -->|2| orchestrator
    orchestrator -->|3| llm
    llm -->|4| openai
    llm -->|5| searchTool
    searchTool -->|6| db

    classDef entry fill:#ea580c,stroke:#9a3412,color:#fff
    classDef code fill:#2563eb,stroke:#1e40af,color:#fff
    classDef harness fill:#7c3aed,stroke:#5b21b6,color:#fff
    classDef agent fill:#9333ea,stroke:#6b21a8,color:#fff
    classDef tool fill:#c026d3,stroke:#86198f,color:#fff
    classDef external fill:#dc2626,stroke:#991b1b,color:#fff
    classDef storage fill:#059669,stroke:#065f46,color:#fff

%% | # | Origem → Destino | Protocolo | Payload |
%% | 1 | user → api | HTTP POST /chat | prompt + sessionId |
%% | 2 | api → orchestrator | chamada in-process | ChatRequest |
%% | 3 | orchestrator → llm | invoke | messages + tools |
%% | 4 | llm → openai | HTTPS (síncrono) | completion request |
%% | 5 | llm → searchTool | tool_call | query |
%% | 6 | searchTool → db | SQL SELECT | embedding similarity |
```

# SPEC: Documentação Pós-Implementação — Orquestrador

**Você é o orquestrador da etapa de documentação visual no fluxo SDD.** Esta spec é seu único ponto de entrada. Você invoca specs filhas, consolida resultados e valida o agregado.

## 0. Invocação

Você é executado com este input:

```
{
  "mode": "initial" | "incremental",
  "feature_ref": "<branch | PR | commit range>",  // obrigatório se mode=incremental
  "repo_root": "<caminho absoluto>",
  "skip": []  // opcional: ["c4", "behavioral"] para pular filhas específicas
}
```

Se `mode` não vier, detecte: `incremental` se `docs/architecture/` existe e tem arquivos `.mmd`, senão `initial`.

## 1. Decisões Fixas (não questione)

- **Formato:** todo artefato visual é Mermaid (`.mmd`). Sem exceções.
- **Escopo de conteúdo:** apenas caminhos felizes. Erros, exceções e edge cases NÃO entram.
- **Fonte da verdade:** o código real. Em divergência com docs anteriores, código vence.
- **Idioma:** detecte do projeto e propague para todas as filhas via input. Não misture idiomas.
- **Reflection:** obrigatória. Artefato sem validação aprovada = artefato inexistente.

## 2. Fluxo de Execução

Execute na ordem. Não pule passos.

```
1. validar_input()
2. preparar_diretórios()
3. detectar_idioma_do_projeto()
4. invocar_filhas_em_ordem()       // ver seção 3
5. consolidar_readme()
6. validar_agregado()              // ver seção 6.4
7. retornar_relatório()            // ver seção 7
```

## 3. Ordem Canônica das Filhas

Invoque NESTA ORDEM. A ordem importa: Behavioral referencia componentes do C4.

| Ordem | Filha | Arquivo | Pular se |
|---|---|---|---|
| 1 | C4 | `c4-doc.md` | `"c4"` em `skip` |
| 2 | Behavioral | `behavioral-doc.md` | `"behavioral"` em `skip` |

**Regra de aplicabilidade:** invoque sempre que a filha não estiver em `skip`. A própria filha decide se tem trabalho a fazer e pode retornar `{"status": "no_op", "reason": "..."}`. Você não faz triagem prévia.

## 4. Contrato de Invocação (pai → filha)

Passe para cada filha:

```
{
  "mode": <herdado do input>,
  "feature_ref": <herdado>,
  "repo_root": <herdado>,
  "language": <detectado no passo 3>,
  "output_dir": "<repo_root>/docs/architecture/<filha-dir>",
  "reflection_log_path": "<repo_root>/docs/architecture/.reflection-log.md",
  "siblings_output": {
    // artefatos já produzidos por filhas anteriores nesta execução
    // ex: após C4 rodar, Behavioral recebe paths dos .mmd de C4 para referenciar
    "c4": ["<paths>"]
  }
}
```

## 5. Contrato de Retorno (filha → pai)

Toda filha retorna:

```
{
  "status": "ok" | "no_op" | "failed" | "escalated",
  "reason": "<string explicando, obrigatório se != ok>",
  "artifacts_created": ["<paths>"],
  "artifacts_updated": ["<paths>"],
  "artifacts_deleted": ["<paths>"],
  "validation": {
    "level_1_passed": bool,
    "level_2_passed": bool,
    "level_3_passed": bool,
    "iterations": int
  },
  "index_entries": [
    // o que adicionar ao README.md consolidado
    {"path": "<rel_path>", "title": "<string>", "description": "<1 frase>"}
  ]
}
```

Se `status == "escalated"`, pare a execução do orquestrador e devolva relatório ao humano (seção 7).

## 6. Validação

### 6.1 Comando Mermaid

Para qualquer validação Nível 1 (sintática), use:

```bash
npx -p @mermaid-js/mermaid-cli mmdc -i <arquivo>.mmd -o /tmp/<arquivo>.svg
```

Exit code 0 = passou. Diferente de 0 = falhou, ler stderr.

### 6.2 Níveis de Validação

| Nível | O quê | Quem executa |
|---|---|---|
| 1 — Sintático | `mmdc` renderiza sem erro | Filha |
| 2 — Visual | LLM inspeciona SVG: sem sobreposição, sem cruzamento de nós, legível | Filha |
| 3 — Semântico | Checklist específico da filha | Filha |

### 6.3 Loop de Reflection (executado pela filha)

```
para cada .mmd produzido:
  iter = 1
  enquanto iter <= 3:
    nivel_1 = rodar_mmdc(arquivo)
    se !nivel_1.ok:
      corrigir_sintaxe(nivel_1.erro)
      iter += 1
      continue
    nivel_2 = inspecionar_svg(arquivo)
    se !nivel_2.ok:
      aplicar_técnicas_da_filha(nivel_2.problemas)
      iter += 1
      continue
    nivel_3 = checklist_semântico_da_filha(arquivo)
    se !nivel_3.ok:
      corrigir_conteúdo(nivel_3.faltas)
      iter += 1
      continue
    aprovado, sair
  se iter > 3:
    registrar_em_reflection_log()
    retornar status="escalated"
```

### 6.4 Validação do Agregado (executada pelo orquestrador)

Após todas as filhas retornarem `ok` ou `no_op`:

- [ ] `docs/architecture/README.md` existe e lista todos os artefatos retornados em `index_entries`
- [ ] `.reflection-log.md` existe e contém ao menos uma entrada por filha executada
- [ ] Nenhum `.mmd` órfão (existe no disco mas não está em `index_entries` de nenhuma filha)
- [ ] Sem dois artefatos com IDs internos conflitantes (verificar grep entre arquivos)

Se falhar: registre em `.reflection-log.md` e retorne status `escalated` ao humano.

## 7. Relatório Final (ao humano)

Sempre retorne, ao fim da execução:

```markdown
# Documentação — Relatório de Execução

**Modo:** initial | incremental
**Feature:** <feature_ref>
**Resultado:** ok | partial | failed | escalated

## Filhas executadas
- C4: <status> — <N criados, M atualizados, K deletados>
- Behavioral: <status> — <...>

## Artefatos
<listagem por filha>

## Pendências (se houver)
<problemas não resolvidos, com referência ao .reflection-log.md>

## Próximos passos sugeridos
<apenas se status != ok>
```

## 8. Estrutura de Diretórios (gerenciada pelo orquestrador)

```
docs/architecture/
├── README.md                   # você escreve, consolidando index_entries
├── .reflection-log.md          # filhas escrevem, você nunca apaga
├── c4/                         # filha C4 gerencia
└── behavioral/                 # filha Behavioral gerencia
```

Crie diretórios faltantes no passo 2. Nunca delete arquivos fora dos retornos `artifacts_deleted` das filhas.

## 9. Convenções Mermaid Genéricas (propague às filhas)

Estas regras valem para qualquer `.mmd` produzido. As filhas devem aplicá-las.

### 9.1 Cabeçalho de rastreabilidade obrigatório

Todo `.mmd` começa com:

```
%% Spec: <nome-da-filha>.md
%% Modo: <inicial|incremental>
%% Atualizado: <YYYY-MM-DD>
%% Fonte: <arquivos-de-código-referenciados>
```

### 9.2 Nomenclatura

- Arquivos: `kebab-case`, descritivos do conteúdo (`order-state-machine.mmd`, não `diagram-1.mmd`)
- IDs internos: `camelCase` curto, estável
- IDs não devem se repetir entre arquivos com significados diferentes

### 9.3 Limite genérico

Nenhum diagrama excede 25 elementos primários. Filhas podem (e devem) impor limites mais estritos por tipo. Se estourar: divida o diagrama, não afrouxe o limite.

### 9.4 Justificativa de alterações (modo incremental)

Toda mudança em `.mmd` existente deve referenciar arquivo + função/classe do código que motivou a mudança. Sem rastreabilidade, a alteração é rejeitada na validação.

### 9.5 Legenda de arestas numeradas

Todo `.mmd` que usa arestas numeradas (`-->|N|`) **deve** ter um arquivo companion `<mesmo-nome>.md` no mesmo diretório, contendo uma tabela visível que mapeia cada número à sua descrição.

Estrutura obrigatória do companion:

```markdown
# <Título do diagrama>

Companion de `<arquivo>.mmd`. Gerado automaticamente — não edite manualmente.

## Interfaces

| # | Origem → Destino | Protocolo | Payload |
|---|---|---|---|
| 1 | Componente A → Componente B | HTTP POST /endpoint | {campo1, campo2} |
| 2 | ... | ... | ... |
```

**Regras:**
- O companion é gerado junto com o `.mmd` e atualizado junto no modo incremental.
- Os comentários `%%` com a tabela de interface permanecem no `.mmd` para rastreabilidade inline; o companion `.md` é a versão legível.
- O companion deve ser listado em `index_entries` da filha e indexado no `README.md`.
- Se o `.mmd` não usa arestas numeradas (ex: `stateDiagram`), o companion não é necessário.

## 10. Anti-Patterns (rejeite se detectar em qualquer filha)

- ❌ Artefato sem cabeçalho de rastreabilidade (seção 9.1)
- ❌ Idiomas misturados no mesmo `.mmd`
- ❌ Documentação de fluxos de erro/exceção
- ❌ Elementos inventados sem referência ao código
- ❌ Reuso de IDs com significados diferentes
- ❌ Reflection pulada (any `level_X_passed: false` no retorno final da filha sem `escalated`)

## 11. Modo Inicial vs Incremental

### 11.1 Inicial
Filhas geram do zero, cobrindo escopo total do sistema.

### 11.2 Incremental
Filhas leem `.mmd` existentes ANTES de qualquer mudança. Comparam com código atual. Aplicam diff pontual. Justificam cada alteração com referência ao código.

Se nada mudou no domínio da filha: ela retorna `status: "no_op"` com reason explicando.

## 12. Anti-Decay (executado fora desta spec)

Trimestralmente, ou antes de release maior, invoque este orquestrador com `mode: "initial"` em ambiente de teste e diff o resultado contra a documentação atual. Divergências = dívida técnica.

Esta operação não é parte do fluxo SDD normal. Pode ser executada por agente separado com acesso a esta spec.

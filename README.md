# Siart

Plataforma de IA para engenharia de software: chat com streaming, projeto de arquivos, editor, prévia isolada, exportação (ZIP e PDF) e agente com ferramentas. A chave da Groq fica só no servidor. Sem dependências externas: usa apenas Node 20+.

## Rodar localmente

```bash
cp .env.example .env        # preencha GROQ_API_KEY
node --env-file=.env src/server.js
# abra http://localhost:3000
npm test                    # 38 testes, sem rede externa
```

## Níveis de IA

| Nível | Para quê | Esforço de raciocínio | Tokens | Ferramentas de projeto |
|---|---|---|---|---|
| **Absoluty 1.1** | O melhor: alto processamento, bom em desenvolvimento. Mais lento. | alto | 8192 | sim |
| **Moyenne 1** | Equilíbrio entre qualidade e velocidade. É o padrão. | médio | 4096 | sim |
| **Basse 0.1** | Rápida e simples, boa para conversa. Fraca em tarefas complexas. | baixo | 2048 | não (`TIER_BASSE_TOOLS=1` liga) |

Cada nível tem uma **cadeia de provedores** tentada na ordem. Padrões (IDs conferidos nas documentações em 24/11/2026):

- **Absoluty:** Gemini `gemini-2.5-pro` → Mistral `mistral-large-latest` → Groq `openai/gpt-oss-120b` → OpenRouter `qwen/qwen3-coder:free`
- **Moyenne:** Groq `openai/gpt-oss-120b` → Gemini `gemini-2.5-flash` → Mistral `mistral-medium-latest` → OpenRouter `openai/gpt-oss-120b:free`
- **Basse:** Groq `openai/gpt-oss-20b` → Gemini `gemini-2.5-flash-lite` → Mistral `mistral-small-latest` → OpenRouter `openai/gpt-oss-20b:free`

Só entram na cadeia os provedores com chave configurada. Com **apenas a chave da Groq**, os três níveis funcionam, mas Absoluty usa `gpt-oss-120b` com esforço alto, Moyenne a mesma com esforço médio e Basse usa `gpt-oss-20b`. Catálogos de modelos mudam rápido: ajuste com `TIER_ABSOLUTY`, `TIER_MOYENNE` e `TIER_BASSE` (formato `provedor:modelo,provedor:modelo`). Ao iniciar, o servidor avisa no log quando um modelo configurado não aparece na lista do provedor.

### Como funciona o fallback

- Troca para o próximo provedor se o atual retornar erro (429, 5xx, 401/403, 402, 404, 400), não começar a responder no prazo (20 a 60 s conforme o nível), ou devolver resposta vazia. O usuário vê um aviso como "Gemini atingiu o limite de uso. Usando Mistral." e, em cada resposta, qual nível e provedor responderam.
- **Só troca antes de a resposta começar.** Se a conexão cair no meio do texto, a resposta termina com erro, para não duplicar texto.
- Provedor que falhou fica em pausa por um tempo (30 s para limite e instabilidade, 10 min para chave inválida ou sem créditos) e é pulado nas próximas mensagens. Se todos estiverem em pausa, tenta mesmo assim.
- Se o provedor rejeitar o tool calling (400), a Siart refaz a chamada só com texto.
- Se todos falharem: mensagem "Nenhum provedor de IA conseguiu responder agora", com os motivos de cada um, sem detalhes internos.
- Os IDs das chamadas de ferramenta são gerados pelo servidor (9 caracteres alfanuméricos), então uma tarefa com ferramentas pode trocar de provedor no meio.

## Limites

- **Conversas salvas:** `MAX_CONVERSATIONS` (padrão 30). Ao atingir, criar outra pede confirmação para excluir a mais antiga. As conversas ficam no navegador, então esse limite **não é imposto pelo servidor**; quem edita o armazenamento do navegador consegue contorná-lo.
- **Mensagens por conversa:** `MAX_MESSAGES_PER_CONVERSATION` (padrão 40, máximo 200). Imposto no cliente (campo bloqueado, aviso de "restam N trocas") e **também no servidor** (HTTP 400).
- Outros controles de custo: rate limit por IP (`RATE_LIMIT_MAX`), `ACCESS_CODE` e tokens máximos por nível. Não existe cota diária por usuário.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Uso |
|---|---|---|---|
| `GROQ_API_KEY`, `GEMINI_API_KEY` (ou `GOOGLE_API_KEY`), `MISTRAL_API_KEY`, `OPENROUTER_API_KEY` | pelo menos uma | – | chaves secretas; nunca vão ao navegador nem aos logs |
| `ACCESS_CODE` | recomendada | – | senha do site. Sem ela, qualquer pessoa com o link usa suas cotas |
| `DEFAULT_TIER` | não | `moyenne` | nível inicial |
| `TIER_ABSOLUTY` / `TIER_MOYENNE` / `TIER_BASSE` | não | ver acima | cadeia de modelos do nível |
| `TIER_<NÍVEL>_TOOLS`, `TIER_<NÍVEL>_FIRST_BYTE_MS` | não | por nível | liga/desliga ferramentas; prazo até o primeiro byte |
| `MAX_CONVERSATIONS`, `MAX_MESSAGES_PER_CONVERSATION` | não | `30`, `40` | limites acima |
| `GROQ_BASE_URL`, `GEMINI_BASE_URL`, `MISTRAL_BASE_URL`, `OPENROUTER_BASE_URL` | não | URLs oficiais | só para testes ou proxies |
| `DATA_DIR` | não | `./data` | onde ficam os arquivos dos projetos |
| `PORT` | não | `3000` | o Render define sozinho |
| `TRUST_PROXY` | não | desligado | `1` no Render, para o rate limit enxergar o IP real e o cookie sair `Secure` |
| `TOOLS_ENABLED` | não | ligado | `0` desliga as ferramentas (só chat) |
| `MAX_TOOL_STEPS` | não | `6` | passos de ferramentas por mensagem |
| `RETENTION_DAYS` | não | `30` | apaga projetos sem uso após N dias |
| `ALLOWED_ORIGIN` | não | – | só se o frontend ficar em outro domínio |
| `RATE_LIMIT_MAX` / `API_RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | não | `20` / `240` / `60000` | chat e demais rotas, por IP |
| `UPSTREAM_TIMEOUT_MS` | não | `180000` | tempo máximo total de uma resposta |

A variável `GROQ_MODEL` da versão anterior não existe mais: use `TIER_*`.

## Deploy no Render

1. Suba esta pasta para um repositório no GitHub (o `.gitignore` já exclui `.env` e `data/`).
2. No Render: **New → Blueprint** apontando para o repositório (usa o `render.yaml`), ou crie um **Web Service** com Build `npm install`, Start `npm start`, Health Check `/health`.
3. Em **Environment**, preencha ao menos uma chave de IA (`GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY` ou `OPENROUTER_API_KEY`) e o `ACCESS_CODE`.
4. Abra a URL. Se aparecer o aviso vermelho sobre chaves, nenhuma chave foi lida.

**Atenção ao plano gratuito:** o disco local é apagado a cada reinício e deploy, então os arquivos dos projetos somem. Para persistir, use um plano pago com disco (veja o bloco comentado no `render.yaml`). O serviço gratuito também hiberna sem uso.

## O que está implementado

- **Chat:** streaming SSE com eventos estruturados (`task.started`, `message.delta`, `tool.started`, `tool.completed`, `tool.failed`, `message.completed`, `task.completed`, `task.failed`), botão de parar, Markdown seguro, cópia de código.
- **Projeto:** arquivos de texto (limites: 200 arquivos, 512 KB cada, 5 MB no total), pastas, renomear, excluir, enviar arquivos de texto, exportar ZIP, histórico de alterações com cópias das versões anteriores, retenção automática.
- **Editor:** abas, indicador de alterações não salvas, Ctrl/Cmd+S.
- **Prévia:** HTML/CSS/JS em iframe isolado (`sandbox`, sem acesso à origem da Siart, URL com token), tamanhos total/tablet/celular, aviso de prévia desatualizada.
- **Documentos:** TXT, MD, CSV, JSON, HTML etc. como arquivos de texto; PDF de texto gerado pela ferramenta `generate_pdf`.
- **Agente:** a Siart lista, lê, grava, edita por patch, cria pastas, renomeia e gera PDF. Não exclui arquivos nem executa código. Se o provedor rejeitar tool calling, segue só com texto.
- **Segurança:** validação de entrada, rate limit, CSP, bloqueio de origem externa, proteção contra path traversal e links simbólicos, isolamento por cliente, código de acesso opcional, logs sem segredos. Ver `PRIVACY.md`.

## Limitações conhecidas

- **Sem contas de usuário.** Cada navegador recebe um identificador em cookie; limpar cookies perde o acesso aos arquivos. `ACCESS_CODE` é uma senha única compartilhada, não um sistema de login.
- **Editor simples (textarea).** Não é o Monaco: não tem realce de sintaxe nem autocompletar. Trocar exige carregar o Monaco de uma CDN ou hospedá-lo e ajustar a CSP.
- **Sem execução de código, testes ou terminal.** A prévia é só para HTML estático e JavaScript de navegador.
- **Sem upload de ZIP, imagens, PDF ou DOCX/XLSX/PPTX**, e sem leitura de anexos ou visão.
- **Sem banco de dados:** o histórico de conversas fica só no navegador.
- **Rate limit em memória:** vale para uma instância só.
- Não foi testado com Groq, Gemini, Mistral ou OpenRouter reais nem em navegador real neste ambiente; os testes usam provedores simulados. Gemini e OpenRouter podem diferir em detalhes do streaming de tool calls; se algum falhar, o log mostra `provider_failed` e a Siart passa ao próximo.
- Gemini 2.5 Pro e outros modelos podem exigir faturamento ativo na conta; sem ele, o provedor retorna 429 ou 403 e a Siart troca.

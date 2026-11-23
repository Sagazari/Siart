# Siart – Fase 1 (fundação funcional)

Chat com streaming, com a chave da Groq guardada só no servidor. Sem dependências externas: usa apenas Node 20+.

## Rodar localmente

```bash
cp .env.example .env        # preencha GROQ_API_KEY
node --env-file=.env src/server.js
# abra http://localhost:3000
npm test                    # 10 testes, sem rede externa
```

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Uso |
|---|---|---|---|
| `GROQ_API_KEY` | sim | – | chave secreta; nunca vai ao navegador nem aos logs |
| `GROQ_MODEL` | não | `openai/gpt-oss-120b` | modelo da Groq |
| `PORT` | não | `3000` | o Render define sozinho |
| `TRUST_PROXY` | não | desligado | `1` no Render, para o rate limit enxergar o IP real |
| `ALLOWED_ORIGIN` | não | – | só se o frontend ficar em outro domínio |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | não | `20` / `60000` | requisições de chat por IP |
| `UPSTREAM_TIMEOUT_MS` | não | `90000` | tempo máximo de uma resposta |
| `MAX_COMPLETION_TOKENS` | não | `4096` | teto de tokens por resposta |

Ao iniciar, o servidor consulta a lista de modelos da Groq e registra um aviso se `GROQ_MODEL` não estiver ativo.
A Groq anunciou em 17/06/2026 a descontinuação de `llama-3.3-70b-versatile` (e de `llama-3.1-8b-instant`), por isso o padrão é `openai/gpt-oss-120b`. Confira a lista atual em console.groq.com/docs/models.

## Deploy no Render

1. Suba esta pasta para um repositório no GitHub (o `.gitignore` já exclui `.env`).
2. No Render: **New → Blueprint** e aponte para o repositório (usa o `render.yaml`), ou crie um **Web Service** com:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`
3. Em **Environment**, preencha `GROQ_API_KEY` como variável secreta.
4. Depois do deploy, abra a URL do serviço. Se aparecer o aviso vermelho sobre `GROQ_API_KEY`, a chave não foi lida.

No plano gratuito o serviço hiberna sem uso, e a primeira requisição pode demorar.

## O que a Fase 1 entrega

- Chat com streaming (SSE) e eventos estruturados: `task.started`, `message.delta`, `message.completed`, `task.completed`, `task.failed`, cada um com `taskId` e `ts`.
- Botão de parar a resposta, cópia de blocos de código, Markdown seguro (tudo é escapado).
- Histórico de conversas **salvo no navegador** (localStorage), com criar, abrir e excluir.
- Servidor: validação de entrada, limite de tamanho, rate limit por IP, bloqueio de origem externa, CSP e demais cabeçalhos, proteção contra path traversal, timeout, encerramento limpo (SIGTERM), `/health`, logs JSON com `requestId` e sem segredos.
- Interface responsiva (barra lateral em painel no celular), foco visível, `prefers-reduced-motion`.

## Pendente (fases seguintes do Prompt Mestre)

- Histórico no servidor/banco (hoje só no navegador, sem contas).
- Arquivos e projetos, editor Monaco, prévia isolada, geração de documentos (Fases 2 a 4).
- Tool calling e modo agente (Fase 5). O system prompt atual declara que a Siart **não** tem ferramentas; atualize `src/systemPrompt.js` quando elas existirem.
- Upload, visão e leitura de PDF.
- Rate limit em memória: vale para uma instância só.
- A interface carrega a fonte Inter do Google Fonts; se preferir, hospede a fonte localmente.
- Visual da interface não foi testado em navegador real neste ambiente.

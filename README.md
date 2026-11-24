# Siart

Plataforma de IA para engenharia de software: chat com streaming, projeto de arquivos, editor, prévia isolada, exportação (ZIP e PDF) e agente com ferramentas. A chave da Groq fica só no servidor. Sem dependências externas: usa apenas Node 20+.

## Rodar localmente

```bash
cp .env.example .env        # preencha GROQ_API_KEY
node --env-file=.env src/server.js
# abra http://localhost:3000
npm test                    # 25 testes, sem rede externa
```

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Uso |
|---|---|---|---|
| `GROQ_API_KEY` | sim | – | chave secreta; nunca vai ao navegador nem aos logs |
| `ACCESS_CODE` | recomendada | – | senha do site. Sem ela, qualquer pessoa com o link usa sua cota da Groq |
| `GROQ_MODEL` | não | `openai/gpt-oss-120b` | modelo da Groq (precisa suportar tool calling para o modo agente) |
| `DATA_DIR` | não | `./data` | onde ficam os arquivos dos projetos |
| `PORT` | não | `3000` | o Render define sozinho |
| `TRUST_PROXY` | não | desligado | `1` no Render, para o rate limit enxergar o IP real e o cookie sair `Secure` |
| `TOOLS_ENABLED` | não | ligado | `0` desliga as ferramentas (só chat) |
| `MAX_TOOL_STEPS` | não | `6` | passos de ferramentas por mensagem |
| `RETENTION_DAYS` | não | `30` | apaga projetos sem uso após N dias |
| `ALLOWED_ORIGIN` | não | – | só se o frontend ficar em outro domínio |
| `RATE_LIMIT_MAX` / `API_RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | não | `20` / `240` / `60000` | chat e demais rotas, por IP |
| `UPSTREAM_TIMEOUT_MS` | não | `120000` | tempo máximo de uma resposta |
| `MAX_COMPLETION_TOKENS` | não | `4096` | teto de tokens por resposta |

Ao iniciar, o servidor consulta a lista de modelos da Groq e registra um aviso se `GROQ_MODEL` não estiver ativo. A Groq anunciou em 17/06/2026 a descontinuação de `llama-3.3-70b-versatile`, por isso o padrão é `openai/gpt-oss-120b`. Confira a lista atual em console.groq.com/docs/models.

## Deploy no Render

1. Suba esta pasta para um repositório no GitHub (o `.gitignore` já exclui `.env` e `data/`).
2. No Render: **New → Blueprint** apontando para o repositório (usa o `render.yaml`), ou crie um **Web Service** com Build `npm install`, Start `npm start`, Health Check `/health`.
3. Em **Environment**, preencha `GROQ_API_KEY` e `ACCESS_CODE`.
4. Abra a URL. Se aparecer o aviso vermelho sobre `GROQ_API_KEY`, a chave não foi lida.

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
- Não foi testado com a Groq real nem em navegador real neste ambiente; os testes usam um provedor simulado.

# Siart

Plataforma de IA para engenharia de software: chat com streaming, projeto de arquivos, editor, prévia isolada, exportação (ZIP e PDF) e agente com ferramentas. A chave da Groq fica só no servidor. Sem dependências externas: usa apenas Node 20+.

## Rodar localmente

```bash
cp .env.example .env        # preencha GROQ_API_KEY
node --env-file=.env src/server.js
# abra http://localhost:3000
npm test                    # 42 testes, sem rede externa
```

## Níveis de IA

| Nível | Para quê | Esforço de raciocínio | Tokens | Ferramentas de projeto |
|---|---|---|---|---|
| **Absoluty GTI 1.2** | Absoluty Grand Technical Intelligence: maior capacidade de raciocínio e ferramentas para tarefas complexas. | alto | 8192 | sim |
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
- **Anexos limitados:** imagens são redimensionadas e enviadas para análise via Gemini; arquivos de texto/código suportados podem ser anexados. ZIP, PDF e documentos Office não são interpretados nesta versão.
- **Sem banco de dados:** o histórico de conversas fica só no navegador.
- **Rate limit em memória:** vale para uma instância só.
- Não foi testado com Groq, Gemini, Mistral ou OpenRouter reais nem em navegador real neste ambiente; os testes usam provedores simulados. Gemini e OpenRouter podem diferir em detalhes do streaming de tool calls; se algum falhar, o log mostra `provider_failed` e a Siart passa ao próximo.
- Gemini 2.5 Pro e outros modelos podem exigir faturamento ativo na conta; sem ele, o provedor retorna 429 ou 403 e a Siart troca.


## Diagnóstico de provedores

- OpenRouter: a cadeia padrão usa `nvidia/nemotron-3-ultra-550b-a55b:free` (ID completo do modelo gratuito). Se você definiu `TIER_ABSOLUTY`, `TIER_MOYENNE` ou `TIER_BASSE` no Render, essa variável substitui a cadeia padrão; atualize/remova IDs antigos nela.
- Mistral: use `MISTRAL_API_KEY` válida. A conta precisa ter acesso ativo à API e faturamento habilitado no Mistral Studio; uma chave criada sem acesso/billing pode retornar 401/402.
- OpenRouter: use `OPENROUTER_API_KEY` válida. Modelos gratuitos têm limites próprios de requisições e podem ficar temporariamente indisponíveis.
- Para conferir o motivo exato de uma falha, abra **Render → serviço Siart → Logs** e procure `provider_failed`; o log inclui provedor, modelo, status HTTP e mensagem retornada pelo gateway, sem registrar a chave secreta.


## Siart AI 1.3.0 — interface e experiência

- Interface monocromática em preto, branco e cinza. A única animação de gradiente é o texto de atividade durante a execução; o status não recebe painel ou fundo colorido.
- Cache-busting da folha de estilos e do JavaScript para que novas publicações não reutilizem os assets antigos.
- Etapas de execução exibidas como texto simples e cartões de arquivos com ações de download e prévia HTML.
- Sugestões rápidas para explicações, resumos, quizzes, planos de estudo e criação de sites.
- Títulos locais das conversas classificados pelo assunto/intenção, em vez de copiar literalmente a primeira mensagem.
- Para criação de sites e documentos, a IA deve assumir padrões profissionais quando faltarem detalhes opcionais, evitando interromper o trabalho para perguntar o título da aba.

**Limites que permanecem:** pesquisa real na web e busca de imagens externas ainda não estão integradas; o modo de estudo usa as capacidades conversacionais do modelo, sem um banco de questões ou currículo próprio. Visão de imagens depende de uma chave Gemini válida. O histórico das conversas continua salvo no navegador.


## Siart AI 1.4.0 — produtividade e identidade esmeralda

- Tema escuro com acentos verde-esmeralda (`#10B981`) para foco, seleção, links, ações e estados de sucesso; o gradiente de atividade continua em preto, branco e reflexos esmeralda.
- Preferências/instruções persistentes por navegador: o usuário pode definir tom, formato e preferências gerais; o texto é enviado ao servidor no contexto da conversa e limitado a 3.000 caracteres.
- Busca local de conversas por título e conteúdo.
- Ação para copiar a resposta completa, além da cópia de blocos de código.
- O prompt do agente reforça planejamento de tarefas, transparência sobre execução, verificação de entregáveis, análise baseada nos arquivos lidos e confirmação antes de ações destrutivas/externas.

### Recursos semelhantes ao Claude que esta arquitetura ainda não oferece

Não há pesquisa web integrada ao agente, conectores externos/MCP, automação de navegador/computador, tarefas agendadas, execução de código/terminal, subagentes paralelos ou sincronização de memória entre dispositivos. As preferências da versão 1.4.0 ficam no `localStorage` do navegador. A análise de anexos continua limitada aos formatos descritos acima. Não apresentar esses recursos como disponíveis até que sejam implementados e testados.

## Siart AI 1.3.3 — revisão obrigatória antes da entrega

- Ao criar ou alterar um site, o agente precisa executar `review_website` antes de liberar a resposta final. Se tentar encerrar sem revisar, o servidor segura a resposta e exige a revisão.
- A revisão verifica HTML (título, viewport, idioma, estrutura, IDs duplicados e âncoras), recursos locais, presença de CSS, media queries responsivas e sintaxe JavaScript sem executar o código.
- Erros encontrados retornam ao agente para correção e nova revisão. O site só é marcado como concluído quando a revisão estática não aponta erros.
- A revisão é estática: não substitui a abertura da prévia nem testes visuais/interativos em um navegador real.


## Siart AI 1.5.0 — interface, movimento, voz e prompt

- **CSS reescrito do zero** (`public/styles.css`): uma única camada, sem pilhas de `!important`. Paleta de cinzas quentes no mesmo princípio do Claude; esmeralda só em ação primária, foco e sucesso. Cartões de arquivo neutros (sem gradiente).
- **Shimmer:** `.shimmer` usa um ladrilho de 200% da largura do texto, deslocado em exatos 200% por ciclo, então o fim do ciclo é idêntico ao começo (sem salto e sem o texto sumir). A fase é sincronizada pelo relógio global, e o brilho continua de onde estava quando a mensagem é reconstruída por um evento do servidor. Em "movimento reduzido" o brilho continua, mais lento.
- **Texto que sobe do chão:** cada palavra, bloco de código e mensagem do usuário é recortada pela própria base (`clip-path`) e sobe de dentro dela (`translateY(105%)` → `0`). Não usa opacidade. O texto chega em fluxo suave mesmo quando o servidor entrega a resposta de uma vez (níveis com ferramentas seguram o texto até saber se haverá chamadas).
- **Voz:** reconhecimento (`SpeechRecognition`) e síntese (`speechSynthesis`) do próprio navegador, gratuitos. A Siart escolhe a melhor voz feminina pt-BR disponível (vozes "Natural" do Edge como Francisca e Thalita, depois "Google português do Brasil", Luciana, etc.), fala em frases curtas para não ser cortada pelo Chrome, e o usuário pode escolher e testar a voz em **Preferências**. Cada resposta tem o botão **Ouvir**. Com a conversa por voz ligada, o servidor recebe `voice: true` e a Siart responde em frases curtas, sem Markdown.
- **Prompt do agente** (`src/prompt.js`): módulos de identidade, honestidade, comunicação, método de engenharia, segurança, ofício de interfaces, protocolo de ferramentas e modo voz.

**Limite honesto da voz:** a qualidade depende das vozes instaladas no aparelho. Sem uma voz neural (Edge) ou do Google (Chrome), o navegador usa uma voz mais robótica. Uma voz neural independente do aparelho exigiria um serviço de TTS no servidor.

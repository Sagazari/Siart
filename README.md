# Siart — Fase 2 (interface e fluxo de criação)

Assistente de programação com streaming via Groq, interface responsiva, indicador animado da Lua, anexos de imagem/texto/código e cartões para baixar arquivos gerados. Requer Node.js 20+ e não usa dependências externas.

## Rodar localmente

```bash
cp .env.example .env  # preencha GROQ_API_KEY
node --env-file=.env src/server.js
# abra http://localhost:3000
npm test
```

## O que esta versão oferece

- Chat com respostas em streaming, botão de parar e histórico local no navegador.
- Lua animada enquanto a Siart está respondendo; indicador de atividade com texto em gradiente.
- Markdown organizado, tabelas, listas e blocos de código com botão de copiar.
- Upload de imagens PNG/JPEG/WebP/GIF e arquivos de texto/código suportados na interface (até 5 MB por arquivo).
- Cartões de arquivos quando a resposta usa o formato `**Arquivo: nome.ext**` seguido de bloco de código. Arquivos podem ser baixados; HTML pode ser aberto em prévia isolada.
- Edição assistida: anexe um arquivo de texto/código e peça as alterações; a Siart recebe o conteúdo no contexto e pode devolver uma versão modificada para download.
- Mensagens limitadas a 8.000 caracteres, validação no navegador e no servidor.
- Chave da Groq permanece no servidor; cabeçalhos de segurança, rate limit por IP, validação de entrada e proteção contra path traversal.

## Limitações importantes

- A leitura de imagens depende de um modelo Groq com suporte a visão. O modelo padrão `openai/gpt-oss-120b` é usado para texto/código; para interpretar imagens, configure `GROQ_MODEL` com um modelo de visão atualmente disponível na sua conta Groq e compatível com entrada de imagem. Se o modelo não aceitar imagens, o provedor retornará erro.
- PDF e documentos binários não são extraídos nesta versão. Use arquivos de texto/código ou converta o conteúdo para texto antes de anexar.
- Não existe pesquisa real na web, execução de código, terminal, editor colaborativo ou agente autônomo nesta fase. O indicador de atividade não finge que essas ferramentas foram usadas.
- Os arquivos gerados são montados no navegador a partir dos blocos de código enviados pela IA; não são gravados automaticamente no repositório nem no servidor.
- Histórico e anexos não são sincronizados entre dispositivos; o histórico fica no localStorage do navegador.
- A prévia HTML usa iframe sandbox, mas ainda assim revise código gerado antes de publicar.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Uso |
|---|---|---|---|
| `GROQ_API_KEY` | sim | — | chave secreta da Groq |
| `GROQ_MODEL` | não | `openai/gpt-oss-120b` | modelo ativo na Groq |
| `PORT` | não | `3000` | porta HTTP |
| `TRUST_PROXY` | não | desligado | use `1` atrás de proxy confiável |
| `ALLOWED_ORIGIN` | não | — | origem permitida quando frontend separado |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | não | `20` / `60000` | limite por IP |
| `UPSTREAM_TIMEOUT_MS` | não | `90000` | timeout do provedor |
| `MAX_COMPLETION_TOKENS` | não | `4096` | teto de tokens de saída |

## Deploy no Render

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`
- Environment: configure `GROQ_API_KEY` como variável secreta e `GROQ_MODEL` conforme o modelo habilitado na sua conta.

Não envie `.env` nem chaves secretas ao GitHub.

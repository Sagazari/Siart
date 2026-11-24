# Privacidade e dados (rascunho técnico, não é aviso legal)

O que a Siart guarda e para onde envia:

- **Conversas:** ficam só no navegador (localStorage). O servidor não grava o histórico do chat.
- **Mensagens enviadas à IA:** cada mensagem, o histórico da conversa e o conteúdo dos arquivos que a Siart lê por ferramenta são enviados à Groq para gerar a resposta. Não envie segredos nem dados pessoais de terceiros.
- **Arquivos do projeto:** ficam no servidor, em `DATA_DIR/clients/<id>`, associados a um identificador aleatório guardado em cookie (`siart_cid`). Quem perder o cookie perde o acesso aos arquivos. Não há contas de usuário.
- **Histórico de alterações:** o servidor guarda um registro (`changes.jsonl`) e até 100 cópias de versões anteriores por projeto.
- **Retenção:** projetos sem uso por `RETENTION_DAYS` (padrão 30) são apagados automaticamente. O botão "Apagar todo o projeto" remove tudo na hora.
- **Logs:** em JSON, com método, caminho, status e tempo. Não registram chaves nem o conteúdo de mensagens ou arquivos.
- **Segredos:** `GROQ_API_KEY` e `ACCESS_CODE` existem só no ambiente do servidor.

Antes de abrir a Siart para terceiros, revise com um profissional de privacidade o texto desta política, a base legal e os prazos.

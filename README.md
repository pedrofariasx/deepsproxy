# DeepsProxy

Proxy API local compatível com OpenAI que roteia requisições para modelos DeepSeek, com integração de automação de navegador via Playwright para execução de ferramentas e interações web.


[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.0-green)](https://hono.dev/)
[![Playwright](https://img.shields.io/badge/Playwright-1.40-blueviolet)](https://playwright.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

---

## ✨ Features

- **OpenAI API Compatible**: Interface compatível com `/v1/chat/completions` e `/v1/models`
- **Tool Execution**: Sistema de ferramentas executáveis via Playwright
- **Session Persistence**: Login persistente com armazenamento de perfil do navegador
- **Long-Context Sessions**: Reutiliza `chat_session_id` e `parent_message_id`, enviando apenas os turnos novos ao continuar uma conversa
- **Safe Concurrency**: Serializa geração de PoW e continuações por sessão, inclusive até o encerramento de streams
- **Authentication**: Suporte opcional a API Key via header `Authorization` ou `X-API-Key`
- **Type-Safe**: Código 100% TypeScript com strict mode
- **Docker Ready**: Deploy simplificado com Docker Compose

---

## 🏗️ Arquitetura

```mermaid
graph TD
    Client[Cliente OpenAI/SDK] -->|HTTPS| Proxy[DeepsProxy]
    Proxy -->|/v1/chat/completions| Handler[Chat Handler]
    Handler --> DeepSeek[DeepSeek API]
    Handler --> Playwright[Playwright Service]
    Playwright --> Browser[Navegador Headless]
    Handler --> Tools[Tools Executor]
    Tools --> Registry[Tool Registry]
    
    subgraph "Configuração"
        Env[.env] --> Proxy
        Profile[deepseek_profile/] --> Playwright
    end
```

---

## 📋 Pré-requisitos

| Dependência | Versão Mínima | Instalação |
|------------|--------------|-----------|
| Node.js | v20.x | [nvm](https://github.com/nvm-sh/nvm) |
| npm | v9.x | Incluído com Node.js |
| Playwright | - | `npx playwright install` |
| Docker (opcional) | v24.x | [Docker Docs](https://docs.docker.com/get-docker/) |

---

## 🚀 Instalação

### Via npm

```bash
# Clonar repositório
git clone https://github.com/pedrofariasx/deepsproxy.git
cd deepsproxy

# Instalar dependências
npm install

# Instalar browsers do Playwright
npx playwright install
```

### Via Docker

```bash
# Build da imagem
docker-compose build

# Iniciar containers
docker-compose up -d
```

---

## ⚙️ Configuração

Crie o arquivo `.env` na raiz do projeto:

```env
# Porta do servidor (default: 3000)
PORT=3000

# Interface HTTP (default seguro: apenas loopback)
HOST=127.0.0.1

# Chave de API para proteger endpoints (obrigatória se HOST não for loopback)
API_KEY=sua-chave-secreta-aqui

# Configurações Playwright
PLAYWRIGHT_HEADLESS=true
PLAYWRIGHT_TIMEOUT=30000

# Fila/tempo máximo total para capturar PoW (inclui espera na fila)
DEEPSPROXY_POW_QUEUE_MAX=32
DEEPSPROXY_POW_TIMEOUT_MS=30000
DEEPSPROXY_POW_CLEANUP_GRACE_MS=1000

# Deadline total de cada stream upstream (ms)
DEEPSPROXY_UPSTREAM_TIMEOUT_MS=300000

# Tempo máximo aguardando outra chamada da mesma conversa (ms)
DEEPSPROXY_SESSION_LEASE_TIMEOUT_MS=30000

# Logging
LOG_LEVEL=info
```

### Variáveis de Ambiente

| Variável | Descrição | Default | Obrigatória |
|----------|-----------|---------|------------|
| `PORT` | Porta HTTP do servidor | `3000` | Não |
| `HOST` | Interface HTTP; use `0.0.0.0` somente quando necessário | `127.0.0.1` | Não |
| `API_KEY` | Chave para autenticação de requests | - | Somente se `HOST` não for loopback |
| `PLAYWRIGHT_HEADLESS` | Executar browser em modo headless | `true` | Não |
| `PLAYWRIGHT_TIMEOUT` | Timeout para operações do Playwright (ms) | `30000` | Não |
| `DEEPSPROXY_POW_QUEUE_MAX` | Máximo de capturas PoW ativas/enfileiradas | `32` | Não |
| `DEEPSPROXY_POW_TIMEOUT_MS` | Deadline total da captura PoW, incluindo fila | `30000` | Não |
| `DEEPSPROXY_POW_CLEANUP_GRACE_MS` | Limite adicional para limpeza após timeout PoW | `1000` | Não |
| `DEEPSPROXY_UPSTREAM_TIMEOUT_MS` | Deadline do stream DeepSeek; libera locks ao expirar | `300000` | Não |
| `DEEPSPROXY_SESSION_LEASE_TIMEOUT_MS` | Limite de espera por uma conversa ocupada | `30000` | Não |

\* Necessária para funcionalidades que requerem acesso à API DeepSeek

### Sessões de contexto longo

O proxy mantém a conversa no histórico remoto do DeepSeek e envia somente os
turnos ainda não registrados. A continuidade explícita usa o campo de extensão
`session_id` (de preferência o valor devolvido pelo proxy) ou os headers
`x-deeps-session`/`x-session-id`. Como fallback, o proxy usa um prefixo exato do
histórico de mensagens. O campo OpenAI `user` mantém sua semântica original e
não identifica conversas.

`/v1/models` anuncia uma janela de 1.000.000 tokens para DeepSeek V4. Em uma
validação real, uma única sessão acumulou 897.555 tokens e recuperou marcadores
do primeiro, do meio e do último segmento. A rota Web ainda limita o tamanho de
um turno individual; a janela longa depende da continuação incremental da mesma
sessão.

---

## 🔐 Autenticação

Se `API_KEY` estiver configurada, todas as requisições devem incluir uma das opções:

```bash
# Via Bearer Token
curl -H "Authorization: Bearer sua-chave" http://localhost:3000/v1/chat/completions

# Via X-API-Key header
curl -H "X-API-Key: sua-chave" http://localhost:3000/v1/chat/completions
```

Resposta para autenticação falha:
```json
{ "error": "Unauthorized" }
```
Status: `401`

Por segurança, o processo exige `API_KEY` quando `HOST` não é loopback. O
DeepsProxy é um adaptador de sessão única: não compartilhe a mesma instância ou
chave entre usuários não confiáveis. Trate os valores `session_id` como
identificadores opacos e não previsíveis.

---

## 📡 API Reference

### Health Check

```http
GET /health
```

**Response** `200 OK`:
```json
{ "status": "ok" }
```

---

### List Models

```http
GET /v1/models
```

**Response** `200 OK`:
```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-flash",
      "object": "model",
      "created": 1715616000,
      "owned_by": "deepseek"
    },
    {
      "id": "deepseek-v4-flash-thinking",
      "object": "model",
      "created": 1715616000,
      "owned_by": "deepseek"
    },
    {
      "id": "deepseek-v4-pro",
      "object": "model",
      "created": 1715616000,
      "owned_by": "deepseek"
    },
    {
      "id": "deepseek-v4-pro-thinking",
      "object": "model",
      "created": 1715616000,
      "owned_by": "deepseek"
    }
  ]
}
```

---

### Chat Completions

```http
POST /v1/chat/completions
Content-Type: application/json
```

**Request Body**:
```json
{
  "model": "deepseek-flash-thinking",
  "messages": [
    { "role": "user", "content": "Qual é a previsão do tempo?" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Obter previsão do tempo",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": false
}
```

**Response** `200 OK`:
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1715616000,
  "model": "deepseek-flash-thinking",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "A previsão para São Paulo é de 24°C com sol.",
        "tool_calls": []
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 45,
    "completion_tokens": 23,
    "total_tokens": 68
  }
}
```

---

## 💻 Exemplos de Uso

### cURL

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash-thinking",
    "messages": [{"role": "user", "content": "Olá!"}]
  }'
```

### OpenAI SDK (Node.js)

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: process.env.API_KEY || 'sk-no-key-required'
});

const completion = await openai.chat.completions.create({
  model: 'deepseek-thinking',
  messages: [{ role: 'user', content: 'Explique TypeScript' }]
});

console.log(completion.choices[0].message.content);
```

### Python (openai library)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-no-key-required"
)

response = client.chat.completions.create(
    model="deepseek-thinking",
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

---

## 🔧 Comandos Disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm start` | Inicia o servidor em produção |
| `npm run dev` | Inicia com hot-reload para desenvolvimento |
| `npm run login` | Executa fluxo de login e salva sessão do navegador |
| `npm test` | Executa suite de testes |
| `npm run build` | Compila TypeScript para `dist/` |
| `npx playwright install` | Instala browsers para automação |

---

## 📁 Estrutura do Projeto

```
deepsproxy/
├── src/
│   ├── index.ts              # Entry point: servidor Hono + middleware
│   ├── routes/
│   │   └── chat.ts          # Handler POST /v1/chat/completions
│   ├── services/
│   │   ├── deepseek.ts      # Cliente API DeepSeek
│   │   └── playwright.ts    # Gerenciamento de browser/session
│   ├── tools/
│   │   ├── executor.ts      # Execução dinâmica de ferramentas
│   │   ├── registry.ts      # Registro e descoberta de tools
│   │   ├── schema.ts        # Validação de schemas JSON
│   │   └── types.ts         # Tipos do sistema de tools
│   ├── runtime/
│   │   ├── engine.ts        # Motor principal de execução
│   │   └── types.ts         # Tipos do runtime
│   ├── types/
│   │   └── openai.ts        # Tipos compatíveis com OpenAI API
│   ├── utils/
│   │   └── types.ts         # Utilitários de tipo
│   ├── login.ts             # Script de autenticação inicial
│   ├── index.test.ts        # Testes unitários básicos
│   └── advanced.test.ts     # Testes de integração avançados
├── docker-compose.yml        # Orquestração multi-container
├── Dockerfile                # Imagem Docker otimizada
├── tsconfig.json            # Configuração TypeScript strict
├── package.json             # Dependências e scripts
├── .env.example             # Template de variáveis de ambiente
└── deepseek_profile/        # Armazenamento de sessão (gitignored)
```

---

## 🐳 Docker

### docker-compose.yml

```yaml
services:
  deepsproxy:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - PLAYWRIGHT_HEADLESS=true
    volumes:
      - ./deepseek_profile:/app/deepseek_profile
    restart: unless-stopped
```

### Build e Execução

```bash
# Build
docker-compose build

# Executar em background
docker-compose up -d

# Ver logs
docker-compose logs -f

# Parar
docker-compose down
```

---

## 🧪 Testes

```bash
# Executar todos os testes
npm test

# Executar com watch mode
npm run test:watch

# Executar testes específicos
npm test -- src/index.test.ts

# Coverage report
npm run test:coverage
```

---

## 🔍 Troubleshooting

### Playwright não inicializa

```bash
# Reinstalar browsers
npx playwright install --with-deps

# Verificar dependências do sistema
npx playwright install-deps
```

### Erro de autenticação

- Verifique se `API_KEY` no `.env` corresponde ao header enviado
- Teste sem `API_KEY` configurada para isolar o problema

### Timeout em requests

- Aumente `PLAYWRIGHT_TIMEOUT` no `.env`
- Verifique conectividade com a API DeepSeek
- Considere executar com `PLAYWRIGHT_HEADLESS=false` para debug visual

### Sessão não persiste

- Certifique-se que `deepseek_profile/` tem permissões de escrita
- Execute `npm run login` para renovar a sessão

---

## 🤝 Contribuindo

1. Fork o repositório
2. Crie uma branch para sua feature: `git checkout -b feature/minha-feature`
3. Commit suas mudanças: `git commit -m 'feat: adiciona minha feature'`
4. Push para a branch: `git push origin feature/minha-feature`
5. Abra um Pull Request

### Guidelines de Código

- Siga o padrão TypeScript strict
- Adicione testes para novas funcionalidades
- Mantenha compatibilidade com OpenAI API spec

---

## 📄 License

Distribuído sob licença ISC. Veja `LICENSE` para mais informações.

---

## ⚠️ Disclaimer

> Este projeto é fornecido estritamente para fins educacionais e de pesquisa.

Os autores não incentivam ou endossam:
- Uso indevido ou malicioso
- Automação não autorizada de serviços terceiros
- Violação de Termos de Serviço de plataformas
- Atividades que violem leis ou regulamentações aplicáveis

Usuários são integralmente responsáveis pelo uso deste software, incluindo conformidade com leis, regulamentos e contratos de serviço aplicáveis.

Este repositório demonstra conceitos relacionados a:
- Automação de navegadores com Playwright
- Gerenciamento de sessões e autenticação
- Arquiteturas de runtime compatíveis com OpenAI
- Padrões de proxy e roteamento de API

**Use por sua conta e risco.**

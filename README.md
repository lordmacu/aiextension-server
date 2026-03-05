# AI Runner Server

Servidor middleware que conecta cualquier aplicacion (via API compatible con OpenAI) con GitHub Copilot corriendo en VS Code. Soporta N conversaciones paralelas simultaneas.

```
Tu App / Laravel / Postman
        |  POST /v1/chat/completions
        v
   AI Runner Server  ─────────────────────>  VS Code Extension
   (Node.js / Docker)    long-poll              (GitHub Copilot)
        ^                                             |
        └─────────────────────────────────────────────┘
              POST /api/save (respuesta)
```

---

## Requisitos

| Opcion | Requisitos |
|--------|-----------|
| **Docker** (recomendado) | Docker + Docker Compose |
| **Manual** | Node.js 18+ |

> La extension VS Code debe estar instalada y corriendo — es quien ejecuta los prompts en Copilot.

---

## Opcion A — Docker (recomendado)

### 1. Clonar el repositorio

```bash
git clone https://github.com/lordmacu/aiextension-server.git
cd aiextension-server
```

### 2. Configurar variables de entorno (opcional)

```bash
cp .env.example .env
# Editar .env si quieres cambiar el puerto o la API key
```

| Variable | Default | Descripcion |
|----------|---------|-------------|
| `PORT` | `54321` | Puerto del servidor |
| `AI_API_KEY` | `finearom-ai-2025` | API key para autenticar requests |

### 3. Levantar

```bash
docker compose up -d
```

El servidor queda disponible en `http://localhost:54321`.

### Comandos utiles Docker

```bash
docker compose up -d          # Levantar en background
docker compose down           # Detener
docker compose logs -f        # Ver logs en tiempo real
docker compose restart        # Reiniciar
docker compose pull && docker compose up -d  # Actualizar imagen
```

### Verificar que funciona

```bash
curl http://localhost:54321/v1/health
# -> {"status":"ok","active":0,"queued":0,"workers":0}
```

---

## Opcion B — Manual (sin Docker)

### 1. Clonar e instalar dependencias

```bash
git clone https://github.com/lordmacu/aiextension-server.git
cd aiextension-server
npm install
```

### 2. Iniciar

```bash
# Desarrollo
node server.js

# Produccion con PM2 (recomendado)
npm install -g pm2
pm2 start server.js --name aiextension-server
pm2 save
pm2 startup   # copiar y ejecutar el comando que imprime
```

### 3. Verificar

```bash
curl http://localhost:54321/v1/health
```

---

## Instalacion en servidor Linux con Apache (produccion)

### 1. Instalar Node.js y PM2

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

### 2. Clonar y configurar

```bash
cd /home/bitnami   # o tu directorio home
git clone https://github.com/lordmacu/aiextension-server.git aiextension
cd aiextension
npm install
```

### 3. Levantar con PM2

```bash
pm2 start server.js --name aiextension-server
pm2 save
pm2 startup   # ejecutar el comando que genera este
```

### 4. Proxy reverso en Apache

Habilitar modulos (una sola vez):

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite
sudo systemctl restart apache2
```

Agregar en tu VirtualHost (`/etc/apache2/sites-available/tu-sitio.conf`):

```apache
<VirtualHost *:443>
    ServerName tu-dominio.com
    # ... tu config SSL existente ...

    # Proxy al servidor AI en ruta /ai/
    # IMPORTANTE: la barra final en ambos lados es obligatoria
    ProxyPass        /ai/ http://127.0.0.1:54321/
    ProxyPassReverse /ai/ http://127.0.0.1:54321/

    # WebSocket (para actualizaciones en tiempo real en la extension)
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/ai/ws$ ws://127.0.0.1:54321/ws [P,L]
</VirtualHost>
```

```bash
sudo systemctl restart apache2
```

El servidor queda disponible en `https://tu-dominio.com/ai/`.

### 5. Configurar la extension VS Code

En VS Code -> Configuracion -> buscar `aiRunner`:

| Setting | Valor |
|---------|-------|
| `aiRunner.serverUrl` | `https://tu-dominio.com/ai` |
| `aiRunner.apiKey` | `finearom-ai-2025` (o tu clave) |

---

## Extension VS Code

La extension ejecuta los prompts en GitHub Copilot. Sin ella el servidor recibe requests pero no puede procesarlos.

### Instalar la extension

```bash
git clone https://github.com/lordmacu/vscode-ai-extension.git
cd vscode-ai-extension
bash install.sh
```

Recargar VS Code (`Cmd+Shift+P` -> Reload Window) y hacer clic en **Iniciar** en el panel AI Runner.

### Verificar conexion

Con la extension activa, el servidor debe mostrar workers conectados:

```bash
curl -H "X-Api-Key: finearom-ai-2025" http://localhost:54321/api/status
# -> {"active":0,"queued":0,"workers":3,"wsClients":1,"pendingResolvers":0}
#                                              ^
#                                              3 workers listos
```

---

## Uso de la API

### Endpoint principal — compatible con OpenAI

```
POST /v1/chat/completions
X-Api-Key: finearom-ai-2025
Content-Type: application/json
```

```json
{
  "model": "gpt-4.1",
  "messages": [
    { "role": "system", "content": "Eres un asistente experto." },
    { "role": "user",   "content": "Cuanto es 2 + 2?" }
  ],
  "stream": false,
  "thread_id": "mi-conversacion-123"
}
```

Respuesta:

```json
{
  "id": "chatcmpl-1234567890",
  "object": "chat.completion",
  "model": "gpt-4.1",
  "thread_id": "mi-conversacion-123",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "2 + 2 = 4" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

### Parametros adicionales (extensiones propias)

| Parametro | Tipo | Descripcion |
|-----------|------|-------------|
| `thread_id` | string | ID de conversacion para continuar un hilo. Omitir para nueva conversacion |
| `justification` | string | Instruccion extra para el modelo |
| `extract_json` | bool | Extraer JSON de la respuesta automaticamente |
| `save_last_message_only` | bool | No guardar historial, solo el ultimo mensaje |
| `max_input_tokens` | int | Limitar tokens de entrada |

### Modelos disponibles

```bash
GET /v1/models
X-Api-Key: finearom-ai-2025
```

Modelos soportados via Copilot:

| Modelo | Notas |
|--------|-------|
| `gpt-4.1` | Default, incluido en Copilot |
| `gpt-4.1-mini` | Mas rapido, menor costo |
| `gpt-4o`, `gpt-4o-mini` | OpenAI |
| `o1`, `o3-mini` | Razonamiento |
| `claude-sonnet-4-5` | Anthropic via Copilot |

### Uso con libreria openai (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://tu-dominio.com/ai/v1",
    api_key="finearom-ai-2025"
)

response = client.chat.completions.create(
    model="gpt-4.1",
    messages=[{"role": "user", "content": "Hola"}],
    extra_body={"thread_id": "conv-001"}
)
print(response.choices[0].message.content)
```

### Uso con libreria openai (Node.js / TypeScript)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://tu-dominio.com/ai/v1',
  apiKey: 'finearom-ai-2025'
});

const response = await client.chat.completions.create({
  model: 'gpt-4.1',
  messages: [{ role: 'user', content: 'Hola' }],
  // @ts-ignore — parametro propio del servidor
  thread_id: 'conv-001'
});
console.log(response.choices[0].message.content);
```

### Uso con Laravel (PHP)

```php
use Illuminate\Support\Facades\Http;

$response = Http::withHeaders([
    'X-Api-Key' => 'finearom-ai-2025',
])->post('https://tu-dominio.com/ai/v1/chat/completions', [
    'model'     => 'gpt-4.1',
    'messages'  => [
        ['role' => 'user', 'content' => 'Analiza estos datos: ...']
    ],
    'thread_id' => 'analisis-cliente-42',
    'stream'    => false,
]);

$content = $response->json('choices.0.message.content');
```

---

## Endpoints de administracion

```bash
# Estado del servidor (workers, cola, conexiones)
GET  /api/status                          X-Api-Key requerido

# Health check basico (sin auth)
GET  /v1/health

# Documentacion interactiva Swagger
GET  /docs

# Listar todas las conversaciones
GET  /v1/threads                          X-Api-Key requerido

# Ver mensajes de una conversacion
GET  /v1/threads/{id}/messages            X-Api-Key requerido

# Eliminar conversacion
DELETE /v1/threads/{id}                   X-Api-Key requerido

# Cancelar prompt en curso (uno o todos)
POST /api/prompt/clear                    X-Api-Key requerido
     {"cancel": true}                     # cancela todos
     {"cancel": true, "conversationId": "x"}  # cancela uno
```

---

## Paralelismo

El servidor soporta cola infinita. La extension procesa **3 conversaciones en paralelo** por defecto.

```
Servidor (cola FIFO)
  promptQueue: [A, B, C, D, ...]
       |
       |---> Worker 0 --> procesa A --> vuelve a esperar
       |---> Worker 1 --> procesa B --> vuelve a esperar
       +---> Worker 2 --> procesa C --> vuelve a esperar
                          D espera en cola hasta que un worker termine
```

Para aumentar el paralelismo cambiar `WORKER_COUNT = 3` en `src/poller.ts` de la extension (requiere reconstruir e instalar la extension).

---

## Estructura de archivos

```
aiextension-server/
├── server.js            <- Servidor principal
├── package.json
├── .env.example         <- Variables de entorno de ejemplo
├── Dockerfile
├── docker-compose.yml
├── deploy.sh            <- Deploy automatico al VPS
├── conversations/       <- Historial JSON (se crea automaticamente)
└── images/              <- Imagenes base64 guardadas (se crea automaticamente)
```

Los directorios `conversations/` e `images/` se montan como volumenes en Docker, por lo que los datos persisten entre reinicios.

---

## Timeouts

| Timeout | Valor | Descripcion |
|---------|-------|-------------|
| `PROCESSING_TIMEOUT` | 5 min | Maximo para que la extension responda |
| `HTTP_TIMEOUT` | 4 min | Maximo que el caller HTTP espera |
| `WORKER_WAIT_TIMEOUT` | 30 s | Long-poll del worker antes de reintentar |
| Extension (Copilot) | 2 min | Timeout interno por prompt en la extension |

---

## Troubleshooting

**Error `401 Unauthorized`**
Falta el header de autenticacion. Agregar: `X-Api-Key: finearom-ai-2025`

**El caller queda colgado sin respuesta**
La extension VS Code no esta corriendo o no tiene workers activos. Verificar en VS Code que el panel AI Runner este en estado activo y muestre workers.

**Apache `503 Service Unavailable`**
Verificar que el `ProxyPass` tenga barra final en ambos lados:
```apache
# CORRECTO
ProxyPass /ai/ http://127.0.0.1:54321/

# INCORRECTO — falta la barra final en la URL del proxy
ProxyPass /ai/ http://127.0.0.1:54321
```

**`Workers: 0` en `/api/status`**
La extension no esta conectada al servidor. Abrir VS Code -> panel AI Runner -> clic en Iniciar.

**Log: `Caller ya habia respondido por timeout`**
El proxy (Apache/Nginx) cierra la conexion antes de que llegue la respuesta. Aumentar el timeout del proxy:
```apache
ProxyTimeout 300
```

**Docker: los datos no persisten**
Verificar que los volumenes esten definidos en `docker-compose.yml` apuntando a los directorios `conversations/` e `images/`.

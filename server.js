const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 54321;

// ─── API KEY ────────────────────────────────────────────────────────────────
const API_KEY = process.env.AI_API_KEY || 'finearom-ai-2025';

// ─── Timeouts ────────────────────────────────────────────────────────────────
const PROCESSING_TIMEOUT  = 5 * 60 * 1000; // 5min — máximo para que la extensión responda
const HTTP_TIMEOUT        = 4 * 60 * 1000; // 4min — máximo que el caller espera colgado
const WORKER_WAIT_TIMEOUT = 30 * 1000;     // 30s — long-poll worker espera

// ─── Estado paralelo ─────────────────────────────────────────────────────────
// Prompts esperando que un worker de la extensión los tome (FIFO exclusivo)
const promptQueue = [];

// Workers de la extensión en long-polling esperando trabajo
const waitingWorkers = [];

// Resolvers por conversationId → { resolve, reject, timeoutId }
const pendingResolvers = new Map();

// Contador de requests activos (en manos de un worker)
let activeCount = 0;

// ─── WebSocket clients ───────────────────────────────────────────────────────
const wsClients = new Set();

// ─── Archivos y directorios ──────────────────────────────────────────────────
const CURRENT_CONV_FILE = path.join(__dirname, 'current-conversation.json');
const CONVERSATIONS_DIR = path.join(__dirname, 'conversations');
const IMAGES_DIR        = path.join(__dirname, 'images');

// Inicializar dirs
if (!fs.existsSync(CONVERSATIONS_DIR)) { fs.mkdirSync(CONVERSATIONS_DIR); }
if (!fs.existsSync(IMAGES_DIR))        { fs.mkdirSync(IMAGES_DIR); }
if (!fs.existsSync(CURRENT_CONV_FILE)) {
  fs.writeFileSync(CURRENT_CONV_FILE, JSON.stringify({ conversationId: null }, null, 2));
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/images', express.static(IMAGES_DIR));

app.use('/api', (req, res, next) => {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida o ausente. Usa el header X-Api-Key.' });
  }
  next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateConversationId() {
  return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function isBase64Image(text) {
  if (!text || typeof text !== 'string') { return false; }
  if (/^data:image\/(png|jpg|jpeg|gif|webp|bmp|svg\+xml);base64,/.test(text)) { return true; }
  const headers = ['iVBORw0KGgo', '/9j/', 'R0lGODlh', 'UklGR', 'Qk0'];
  for (const h of headers) {
    if (text.startsWith(h)) {
      const sample = text.substring(0, Math.min(1000, text.length));
      const ratio = (sample.match(/[A-Za-z0-9+/=]/g)?.length ?? 0) / sample.length;
      if (ratio > 0.95) { return true; }
    }
  }
  return false;
}

function saveBase64Image(base64Data, conversationId) {
  try {
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substr(2, 9);
    let imageBuffer, extension = 'png';
    if (base64Data.startsWith('data:image/')) {
      const matches = base64Data.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
      if (matches) {
        extension = matches[1].replace('svg+xml', 'svg');
        imageBuffer = Buffer.from(matches[2], 'base64');
      }
    } else {
      if (base64Data.startsWith('/9j/'))      { extension = 'jpg'; }
      else if (base64Data.startsWith('R0lGODlh')) { extension = 'gif'; }
      else if (base64Data.startsWith('UklGR'))    { extension = 'webp'; }
      else if (base64Data.startsWith('Qk0'))      { extension = 'bmp'; }
      imageBuffer = Buffer.from(base64Data, 'base64');
    }
    const filename = `${conversationId}_${timestamp}_${randomId}.${extension}`;
    fs.writeFileSync(path.join(IMAGES_DIR, filename), imageBuffer);
    return `/images/${filename}`;
  } catch (error) {
    console.error('Error guardando imagen:', error);
    return null;
  }
}

function getCurrentConversationId(forceNew = false) {
  const data = JSON.parse(fs.readFileSync(CURRENT_CONV_FILE, 'utf8'));
  if (forceNew || !data.conversationId) {
    const newId = generateConversationId();
    fs.writeFileSync(CURRENT_CONV_FILE, JSON.stringify({ conversationId: newId }, null, 2));
    return newId;
  }
  return data.conversationId;
}

function saveToConversation(conversationId, role, text, promptId) {
  const convFile = path.join(CONVERSATIONS_DIR, `${conversationId}.json`);
  let conversation = fs.existsSync(convFile)
    ? JSON.parse(fs.readFileSync(convFile, 'utf8'))
    : { id: conversationId, createdAt: new Date().toISOString(), messages: [] };

  if (promptId != null && !conversation.promptId) {
    conversation.promptId = promptId;
  }

  let finalText = text;
  let isImageMessage = false;
  if (isBase64Image(text)) {
    const imageUrl = saveBase64Image(text, conversationId);
    if (imageUrl) { finalText = imageUrl; isImageMessage = true; }
  }

  const messageObj = { role, text: finalText, timestamp: new Date().toISOString() };
  if (isImageMessage) { messageObj.isImage = true; }
  conversation.messages.push(messageObj);
  conversation.updatedAt = new Date().toISOString();
  fs.writeFileSync(convFile, JSON.stringify(conversation, null, 2));
  return conversation;
}

function extractJsonFromText(text) {
  try {
    const jsonBlock = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlock) { return jsonBlock[1].trim(); }
    const codeBlock = text.match(/```\s*([\s\S]*?)\s*```/);
    if (codeBlock) {
      try { JSON.parse(codeBlock[1].trim()); return codeBlock[1].trim(); } catch (e) {}
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { JSON.parse(jsonMatch[0]); return jsonMatch[0]; } catch (e) {}
    }
  } catch (e) {}
  return text;
}

// Envía estado del servidor a todos los WS conectados
function broadcastStatus() {
  if (wsClients.size === 0) { return; }
  const msg = JSON.stringify({
    type: 'status',
    active: activeCount,
    queued: promptQueue.length,
    workers: waitingWorkers.length
  });
  for (const ws of wsClients) {
    if (ws.readyState === 1) { ws.send(msg); }
  }
}

// Despacha el siguiente prompt de la cola al primer worker disponible (exclusivo)
function dispatchNextToWorker() {
  while (promptQueue.length > 0 && waitingWorkers.length > 0) {
    const prompt = promptQueue.shift();
    const { res, timer } = waitingWorkers.shift();
    clearTimeout(timer);
    console.log(`📡 Dispatch prompt → worker. Queue restante: ${promptQueue.length}, Workers: ${waitingWorkers.length}`);
    res.json(prompt);
    broadcastStatus();
  }
}

// ─── Lógica central ───────────────────────────────────────────────────────────
// Encola el prompt, espera a que la extensión lo procese y devuelva respuesta.
async function executePromptRequest(data, res) {
  if (!data.id) { data.id = generateConversationId(); }
  const convId = String(data.id); // siempre string — evita mismatch numérico en pendingResolvers
  data.id = convId;

  activeCount++;
  broadcastStatus();

  // Crear el Promise y extraer resolve/reject ANTES de despachar al worker
  // Evita race condition: si Copilot responde muy rápido, /api/save puede llegar
  // antes de que el resolver esté registrado en pendingResolvers
  let resolvePromise, rejectPromise;
  const pendingPromise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise  = reject;
  });

  const processingTimeout = setTimeout(() => {
    if (pendingResolvers.has(convId)) {
      pendingResolvers.delete(convId);
      const idx = promptQueue.findIndex(p => p.id === convId);
      if (idx > -1) { promptQueue.splice(idx, 1); }
      activeCount = Math.max(0, activeCount - 1);
      broadcastStatus();
      console.warn(`⏱ PROCESSING_TIMEOUT convId=${convId}`);
      rejectPromise(new Error('Timeout: la extensión no respondió en 5 minutos'));
    }
  }, PROCESSING_TIMEOUT);

  // Registrar en el map ANTES del dispatch
  pendingResolvers.set(convId, { resolve: resolvePromise, reject: rejectPromise, timeoutId: processingTimeout });

  console.log(`🔒 Encolando prompt convId=${convId} (activos=${activeCount}, cola=${promptQueue.length})`);
  promptQueue.push(data);
  dispatchNextToWorker();

  let responded = false;

  const httpTimeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      console.warn(`⏱ HTTP timeout convId=${convId} — respondiendo 504`);
      res.status(504).json({ error: 'Timeout: la IA no respondió en 4 minutos. La tarea sigue procesándose.' });
    }
  }, HTTP_TIMEOUT);

  try {
    await pendingPromise;

    clearTimeout(httpTimeout);
    console.log(`✅ Tarea completada convId=${convId}`);

    if (!responded) {
      responded = true;
      const convFile = path.join(CONVERSATIONS_DIR, `${convId}.json`);
      if (fs.existsSync(convFile)) {
        const conversation = JSON.parse(fs.readFileSync(convFile, 'utf8'));
        return res.json({ success: true, result: conversation });
      }
      res.json({ success: true, message: 'Prompt procesado correctamente' });
    }

  } catch (error) {
    clearTimeout(httpTimeout);
    console.error('Error en executePromptRequest:', error.message);
    if (!responded) {
      responded = true;
      res.status(500).json({ error: error.message });
    }
  }
}

// ─── Cleanup de conversaciones antiguas ──────────────────────────────────────
function cleanupOldConversations(daysOld = 30) {
  try {
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
    let deleted = 0;
    for (const file of files) {
      const filepath = path.join(CONVERSATIONS_DIR, file);
      if (fs.statSync(filepath).mtimeMs < cutoff) { fs.unlinkSync(filepath); deleted++; }
    }
    if (deleted > 0) { console.log(`🧹 Cleanup: ${deleted} conversaciones eliminadas (>${daysOld} días)`); }
  } catch (err) {
    console.error('Error en cleanup:', err.message);
  }
}

cleanupOldConversations();
setInterval(() => cleanupOldConversations(), 24 * 60 * 60 * 1000);

// ─── SWAGGER / API DOCS ───────────────────────────────────────────────────────
app.get('/docs', (req, res) => {
  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'AI Runner Server',
      version: '3.0.0',
      description: 'Middleware entre Finearom y la extension de VS Code que ejecuta prompts en GitHub Copilot.\n\n**Uso recomendado:** rutas `/v1/*` compatibles con la libreria openai cambia baseURL y listo.\n\n**Auth:** header `X-Api-Key` requerido en todas las rutas excepto `/v1/health`.\n\n**Paralelo:** soporta N conversaciones simultaneas. La extension corre N workers que hacen long-poll a `/api/prompt/wait`.'
    },
    servers: [{ url: '', description: 'Este servidor' }],
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' }
      },
      schemas: {
        Message: {
          type: 'object',
          properties: {
            role:      { type: 'string', enum: ['user', 'assistant'] },
            text:      { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
            isImage:   { type: 'boolean', description: 'true si text contiene una URL a una imagen guardada' }
          }
        },
        Conversation: {
          type: 'object',
          properties: {
            id:        { type: 'string' },
            promptId:  { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            messages:  { type: 'array', items: { '$ref': '#/components/schemas/Message' } }
          }
        },
        Status: {
          type: 'object',
          properties: {
            active:           { type: 'integer', description: 'Conversaciones en proceso actualmente' },
            queued:           { type: 'integer', description: 'Prompts esperando en cola' },
            workers:          { type: 'integer', description: 'Workers de la extensión en long-poll' },
            wsClients:        { type: 'integer', description: 'Extensiones VS Code conectadas vía WebSocket' },
            pendingResolvers: { type: 'integer', description: 'Callers colgados esperando respuesta' }
          }
        }
      }
    },
    security: [{ ApiKey: [] }],
    tags: [
      { name: 'OpenAI-compatible', description: 'Rutas compatibles con la libreria openai — cambia baseURL y listo' },
      { name: 'Interno',        description: 'Uso interno de la extension VS Code — no usar directamente' },
      { name: 'Sistema',        description: 'Estado del servidor' }
    ],
    paths: {
      '/api/prompt/wait': {
        get: {
          tags: ['Interno'],
          summary: 'Long-poll: esperar un prompt (worker exclusivo)',
          description: 'La extension corre N workers en paralelo, cada uno llama este endpoint en loop. El servidor le da un prompt EXCLUSIVO (otro worker no lo recibira). Si no hay prompts, espera hasta 30s.\n\n**Nuevo en v3:** cada worker recibe un prompt diferente, habilitando procesamiento paralelo.',
          responses: {
            200: {
              description: 'Prompt para procesar (o vacio si timeout)',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  prompt:      { type: 'string' },
                  newChat:     { type: 'boolean' },
                  id:          { type: 'string', nullable: true, description: 'conversationId' },
                  extractJson: { type: 'boolean' },
                  modelFamily: { type: 'string', nullable: true },
                  justification: { type: 'string', nullable: true },
                  modelOptions: { type: 'object', nullable: true },
                  systemPrompt: { type: 'string', nullable: true },
                  maxInputTokens: { type: 'integer', nullable: true }
                }
              }}}
            }
          }
        }
      },
      '/api/prompt/clear': {
        post: {
          tags: ['Interno'],
          summary: 'Limpiar / cancelar una conversacion',
          description: 'Sin body: no hace nada (compatibilidad).\n\nCon `cancel: true` + `conversationId`: cancela esa conversacion especifica. Sin conversationId cancela todas.',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: {
              cancel:         { type: 'boolean', default: false },
              conversationId: { type: 'string', description: 'ID de la conversacion a cancelar (opcional)' }
            }}}}
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: {
              success:   { type: 'boolean' },
              cancelled: { type: 'boolean' }
            }}}}}
          }
        }
      },
      '/api/save': {
        post: {
          tags: ['Interno'],
          summary: 'Guardar respuesta de la extension',
          description: 'La extension llama esto cuando termina de procesar un prompt. Resuelve el caller por conversationId.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: {
              text:           { type: 'string' },
              prompt:         { type: 'string' },
              promptId:       { type: 'string', description: 'conversationId al que pertenece esta respuesta' },
              extractJson:    { type: 'boolean' }
            }}}}
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: {
              success:       { type: 'boolean' },
              conversationId:{ type: 'string' },
              messageCount:  { type: 'integer' }
            }}}}}
          }
        }
      },
      '/api/status': {
        get: {
          tags: ['Sistema'],
          summary: 'Estado del servidor',
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Status' } } } }
          }
        }
      },
      '/api/prompt/set': {
        post: {
          tags: ['Interno'],
          summary: 'Enviar prompt al servidor (interno)',
          description: 'Alternativa interna. Preferir `/v1/chat/completions` para clientes OpenAI.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: {
              prompt:       { type: 'string' },
              newChat:      { type: 'boolean', default: true },
              id:           { type: 'string', nullable: true, description: 'conversationId' },
              extractJson:  { type: 'boolean', default: false },
              modelFamily:  { type: 'string' },
              justification:{ type: 'string' },
              modelOptions: { type: 'object' },
              systemPrompt: { type: 'string' },
              maxInputTokens: { type: 'integer' }
            }}}}
          },
          responses: {
            200: { description: 'Respuesta procesada', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                result:  { '$ref': '#/components/schemas/Conversation' }
              }
            }}}}
          }
        }
      },
      '/v1/chat/completions': {
        post: {
          tags: ['OpenAI-compatible'],
          summary: 'Chat Completions (OpenAI-compatible)',
          description: 'Endpoint principal. Compatible con la libreria openai: cambia `baseURL` y `apiKey` apuntando a este servidor.\n\n**Extensiones propias:**\n- `thread_id` — continuar conversacion existente (equivale a `conversationId`)\n- `justification` — instruccion extra para el modelo\n- `extract_json` — extrae JSON de la respuesta\n- `save_last_message_only` — no guarda el historial, solo el ultimo mensaje\n- `max_input_tokens` — limita tokens de entrada',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['messages'], properties: {
              model:                  { type: 'string', example: 'gpt-4.1' },
              messages:               { type: 'array', items: { type: 'object', properties: {
                role:    { type: 'string', enum: ['system', 'user', 'assistant'] },
                content: { type: 'string' }
              }}},
              temperature:            { type: 'number' },
              top_p:                  { type: 'number' },
              max_tokens:             { type: 'integer' },
              stream:                 { type: 'boolean', description: 'No soportado, debe ser false' },
              thread_id:              { type: 'string', nullable: true, description: 'conversationId para continuar hilo' },
              justification:          { type: 'string' },
              extract_json:           { type: 'boolean', default: false },
              save_last_message_only: { type: 'boolean', default: false },
              max_input_tokens:       { type: 'integer' }
            }}}}
          },
          responses: {
            200: { description: 'Respuesta en formato OpenAI', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                id:        { type: 'string' },
                object:    { type: 'string', example: 'chat.completion' },
                created:   { type: 'integer' },
                model:     { type: 'string' },
                thread_id: { type: 'string', nullable: true, description: 'conversationId — usar en proximas llamadas para continuar el hilo' },
                choices:   { type: 'array', items: { type: 'object', properties: {
                  index:         { type: 'integer' },
                  message:       { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } } },
                  finish_reason: { type: 'string' }
                }}}
              }
            }}}}
          }
        }
      },
      '/v1/health': {
        get: {
          tags: ['Sistema'],
          summary: 'Health check (sin auth)',
          security: [],
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                status:  { type: 'string', example: 'ok' },
                active:  { type: 'integer' },
                queued:  { type: 'integer' },
                workers: { type: 'integer' },
                uptime:  { type: 'number' }
              }
            }}}}
          }
        }
      },
      '/v1/models': {
        get: {
          tags: ['OpenAI-compatible'],
          summary: 'Lista de modelos disponibles',
          responses: {
            200: { description: 'Lista de modelos', content: { 'application/json': { schema: { type: 'object', properties: {
              object: { type: 'string', example: 'list' },
              data:   { type: 'array', items: { type: 'object', properties: {
                id:         { type: 'string' },
                object:     { type: 'string' },
                created:    { type: 'integer' },
                owned_by:   { type: 'string' }
              }}}
            }}}}}
          }
        }
      },
      '/v1/threads': {
        get: {
          tags: ['OpenAI-compatible'],
          summary: 'Lista de threads/conversaciones',
          responses: {
            200: { description: 'Lista de threads' }
          }
        },
        post: {
          tags: ['OpenAI-compatible'],
          summary: 'Crear thread vacío',
          responses: {
            201: { description: 'Thread creado' }
          }
        }
      },
      '/v1/threads/{id}': {
        get: {
          tags: ['OpenAI-compatible'],
          summary: 'Obtener thread',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Thread' }, 404: { description: 'No encontrado' } }
        },
        delete: {
          tags: ['OpenAI-compatible'],
          summary: 'Eliminar thread',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Eliminado' }, 404: { description: 'No encontrado' } }
        }
      },
      '/v1/threads/{id}/messages': {
        get: {
          tags: ['OpenAI-compatible'],
          summary: 'Mensajes de un thread',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Lista de mensajes' }, 404: { description: 'No encontrado' } }
        }
      },
      '/api/conversations': {
        get: {
          tags: ['Sistema'],
          summary: 'Lista de conversaciones',
          responses: { 200: { description: 'Lista de conversaciones' } }
        }
      },
      '/api/conversations/current': {
        get: {
          tags: ['Sistema'],
          summary: 'Conversacion actual',
          responses: { 200: { description: 'Conversacion actual' } }
        }
      },
      '/api/conversations/{id}': {
        get: {
          tags: ['Sistema'],
          summary: 'Obtener conversacion por ID',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Conversacion' }, 404: { description: 'No encontrada' } }
        },
        delete: {
          tags: ['Sistema'],
          summary: 'Eliminar conversacion',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Eliminada' }, 404: { description: 'No encontrada' } }
        }
      }
    }
  };

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>AI Runner API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head><body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
SwaggerUIBundle({
  spec: ${JSON.stringify(spec)},
  dom_id: '#swagger-ui',
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
  layout: 'BaseLayout',
  deepLinking: true,
  tryItOutEnabled: true,
  defaultModelsExpandDepth: -1,
  requestInterceptor: (req) => { if (!req.headers['X-Api-Key']) req.headers['X-Api-Key'] = 'finearom-ai-2025'; return req; }
});
</script></body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ─── RUTAS INTERNAS (/api/*) ──────────────────────────────────────────────────

// Long-poll: la extensión espera aquí hasta que haya un prompt para ella (exclusivo)
app.get('/api/prompt/wait', (req, res) => {
  // Si hay un prompt en cola, darlo inmediatamente
  if (promptQueue.length > 0) {
    const prompt = promptQueue.shift();
    console.log(`📡 Worker recibe prompt inmediato convId=${prompt.id}. Queue: ${promptQueue.length}`);
    broadcastStatus();
    return res.json(prompt);
  }

  // Sin prompts: esperar hasta WORKER_WAIT_TIMEOUT
  const timer = setTimeout(() => {
    const idx = waitingWorkers.findIndex(w => w.res === res);
    if (idx > -1) { waitingWorkers.splice(idx, 1); }
    res.json({ prompt: '', id: null });
  }, WORKER_WAIT_TIMEOUT);

  res.on('close', () => {
    clearTimeout(timer);
    const idx = waitingWorkers.findIndex(w => w.res === res);
    if (idx > -1) { waitingWorkers.splice(idx, 1); }
  });

  waitingWorkers.push({ res, timer });
  console.log(`⏳ Worker en espera. Workers: ${waitingWorkers.length}, Queue: ${promptQueue.length}`);
});

// Limpiar / cancelar — compatible con versión anterior
app.post('/api/prompt/clear', (req, res) => {
  try {
    const { cancel, conversationId } = req.body || {};

    if (cancel) {
      const cancelOne = (convId) => {
        const pending = pendingResolvers.get(convId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pending.reject(new Error('Request cancelado manualmente vía /api/prompt/clear'));
          pendingResolvers.delete(convId);
          // Remover de la cola si aún no fue tomado
          const idx = promptQueue.findIndex(p => p.id === convId);
          if (idx > -1) { promptQueue.splice(idx, 1); }
          activeCount = Math.max(0, activeCount - 1);
          return true;
        }
        return false;
      };

      if (conversationId) {
        const cancelled = cancelOne(conversationId);
        broadcastStatus();
        console.log(`🛑 Cancelado convId=${conversationId}: ${cancelled}`);
        return res.json({ success: true, cancelled });
      } else {
        // Cancelar todos
        let count = 0;
        for (const [convId] of pendingResolvers.entries()) {
          if (cancelOne(convId)) { count++; }
        }
        broadcastStatus();
        console.log(`🛑 Cancelados ${count} requests`);
        return res.json({ success: true, cancelled: count > 0 });
      }
    }

    res.json({ success: true, cancelled: false });
  } catch (error) {
    res.status(500).json({ error: 'Error al limpiar el prompt' });
  }
});

// Enviar prompt al servidor para que lo procese la extensión
app.post('/api/prompt/set', async (req, res) => {
  try {
    const { prompt, newChat, saveLastMessageOnly, id, extractJson, isImage, focused,
            modelFamily, justification, modelOptions, systemPrompt, maxInputTokens } = req.body;
    if (prompt === undefined) {
      return res.status(400).json({ error: 'El campo "prompt" es requerido' });
    }

    const data = {
      prompt,
      newChat:              newChat              !== undefined ? newChat              : true,
      saveLastMessageOnly:  saveLastMessageOnly  !== undefined ? saveLastMessageOnly  : false,
      id:                   id                   !== undefined ? id                   : null,
      extractJson:          extractJson          !== undefined ? extractJson          : false,
      isImage:              isImage              !== undefined ? isImage              : false,
      focused:              focused              !== undefined ? focused              : false,
      modelFamily:          modelFamily          !== undefined ? modelFamily          : null,
      justification:        justification        !== undefined ? justification        : null,
      modelOptions:         modelOptions         !== undefined ? modelOptions         : null,
      systemPrompt:         systemPrompt         !== undefined ? systemPrompt         : null,
      maxInputTokens:       maxInputTokens       !== undefined ? maxInputTokens       : null,
    };

    console.log(`[Server] /api/prompt/set: "${prompt.substring(0, 80)}..." id=${id}`);
    return await executePromptRequest(data, res);
  } catch (error) {
    console.error('Error en /api/prompt/set:', error);
    res.status(500).json({ error: error.message || 'Error procesando el prompt' });
  }
});

// La extensión llama esto cuando termina de procesar un prompt
app.post('/api/save', (req, res) => {
  try {
    const { text, prompt, extractJson } = req.body;
    if (!text) { return res.status(400).json({ error: 'El campo "text" es requerido' }); }

    let finalText = extractJson ? extractJsonFromText(text) : text;
    const saveLastMessageOnly = req.body.saveLastMessageOnly || false;
    const isNewChat = req.body.newChat !== false;

    let conversationId;
    if (req.body.promptId) {
      conversationId = req.body.promptId.toString();
      fs.writeFileSync(CURRENT_CONV_FILE, JSON.stringify({ conversationId }, null, 2));
    } else {
      conversationId = getCurrentConversationId(isNewChat);
    }

    let conversation;
    if (saveLastMessageOnly) {
      const convFile = path.join(CONVERSATIONS_DIR, `${conversationId}.json`);
      conversation = {
        id: conversationId,
        createdAt: fs.existsSync(convFile)
          ? JSON.parse(fs.readFileSync(convFile, 'utf8')).createdAt
          : new Date().toISOString(),
        messages: []
      };
      if (req.body.promptId) { conversation.promptId = req.body.promptId; }

      let finalTextToSave = finalText;
      let isImageMessage = false;
      if (isBase64Image(finalText)) {
        const imageUrl = saveBase64Image(finalText, conversationId);
        if (imageUrl) { finalTextToSave = imageUrl; isImageMessage = true; }
      }
      const messageObj = { role: 'assistant', text: finalTextToSave, timestamp: new Date().toISOString() };
      if (isImageMessage) { messageObj.isImage = true; }
      conversation.messages.push(messageObj);
      conversation.updatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(CONVERSATIONS_DIR, `${conversationId}.json`), JSON.stringify(conversation, null, 2));
    } else {
      if (prompt) { saveToConversation(conversationId, 'user', prompt, req.body.promptId); }
      conversation = saveToConversation(conversationId, 'assistant', finalText, req.body.promptId);
    }

    console.log(`💾 Respuesta guardada convId=${conversationId}`);

    // Liberar contador y resolver el caller
    activeCount = Math.max(0, activeCount - 1);
    broadcastStatus();

    const pending = pendingResolvers.get(conversationId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pending.resolve();
      pendingResolvers.delete(conversationId);
      console.log(`⚡ Caller notificado convId=${conversationId}`);
    } else {
      console.log(`ℹ️ Caller ya había respondido por timeout (convId=${conversationId})`);
    }

    res.json({ success: true, message: 'Respuesta guardada correctamente', conversationId, messageCount: conversation.messages.length });
  } catch (error) {
    console.error('Error guardando respuesta:', error);
    res.status(500).json({ error: 'Error al guardar la respuesta' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    active:           activeCount,
    queued:           promptQueue.length,
    workers:          waitingWorkers.length,
    wsClients:        wsClients.size,
    pendingResolvers: pendingResolvers.size
  });
});

app.get('/api/conversations', (req, res) => {
  try {
    const files = fs.readdirSync(CONVERSATIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const conv = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, f), 'utf8'));
        return { id: conv.id, createdAt: conv.createdAt, updatedAt: conv.updatedAt, messageCount: conv.messages.length };
      })
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ conversations: files });
  } catch (error) {
    res.status(500).json({ error: 'Error al listar conversaciones' });
  }
});

app.get('/api/conversations/current', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(CURRENT_CONV_FILE, 'utf8'));
    if (!data.conversationId) { return res.json({ conversationId: null, conversation: null }); }
    const convFile = path.join(CONVERSATIONS_DIR, `${data.conversationId}.json`);
    if (!fs.existsSync(convFile)) { return res.json({ conversationId: data.conversationId, conversation: null }); }
    res.json({ conversationId: data.conversationId, conversation: JSON.parse(fs.readFileSync(convFile, 'utf8')) });
  } catch (error) {
    res.status(500).json({ error: 'Error al leer conversación actual' });
  }
});

app.get('/api/conversations/:id', (req, res) => {
  try {
    const convFile = path.join(CONVERSATIONS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(convFile)) {
      return res.status(404).json({ error: 'Conversación no encontrada', id: req.params.id });
    }
    const conversation = JSON.parse(fs.readFileSync(convFile, 'utf8'));
    if (conversation.messages) {
      conversation.messages = conversation.messages.map(msg => {
        if (msg.text && typeof msg.text === 'string') {
          try { return { ...msg, text: JSON.parse(msg.text) }; } catch (e) {
            try {
              const extracted = extractJsonFromText(msg.text);
              if (extracted) { return { ...msg, text: JSON.parse(extracted) }; }
            } catch (e2) {}
          }
        }
        return msg;
      });
    }
    res.json(conversation);
  } catch (error) {
    res.status(500).json({ error: 'Error al leer la conversación' });
  }
});

app.delete('/api/conversations/:id', (req, res) => {
  try {
    const convFile = path.join(CONVERSATIONS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(convFile)) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }
    fs.unlinkSync(convFile);
    res.json({ success: true, message: 'Conversación eliminada', id: req.params.id });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar la conversación' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── RUTAS OpenAI-compatible (/v1/*) ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

app.use('/v1', (req, res, next) => {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (key !== API_KEY) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
  }
  next();
});

app.get('/v1/health', (req, res) => {
  res.json({
    status: activeCount > 0 ? 'busy' : 'ok',
    active: activeCount,
    queued: promptQueue.length,
    workers: waitingWorkers.length,
    wsClients: wsClients.size,
    uptime: process.uptime()
  });
});

app.get('/v1/models', (req, res) => {
  const models = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'claude-sonnet-4-5'];
  res.json({
    object: 'list',
    data: models.map(id => ({
      id,
      object: 'model',
      created: 1710000000,
      owned_by: 'github-copilot',
    }))
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, top_p, max_tokens, stream,
            thread_id, justification, extract_json, save_last_message_only, max_input_tokens } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' } });
    }

    if (stream === true) {
      return res.status(400).json({ error: { message: 'Streaming not supported. Use stream: false', type: 'invalid_request_error' } });
    }

    const systemMsg = messages.find(m => m.role === 'system');
    const systemPrompt = systemMsg?.content || null;

    const userMessages = messages.filter(m => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    if (!lastUser) {
      return res.status(400).json({ error: { message: 'At least one user message is required', type: 'invalid_request_error' } });
    }

    const prompt = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content?.map(p => p.text || '').join('');

    const modelOptions = {};
    if (temperature !== undefined) { modelOptions.temperature = temperature; }
    if (top_p       !== undefined) { modelOptions.top_p       = top_p; }
    if (max_tokens  !== undefined) { modelOptions.max_tokens  = max_tokens; }

    const conversationId = thread_id || null;
    const newChat = !conversationId;

    const data = {
      prompt,
      newChat,
      id:                   conversationId,
      extractJson:          extract_json          ?? false,
      saveLastMessageOnly:  save_last_message_only ?? false,
      isImage:              false,
      focused:              false,
      modelFamily:          model || 'gpt-4.1',
      justification:        justification || null,
      modelOptions:         Object.keys(modelOptions).length ? modelOptions : null,
      systemPrompt:         systemPrompt,
      maxInputTokens:       max_input_tokens || null,
    };

    console.log(`[v1] /chat/completions model=${data.modelFamily} thread=${conversationId || 'new'}`);
    return await executePromptRequest(data, wrapResForV1(res, data.modelFamily, Date.now()));

  } catch (error) {
    console.error('[v1] Error en /chat/completions:', error);
    res.status(500).json({ error: { message: error.message, type: 'server_error' } });
  }
});

// Envuelve res de Express para que executePromptRequest devuelva formato OpenAI
function wrapResForV1(res, modelId, startTime) {
  return {
    status(code) {
      res.status(code);
      return this;
    },
    json(body) {
      if (body.error && typeof body.error === 'string') {
        return res.json({ error: { message: body.error, type: 'server_error' } });
      }
      if (body.success) {
        const conv    = body.result;
        const content = conv?.messages?.slice().reverse().find(m => m.role === 'assistant')?.text
                        ?? body.message
                        ?? '';
        const convId  = conv?.id ?? null;
        return res.json({
          id:      `chatcmpl-${startTime}`,
          object:  'chat.completion',
          created: Math.floor(startTime / 1000),
          model:   modelId || 'gpt-4.1',
          thread_id: convId,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage:   { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      }
      return res.json(body);
    }
  };
}

app.get('/v1/threads', (req, res) => {
  try {
    const files = fs.readdirSync(CONVERSATIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const conv = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, f), 'utf8'));
        return {
          id:         conv.id,
          object:     'thread',
          created_at: Math.floor(new Date(conv.createdAt).getTime() / 1000),
          updated_at: Math.floor(new Date(conv.updatedAt  || conv.createdAt).getTime() / 1000),
          message_count: conv.messages?.length ?? 0,
          metadata:   {}
        };
      })
      .sort((a, b) => b.updated_at - a.updated_at);
    res.json({ object: 'list', data: files });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'server_error' } });
  }
});

app.post('/v1/threads', (req, res) => {
  try {
    const id = req.body.id || generateConversationId();
    const convFile = path.join(CONVERSATIONS_DIR, `${id}.json`);
    if (!fs.existsSync(convFile)) {
      const now = new Date().toISOString();
      fs.writeFileSync(convFile, JSON.stringify({ id, createdAt: now, updatedAt: now, messages: [] }, null, 2));
    }
    const conv = JSON.parse(fs.readFileSync(convFile, 'utf8'));
    res.status(201).json({
      id:         conv.id,
      object:     'thread',
      created_at: Math.floor(new Date(conv.createdAt).getTime() / 1000),
      metadata:   {}
    });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'server_error' } });
  }
});

app.get('/v1/threads/:id', (req, res) => {
  try {
    const convFile = path.join(CONVERSATIONS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(convFile)) {
      return res.status(404).json({ error: { message: 'Thread not found', type: 'invalid_request_error', code: 'thread_not_found' } });
    }
    const conv = JSON.parse(fs.readFileSync(convFile, 'utf8'));
    res.json({
      id:         conv.id,
      object:     'thread',
      created_at: Math.floor(new Date(conv.createdAt).getTime() / 1000),
      updated_at: Math.floor(new Date(conv.updatedAt || conv.createdAt).getTime() / 1000),
      message_count: conv.messages?.length ?? 0,
      metadata:   {}
    });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'server_error' } });
  }
});

app.delete('/v1/threads/:id', (req, res) => {
  try {
    const convFile = path.join(CONVERSATIONS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(convFile)) {
      return res.status(404).json({ error: { message: 'Thread not found', type: 'invalid_request_error' } });
    }
    fs.unlinkSync(convFile);
    res.json({ id: req.params.id, object: 'thread.deleted', deleted: true });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'server_error' } });
  }
});

app.get('/v1/threads/:id/messages', (req, res) => {
  try {
    const convFile = path.join(CONVERSATIONS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(convFile)) {
      return res.status(404).json({ error: { message: 'Thread not found', type: 'invalid_request_error' } });
    }
    const conv = JSON.parse(fs.readFileSync(convFile, 'utf8'));
    const data = (conv.messages || []).map((msg, i) => ({
      id:         `msg_${i}_${conv.id}`,
      object:     'thread.message',
      created_at: Math.floor(new Date(msg.timestamp || conv.createdAt).getTime() / 1000),
      thread_id:  conv.id,
      role:       msg.role,
      content:    [{ type: msg.isImage ? 'image_url' : 'text', [msg.isImage ? 'image_url' : 'text']: msg.isImage ? { url: msg.text } : { value: msg.text } }]
    }));
    res.json({ object: 'list', data });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'server_error' } });
  }
});

// ─── HTTP + WebSocket ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const key = url.searchParams.get('key') || req.headers['x-api-key'];
  if (key !== API_KEY) { ws.close(4001, 'Unauthorized'); return; }

  wsClients.add(ws);
  console.log(`🔌 WS: cliente conectado. Total: ${wsClients.size}`);

  const pingInterval = setInterval(() => { if (ws.readyState === 1) { ws.ping(); } }, 30000);

  ws.on('close', () => { wsClients.delete(ws); clearInterval(pingInterval); console.log(`🔌 WS: desconectado. Total: ${wsClients.size}`); });
  ws.on('error', (err) => { wsClients.delete(ws); clearInterval(pingInterval); console.error(`🔌 WS error:`, err.message); });

  // Enviar estado actual al conectarse
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'AI Runner WS listo',
    active: activeCount,
    queued: promptQueue.length,
    workers: waitingWorkers.length
  }));
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`🔌 WebSocket disponible en ws://localhost:${PORT}/ws`);
  console.log(`🔑 API Key activa`);
  console.log(`⚡ Paralelo: N workers via long-poll /api/prompt/wait`);
  console.log(`🧹 Cleanup automático de conversaciones >30 días`);
  console.log(`📚 Docs: http://localhost:${PORT}/docs`);
});

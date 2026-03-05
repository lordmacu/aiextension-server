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
const PROCESSING_TIMEOUT = 3 * 60 * 1000; // 3min — máximo para que la extensión responda
const HTTP_TIMEOUT       = 2 * 60 * 1000; // 2min — máximo que el caller espera colgado

// ─── Estado global ───────────────────────────────────────────────────────────
let isProcessing = false;
let currentTaskId = null;
let processingStartTime = null;

// ─── Estado del prompt en memoria (evita readFileSync en cada poll) ──────────
const EMPTY_PROMPT = { prompt: '', newChat: true, saveLastMessageOnly: false, id: null, extractJson: false, isImage: false, focused: false, modelFamily: null, justification: null, modelOptions: null, systemPrompt: null, maxInputTokens: null };
let promptState = { ...EMPTY_PROMPT };

// ─── Cola de requests ────────────────────────────────────────────────────────
const requestQueue = [];

// ─── Long-polling: clientes esperando un nuevo prompt ────────────────────────
const waitingClients = [];

// ─── WebSocket clients ───────────────────────────────────────────────────────
const wsClients = new Set();

// ─── Resolvers pendientes por taskId ─────────────────────────────────────────
// taskId -> { resolve, reject, timeoutId }
// Cuando /api/save llega, se resuelven todos (siempre hay máximo uno activo)
const pendingResolvers = new Map();

// ─── Archivos y directorios ──────────────────────────────────────────────────
const PROMPT_FILE       = path.join(__dirname, 'prompt.json');
const CURRENT_CONV_FILE = path.join(__dirname, 'current-conversation.json');
const CONVERSATIONS_DIR = path.join(__dirname, 'conversations');
const IMAGES_DIR        = path.join(__dirname, 'images');

// Inicializar dirs y leer estado inicial desde disco
if (!fs.existsSync(CONVERSATIONS_DIR)) { fs.mkdirSync(CONVERSATIONS_DIR); }
if (!fs.existsSync(IMAGES_DIR))        { fs.mkdirSync(IMAGES_DIR); }
if (!fs.existsSync(CURRENT_CONV_FILE)) {
  fs.writeFileSync(CURRENT_CONV_FILE, JSON.stringify({ conversationId: null }, null, 2));
}
if (fs.existsSync(PROMPT_FILE)) {
  try { promptState = { ...EMPTY_PROMPT, ...JSON.parse(fs.readFileSync(PROMPT_FILE, 'utf8')) }; }
  catch (e) { writePromptState(EMPTY_PROMPT); }
} else {
  fs.writeFileSync(PROMPT_FILE, JSON.stringify(EMPTY_PROMPT, null, 2));
}

// Escribe en disco Y actualiza memoria
function writePromptState(data) {
  promptState = { ...EMPTY_PROMPT, ...data };
  fs.writeFileSync(PROMPT_FILE, JSON.stringify(promptState, null, 2));
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

function resetProcessingState() {
  isProcessing = false;
  currentTaskId = null;
  processingStartTime = null;
}

function checkAndResetTimeout() {
  if (isProcessing && processingStartTime && (Date.now() - processingStartTime > PROCESSING_TIMEOUT)) {
    console.log('⚠️ TIMEOUT global - reseteando estado...');
    resetProcessingState();
    processNextInQueue();
    return true;
  }
  return false;
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

function wsBroadcastPrompt(data) {
  if (wsClients.size === 0) { return; }
  const msg = JSON.stringify({
    type: 'prompt',
    prompt: data.prompt || '',
    newChat: data.newChat !== false,
    saveLastMessageOnly: data.saveLastMessageOnly || false,
    id: data.id || null,
    extractJson: data.extractJson || false,
    isProcessing: true,
    taskId: currentTaskId,
    modelFamily:    data.modelFamily    || null,
    justification:  data.justification  || null,
    modelOptions:   data.modelOptions   || null,
    systemPrompt:   data.systemPrompt   || null,
    maxInputTokens: data.maxInputTokens || null,
  });
  console.log(`🔌 WS: broadcasting prompt a ${wsClients.size} cliente(s)`);
  for (const ws of wsClients) {
    if (ws.readyState === 1) { ws.send(msg); }
  }
}

function notifyWaitingClients(data) {
  if (waitingClients.length === 0) { return; }
  console.log(`📡 Notificando a ${waitingClients.length} clientes en espera (long-poll)`);
  const payload = {
    prompt: data.prompt || '',
    newChat: data.newChat !== false,
    saveLastMessageOnly: data.saveLastMessageOnly || false,
    id: data.id || null,
    extractJson: data.extractJson || false,
    isProcessing,
    taskId: currentTaskId
  };
  while (waitingClients.length > 0) {
    const { res, timer } = waitingClients.shift();
    clearTimeout(timer);
    res.json(payload);
  }
}

function processNextInQueue() {
  if (isProcessing || requestQueue.length === 0) { return; }
  const next = requestQueue.shift();
  console.log(`📋 Procesando siguiente en cola. Restantes: ${requestQueue.length}`);
  executePromptRequest(next.data, next.res);
}

// Resuelve TODOS los resolvers pendientes (siempre hay máximo uno).
// Se llama desde /api/save cuando la extensión termina exitosamente.
function resolveAllPending() {
  if (pendingResolvers.size === 0) { return false; }
  for (const [taskId, pending] of pendingResolvers.entries()) {
    clearTimeout(pending.timeoutId);
    pending.resolve();
    pendingResolvers.delete(taskId);
  }
  return true;
}

// ─── Lógica central ───────────────────────────────────────────────────────────
async function executePromptRequest(data, res) {
  writePromptState(data);

  isProcessing = true;
  currentTaskId = Date.now();
  processingStartTime = Date.now();
  const capturedTaskId = currentTaskId;

  console.log(`🔒 Procesando prompt (Task ID: ${capturedTaskId}, Cola: ${requestQueue.length})`);

  notifyWaitingClients(data);
  wsBroadcastPrompt(data);

  let responded = false;

  const httpTimeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      console.warn(`⏱ HTTP timeout (2min) Task ID: ${capturedTaskId} — respondiendo 504`);
      res.status(504).json({ error: 'Timeout: la IA no respondió en 2 minutos. La tarea sigue procesándose en segundo plano.' });
    }
  }, HTTP_TIMEOUT);

  try {
    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (pendingResolvers.has(capturedTaskId)) {
          pendingResolvers.delete(capturedTaskId);
          console.warn(`⏱ PROCESSING_TIMEOUT (3min) Task ID: ${capturedTaskId}`);
          resetProcessingState();
          processNextInQueue();
          reject(new Error('Timeout: la extensión no respondió en 3 minutos'));
        }
      }, PROCESSING_TIMEOUT);

      pendingResolvers.set(capturedTaskId, { resolve, reject, timeoutId });
    });

    clearTimeout(httpTimeout);
    console.log(`✅ Tarea completada (Task ID: ${capturedTaskId})`);

    if (!responded) {
      responded = true;
      // Si no hay data.id (thread_id null), leer el archivo de conversación actual
      let convId = data.id;
      if (!convId) {
        try {
          const cur = JSON.parse(fs.readFileSync(CURRENT_CONV_FILE, 'utf8'));
          convId = cur.conversationId || null;
        } catch (e) {}
      }
      if (convId) {
        const convFile = path.join(CONVERSATIONS_DIR, `${convId}.json`);
        if (fs.existsSync(convFile)) {
          const conversation = JSON.parse(fs.readFileSync(convFile, 'utf8'));
          res.json({ success: true, result: conversation });
          processNextInQueue();
          return;
        }
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

  processNextInQueue();
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
      version: '2.0.0',
      description: 'Middleware entre Finearom y la extension de VS Code que ejecuta prompts en GitHub Copilot.\n\n**Uso recomendado:** rutas `/v1/*` compatibles con la libreria openai — cambia `baseURL` y listo.\n\n**Auth:** header `X-Api-Key` requerido en todas las rutas excepto `/v1/health`.'
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
            isProcessing:     { type: 'boolean' },
            taskId:           { type: 'integer', nullable: true },
            available:        { type: 'boolean' },
            queueLength:      { type: 'integer', description: 'Requests esperando en cola' },
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
      '/api/prompt/clear': {
        post: {
          tags: ['Interno'],
          summary: 'Limpiar prompt / cancelar request activo',
          description: '**Sin body:** la extensión lo llama al tomar el prompt — solo limpia el archivo, no cancela el caller.\n\n**Con `cancel: true`:** cancela el request activo inmediatamente. El caller recibe error 500 al instante y el sistema queda libre.',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: {
              cancel: { type: 'boolean', default: false, description: '`true` para matar un request colgado' }
            }}}}
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: {
              success:   { type: 'boolean' },
              cancelled: { type: 'boolean', description: 'true si se canceló un request activo' }
            }}}}}
          }
        }
      },
      '/api/prompt': {
        get: {
          tags: ['Interno'],
          summary: 'Estado actual del prompt',
          description: 'La extensión llama esto cada 2s. Responde desde memoria sin tocar disco.',
          responses: {
            200: { description: 'Estado del prompt en memoria', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                prompt:      { type: 'string' },
                newChat:     { type: 'boolean' },
                id:          { type: 'string', nullable: true },
                extractJson: { type: 'boolean' },
                isImage:     { type: 'boolean' },
                focused:     { type: 'boolean' },
                isProcessing:{ type: 'boolean' },
                taskId:      { type: 'integer', nullable: true }
              }
            }}}}
          }
        }
      },
      '/api/prompt/wait': {
        get: {
          tags: ['Interno'],
          summary: 'Long-polling — espera hasta que haya un prompt nuevo',
          description: 'Si hay prompt activo responde de inmediato. Si no, mantiene la conexión abierta hasta 30s.',
          responses: { 200: { description: 'Prompt disponible o respuesta vacía por timeout' } }
        }
      },
      '/api/save': {
        post: {
          tags: ['Interno'],
          summary: 'Guardar respuesta (uso interno de la extensión)',
          description: 'La extensión llama esto cuando Copilot terminó. **Libera al caller de `/api/prompt/set` al instante.**',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: {
              text:        { type: 'string',  description: 'Respuesta del modelo (texto o base64 si isImage=true)' },
              prompt:      { type: 'string',  description: 'Prompt original (para guardarlo en el historial)' },
              promptId:    { type: 'string',  nullable: true, description: 'ID de la conversación' },
              extractJson: { type: 'boolean', default: false }
            }}}}
          },
          responses: {
            200: { description: 'Guardado y caller notificado', content: { 'application/json': { schema: { type: 'object', properties: {
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
          summary: 'Estado del servidor en tiempo real',
          responses: { 200: { description: 'Estado actual', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Status' } } } } }
        }
      },
      '/api/conversations/current': {
        get: {
          tags: ['Interno'],
          summary: 'Conversacion activa actual (uso interno)',
          description: 'Retorna la conversacion que se esta procesando en este momento. Sin equivalente en /v1/*.',
          responses: { 200: { description: 'Conversacion actual o null' } }
        }
      },

      '/v1/health': {
        get: { tags: ['OpenAI-compatible'], summary: 'Health check', security: [],
          responses: { 200: { description: 'Estado del servidor', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Status' } } } } } }
      },
      '/v1/models': {
        get: { tags: ['OpenAI-compatible'], summary: 'Listar modelos disponibles (formato OpenAI)',
          responses: { 200: { description: 'Lista de modelos' } } }
      },
      '/v1/chat/completions': {
        post: {
          tags: ['OpenAI-compatible'],
          summary: 'Chat completions (formato OpenAI)',
          description: 'Endpoint principal. Compatible con la libreria openai apuntando baseURL a este servidor. stream:true NO soportado.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['model', 'messages'], properties: {
              model:                 { type: 'string', example: 'gpt-4.1', enum: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'claude-sonnet-4-5'] },
              messages:              { type: 'array', description: 'Mensajes en formato OpenAI', items: { type: 'object', properties: { role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: { type: 'string' } } } },
              stream:                { type: 'boolean', default: false },
              temperature:           { type: 'number' },
              top_p:                 { type: 'number' },
              max_tokens:            { type: 'integer' },
              thread_id:             { type: 'string', nullable: true, description: 'Extension propia: ID del thread para continuar conversacion', example: 'ia_2064_cliente_2026-03' },
              justification:         { type: 'string', nullable: true, description: 'Extension propia: texto del dialogo de consentimiento de VS Code' },
              extract_json:          { type: 'boolean', default: false, description: 'Extension propia: extrae el primer JSON de la respuesta' },
              save_last_message_only:{ type: 'boolean', default: false, description: 'Extension propia: solo guarda el ultimo mensaje en disco' },
              max_input_tokens:      { type: 'integer', nullable: true, description: 'Extension propia: trunca historial si supera este limite' }
            }}}}
          },
          responses: {
            200: { description: 'Respuesta en formato OpenAI', content: { 'application/json': { schema: { type: 'object', properties: {
              id:        { type: 'string', example: 'chatcmpl-1710000000000' },
              object:    { type: 'string', example: 'chat.completion' },
              model:     { type: 'string' },
              thread_id: { type: 'string', nullable: true, description: 'ID de la conversacion (extension propia)' },
              choices:   { type: 'array', items: { type: 'object', properties: { message: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } } }, finish_reason: { type: 'string' } } } },
              usage:     { type: 'object', properties: { prompt_tokens: { type: 'integer' }, completion_tokens: { type: 'integer' }, total_tokens: { type: 'integer' } } }
            }}}}},
            504: { description: 'Timeout — extension no respondio en 2 minutos' },
            401: { description: 'API key invalida' }
          }
        }
      },
      '/v1/threads': {
        get:  { tags: ['OpenAI-compatible'], summary: 'Listar threads', responses: { 200: { description: 'Lista en formato OpenAI Assistants API' } } },
        post: { tags: ['OpenAI-compatible'], summary: 'Crear thread vacio',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } },
          responses: { 201: { description: 'Thread creado' } } }
      },
      '/v1/threads/{id}': {
        get:    { tags: ['OpenAI-compatible'], summary: 'Obtener thread', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Thread' }, 404: { description: 'No encontrado' } } },
        delete: { tags: ['OpenAI-compatible'], summary: 'Eliminar thread', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Eliminado', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, object: { type: 'string' }, deleted: { type: 'boolean' } } } } } }, 404: { description: 'No encontrado' } } }
      },
      '/v1/threads/{id}/messages': {
        get: { tags: ['OpenAI-compatible'], summary: 'Mensajes de un thread',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Lista de mensajes en formato OpenAI' }, 404: { description: 'No encontrado' } } }
      }
    }
  };

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>AI Runner — API Docs</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .swagger-ui .topbar { background: #1a1a2e; }
    .swagger-ui .topbar .download-url-wrapper { display: none; }
  </style>
</head>
<body>
  <div id="ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      spec: ${JSON.stringify(spec)},
      dom_id: '#ui',
      deepLinking: true,
      tryItOutEnabled: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      requestInterceptor: req => { req.headers['X-Api-Key'] = '${API_KEY}'; return req; }
    });
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>AI Runner Server</title>
    <style>body{font-family:Arial,sans-serif;max-width:500px;margin:50px auto;padding:20px;background:#f5f5f5}
    .box{background:white;padding:24px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    .status{display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:bold}
    .idle{background:#e8f5e9;color:#2e7d32}.busy{background:#fff3e0;color:#e65100}
    code{background:#f5f5f5;padding:2px 6px;border-radius:3px;font-size:13px}</style></head>
    <body><div class="box">
      <h2>🤖 AI Runner Server</h2>
      <p>Estado: <span class="status ${isProcessing ? 'busy' : 'idle'}">${isProcessing ? 'Procesando' : 'Disponible'}</span></p>
      <p>Cola: <strong>${requestQueue.length}</strong> request(s) pendientes</p>
      <p>Puerto: <code>${PORT}</code></p>
      <p>WS clientes: <strong>${wsClients.size}</strong> conectado(s)</p>
      <p>Resolvers pendientes: <strong>${pendingResolvers.size}</strong></p>
    </div></body></html>
  `);
});

// La extensión llama esto cada 2s — responde desde memoria, sin tocar disco
app.get('/api/prompt', (req, res) => {
  checkAndResetTimeout();
  res.json({
    prompt: promptState.prompt || '',
    newChat: promptState.newChat !== false,
    saveLastMessageOnly: promptState.saveLastMessageOnly || false,
    id: promptState.id || null,
    extractJson: promptState.extractJson || false,
    isImage: promptState.isImage || false,
    focused: promptState.focused || false,
    isProcessing,
    taskId: currentTaskId
  });
});

app.get('/api/prompt/wait', (req, res) => {
  checkAndResetTimeout();
  if (promptState.prompt && promptState.prompt.trim()) {
    return res.json({
      prompt: promptState.prompt,
      newChat: promptState.newChat !== false,
      saveLastMessageOnly: promptState.saveLastMessageOnly || false,
      id: promptState.id || null,
      extractJson: promptState.extractJson || false,
      isProcessing,
      taskId: currentTaskId
    });
  }

  const timer = setTimeout(() => {
    const idx = waitingClients.findIndex(c => c.res === res);
    if (idx > -1) { waitingClients.splice(idx, 1); }
    res.json({ prompt: '', isProcessing: false, taskId: null });
  }, 30000);

  res.on('close', () => {
    clearTimeout(timer);
    const idx = waitingClients.findIndex(c => c.res === res);
    if (idx > -1) { waitingClients.splice(idx, 1); }
  });

  waitingClients.push({ res, timer });
});

// La extensión lo llama al inicio del flujo (sin cancel) — solo limpia el prompt, no cancela el resolver.
// Para matar un request colgado manualmente: POST /api/prompt/clear con { cancel: true }
app.post('/api/prompt/clear', (req, res) => {
  try {
    const cancel = req.body?.cancel === true;
    writePromptState(EMPTY_PROMPT);

    if (cancel && isProcessing) {
      const taskIdToKill = currentTaskId;
      resetProcessingState();
      console.log(`🛑 Request cancelado manualmente (Task ID: ${taskIdToKill})`);

      // Rechazar el resolver — el caller recibirá un error 500 inmediatamente
      if (pendingResolvers.size > 0) {
        for (const [taskId, pending] of pendingResolvers.entries()) {
          clearTimeout(pending.timeoutId);
          pending.reject(new Error('Request cancelado manualmente vía /api/prompt/clear'));
          pendingResolvers.delete(taskId);
        }
        console.log(`⚡ Caller notificado del cancelado al instante`);
      }

      processNextInQueue();
    } else if (isProcessing) {
      console.log(`🔓 Prompt tomado por la extensión (Task ID: ${currentTaskId}) — esperando /api/save`);
    }

    res.json({ success: true, cancelled: cancel });
  } catch (error) {
    res.status(500).json({ error: 'Error al limpiar el prompt' });
  }
});

app.post('/api/prompt/set', async (req, res) => {
  try {
    checkAndResetTimeout();

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

    if (!isProcessing) {
      return await executePromptRequest(data, res);
    }

    requestQueue.push({ data, res });
    console.log(`📋 Request encolado. Posición en cola: ${requestQueue.length}`);

  } catch (error) {
    console.error('Error en /api/prompt/set:', error);
    res.status(500).json({ error: error.message || 'Error procesando el prompt' });
  }
});

app.post('/api/save', (req, res) => {
  try {
    const { text, prompt, extractJson } = req.body;
    if (!text) { return res.status(400).json({ error: 'El campo "text" es requerido' }); }

    let finalText = extractJson ? extractJsonFromText(text) : text;

    // Leer newChat y saveLastMessageOnly desde el promptState actual
    // (puede estar vacío si /api/prompt/clear ya corrió, por eso lo leemos del req.body también)
    const isNewChat           = promptState.newChat !== false;
    const saveLastMessageOnly = promptState.saveLastMessageOnly || false;

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

    console.log(`💾 Respuesta guardada en conversación: ${conversationId}`);

    // Liberar estado y notificar al caller al instante
    resetProcessingState();
    const resolved = resolveAllPending();
    if (resolved) {
      console.log(`⚡ Caller notificado al instante`);
    } else {
      console.log(`ℹ️ Caller ya había respondido por timeout`);
    }

    res.json({ success: true, message: 'Respuesta guardada correctamente', conversationId, messageCount: conversation.messages.length });
  } catch (error) {
    console.error('Error guardando respuesta:', error);
    res.status(500).json({ error: 'Error al guardar la respuesta' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    isProcessing,
    taskId: currentTaskId,
    available: !isProcessing,
    queueLength: requestQueue.length,
    wsClients: wsClients.size,
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

// (popup endpoints eliminados)

// ═══════════════════════════════════════════════════════════════════════════════
// ─── RUTAS ESTÁNDAR OpenAI-compatible (/v1/*) ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// Las rutas /api/* internas siguen funcionando (extensión VS Code las usa).
// Estas son aliases con formato estándar para que cualquier cliente OpenAI
// pueda apuntar a este servidor cambiando solo el baseURL.

// ─── Auth middleware para /v1/* ───────────────────────────────────────────────
// Acepta: X-Api-Key, Authorization: Bearer <key>
app.use('/v1', (req, res, next) => {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (key !== API_KEY) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
  }
  next();
});

// ─── GET /v1/health ──────────────────────────────────────────────────────────
app.get('/v1/health', (req, res) => {
  res.json({
    status: isProcessing ? 'busy' : 'ok',
    isProcessing,
    queueLength: requestQueue.length,
    wsClients: wsClients.size,
    pendingResolvers: pendingResolvers.size,
    uptime: process.uptime()
  });
});

// ─── GET /v1/models ──────────────────────────────────────────────────────────
// Devuelve los modelos soportados en formato OpenAI
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

// ─── POST /v1/chat/completions ───────────────────────────────────────────────
// Endpoint principal en formato OpenAI. Traduce al formato interno y espera.
//
// Request OpenAI:
//   model, messages[], temperature, max_tokens, stream
//   + extensiones propias: thread_id, justification, extract_json, save_last_message_only
//
// Response OpenAI:
//   id, object, created, model, choices[{message, finish_reason}], usage
app.post('/v1/chat/completions', async (req, res) => {
  try {
    checkAndResetTimeout();

    const { model, messages, temperature, top_p, max_tokens, stream,
            thread_id, justification, extract_json, save_last_message_only, max_input_tokens } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' } });
    }

    if (stream === true) {
      return res.status(400).json({ error: { message: 'Streaming not supported. Use stream: false', type: 'invalid_request_error' } });
    }

    // Extraer system prompt (primer mensaje con role: 'system')
    const systemMsg = messages.find(m => m.role === 'system');
    const systemPrompt = systemMsg?.content || null;

    // Último mensaje de usuario
    const userMessages = messages.filter(m => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    if (!lastUser) {
      return res.status(400).json({ error: { message: 'At least one user message is required', type: 'invalid_request_error' } });
    }

    const prompt = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content?.map(p => p.text || '').join('');

    // Construir modelOptions a partir de parámetros OpenAI estándar
    const modelOptions = {};
    if (temperature !== undefined) { modelOptions.temperature = temperature; }
    if (top_p       !== undefined) { modelOptions.top_p       = top_p; }
    if (max_tokens  !== undefined) { modelOptions.max_tokens  = max_tokens; }

    // Determinar si es newChat: sin thread_id = nueva conversación
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

    if (isProcessing) {
      requestQueue.push({ data, res: wrapResForV1(res, data.modelFamily, Date.now()) });
      console.log(`📋 [v1] Request encolado. Cola: ${requestQueue.length}`);
      return;
    }

    return await executePromptRequest(data, wrapResForV1(res, data.modelFamily, Date.now()));

  } catch (error) {
    console.error('[v1] Error en /chat/completions:', error);
    res.status(500).json({ error: { message: error.message, type: 'server_error' } });
  }
});

// Envuelve el res de Express para que executePromptRequest devuelva formato OpenAI
function wrapResForV1(res, modelId, startTime) {
  return {
    status(code) {
      res.status(code);
      return this;
    },
    json(body) {
      // Si es error del sistema interno, convertirlo a formato OpenAI
      if (body.error && typeof body.error === 'string') {
        return res.json({ error: { message: body.error, type: 'server_error' } });
      }
      // Si es éxito con result (conversación) → extraer último mensaje del asistente
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
      // Fallback
      return res.json(body);
    }
  };
}

// ─── GET /v1/threads ─────────────────────────────────────────────────────────
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

// ─── POST /v1/threads ────────────────────────────────────────────────────────
// Crear un thread vacío (conversación sin mensajes aún)
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

// ─── GET /v1/threads/:id ─────────────────────────────────────────────────────
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

// ─── DELETE /v1/threads/:id ──────────────────────────────────────────────────
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

// ─── GET /v1/threads/:id/messages ────────────────────────────────────────────
// Devuelve los mensajes de un thread en formato OpenAI
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

  ws.on('close', () => { wsClients.delete(ws); clearInterval(pingInterval); console.log(`🔌 WS: cliente desconectado. Total: ${wsClients.size}`); });
  ws.on('error', (err) => { wsClients.delete(ws); clearInterval(pingInterval); console.error(`🔌 WS error:`, err.message); });

  ws.send(JSON.stringify({ type: 'connected', message: 'AI Runner WS listo' }));
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`🔌 WebSocket disponible en ws://localhost:${PORT}/ws`);
  console.log(`🔑 API Key activa`);
  console.log(`⚡ Resolvers event-driven (sin polling)`);
  console.log(`🧹 Cleanup automático de conversaciones >30 días`);
});

# 🧪 Servidor de Prueba - ChatGPT Extension

Servidor Node.js para probar la funcionalidad automática de la extensión ChatGPT.

## 🚀 Quick Start - Comandos Globales

Después de instalar, usa estos comandos desde **cualquier directorio**:

```bash
chatgpt-ctl restart      # Reiniciar servidor
chatgpt-ctl status       # Ver estado
chatgpt-ctl logs         # Ver logs en tiempo real
chatgpt-ctl test         # Probar que funciona
chatgpt-ctl clear-logs   # Limpiar logs
```

### Instalación de Comandos Globales

```bash
cd /Users/cristian/aiextension/test-server
./install-global-commands.sh
```

Luego abre una nueva terminal y tendrás aliases cortos:
```bash
gpt-restart    # Reiniciar
gpt-status     # Estado
gpt-logs       # Ver logs
gpt-test       # Probar
```

📖 **Documentación:** [GLOBAL-COMMANDS.md](GLOBAL-COMMANDS.md) | [QUICK-COMMANDS.md](QUICK-COMMANDS.md)

---

## 📦 Instalación del Servidor

```bash
cd test-server
npm install
```

## ▶️ Iniciar el servidor

```bash
npm start
```

El servidor se ejecutará en `http://localhost:3000`

## 📡 Endpoints Disponibles

### 1. **GET /** 
Página web con interfaz visual que muestra:
- El prompt que se enviará a ChatGPT
- Lista de todas las historias generadas (se actualiza automáticamente)

### 2. **GET /api/prompt**
Devuelve el prompt para enviar a ChatGPT

**Respuesta:**
```json
{
  "prompt": "Genera una historia corta de un gato"
}
```

### 3. **POST /api/save**
Guarda el texto generado por ChatGPT

**Body:**
```json
{
  "text": "Historia generada por ChatGPT..."
}
```

**Respuesta:**
```json
{
  "success": true,
  "message": "Historia guardada correctamente",
  "total": 5
}
```

### 4. **GET /api/stories**
Obtiene todas las historias guardadas

**Respuesta:**
```json
{
  "stories": [
    {
      "text": "Historia...",
      "timestamp": "2026-01-25T10:30:00.000Z"
    }
  ]
}
```

## 🎯 Cómo usar

1. **Inicia el servidor:**
   ```bash
   npm start
   ```

2. **Abre tu extensión** en cualquier página web

3. **Haz clic en el botón 🧪 (Prueba)** en el header de la extensión

4. **Observa el flujo automático:**
   - ✅ La extensión obtiene el prompt del servidor
   - ✅ Envía el prompt a ChatGPT
   - ✅ Espera a que ChatGPT termine de generar
   - ✅ Envía automáticamente la respuesta al servidor
   - ✅ La historia se guarda en `stories.json`

5. **Ver las historias:** Abre `http://localhost:3000` en tu navegador

## 📁 Archivos

- `server.js` - Servidor Express con los endpoints
- `stories.json` - Archivo JSON donde se guardan las historias
- `package.json` - Dependencias del proyecto

## 🔧 Tecnologías

- **Node.js** - Runtime
- **Express** - Framework web
- **CORS** - Para permitir peticiones desde la extensión

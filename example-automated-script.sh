#!/bin/bash

# Ejemplo: Script automatizado usando chatgpt-ctl
# Este script muestra cómo usar los comandos en automatización

echo "🤖 Script de automatización ChatGPT Assistant"
echo ""

# 1. Asegurar que el servidor está activo
echo "1️⃣  Verificando servidor..."
if ! chatgpt-ctl status &>/dev/null; then
    echo "   ⚠️  Servidor no activo, iniciando..."
    chatgpt-ctl start
    sleep 3
else
    echo "   ✅ Servidor ya activo"
fi

# 2. Probar que funciona
echo ""
echo "2️⃣  Probando endpoints..."
chatgpt-ctl test

# 3. Limpiar logs viejos
echo ""
echo "3️⃣  Limpiando logs antiguos..."
chatgpt-ctl clear-logs

# 4. Obtener URL para usar en requests
echo ""
echo "4️⃣  Configurando URL..."
SERVER_URL=$(chatgpt-ctl url)
echo "   URL: $SERVER_URL"

# 5. Hacer un request de prueba
echo ""
echo "5️⃣  Haciendo request de prueba..."
STATUS=$(curl -s $SERVER_URL/api/status)
echo "   Respuesta: $STATUS"

# 6. Enviar un prompt de ejemplo
echo ""
echo "6️⃣  Enviando prompt de prueba..."
curl -s -X POST $SERVER_URL/api/prompt/set \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Hola, este es un test automatizado",
    "newChat": true,
    "saveLastMessageOnly": true,
    "id": "test_automated_'$(date +%s)'"
  }' | python3 -m json.tool

echo ""
echo "✅ Script completado"
echo ""
echo "💡 Tip: Puedes ver los logs con: chatgpt-ctl logs"

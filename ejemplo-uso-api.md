# Cómo usar el sistema de bloqueo de la API

El servidor ahora tiene un sistema de bloqueo que evita que se procesen múltiples prompts simultáneamente.

## Flujo de procesamiento

1. **Sistema en reposo** → `isProcessing: false`
2. **Extensión lee prompt** → Sistema se bloquea automáticamente → `isProcessing: true`
3. **Procesamiento en ChatGPT** → Sistema permanece bloqueado
4. **Respuesta guardada** → Sistema se desbloquea → `isProcessing: false`

## Endpoints disponibles

### 1. Consultar estado del sistema
```bash
curl http://localhost:3000/api/status
```

**Respuesta cuando está disponible:**
```json
{
  "isProcessing": false,
  "taskId": null,
  "available": true
}
```

**Respuesta cuando está ocupado:**
```json
{
  "isProcessing": true,
  "taskId": 1738012345678,
  "available": false
}
```

### 2. Establecer un nuevo prompt (con protección)

```bash
curl -X POST http://localhost:3000/api/status
```

Si el sistema está disponible, verás:
```json
{
  "isProcessing": false,
  "available": true
}
```

Entonces puedes establecer el prompt:
```bash
curl -X POST http://localhost:3000/api/prompt/set \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Escribe una historia corta",
    "newChat": true,
    "saveLastMessageOnly": false
  }'
```

**Si el sistema está ocupado, recibirás error 409:**
```json
{
  "error": "El sistema está ocupado procesando un prompt. Intenta de nuevo más tarde.",
  "isProcessing": true,
  "taskId": 1738012345678
}
```

## Ejemplo de uso con Node.js

```javascript
async function enviarPromptSeguro(prompt) {
  // 1. Verificar si el sistema está disponible
  const statusRes = await fetch('http://localhost:3000/api/status');
  const status = await statusRes.json();
  
  if (!status.available) {
    console.log('⏳ Sistema ocupado, esperando...');
    // Esperar y reintentar
    await new Promise(resolve => setTimeout(resolve, 2000));
    return enviarPromptSeguro(prompt); // Reintentar
  }
  
  // 2. Sistema disponible, enviar prompt
  try {
    const response = await fetch('http://localhost:3000/api/prompt/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt,
        newChat: true,
        saveLastMessageOnly: false
      })
    });
    
    if (response.status === 409) {
      console.log('⚠️ Conflicto - Alguien más envió un prompt primero');
      // Reintentar
      await new Promise(resolve => setTimeout(resolve, 2000));
      return enviarPromptSeguro(prompt);
    }
    
    const result = await response.json();
    console.log('✅ Prompt enviado:', result);
    return result;
    
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

// Uso
enviarPromptSeguro('Escribe una historia sobre robots');
```

## Ejemplo con Python

```python
import requests
import time

def enviar_prompt_seguro(prompt):
    url_status = 'http://localhost:3000/api/status'
    url_set = 'http://localhost:3000/api/prompt/set'
    
    # 1. Verificar disponibilidad
    while True:
        status = requests.get(url_status).json()
        
        if status['available']:
            break
        
        print('⏳ Sistema ocupado, esperando...')
        time.sleep(2)
    
    # 2. Enviar prompt
    try:
        response = requests.post(url_set, json={
            'prompt': prompt,
            'newChat': True,
            'saveLastMessageOnly': False
        })
        
        if response.status_code == 409:
            print('⚠️ Conflicto - Reintentar en 2 segundos')
            time.sleep(2)
            return enviar_prompt_seguro(prompt)
        
        result = response.json()
        print('✅ Prompt enviado:', result)
        return result
        
    except Exception as e:
        print('❌ Error:', e)
        raise

# Uso
enviar_prompt_seguro('Escribe una historia sobre robots')
```

## Monitoreo en tiempo real

Puedes monitorear el estado del sistema en tiempo real:

```bash
# Linux/Mac
watch -n 1 'curl -s http://localhost:3000/api/status | jq'

# Windows PowerShell
while($true) { 
  curl http://localhost:3000/api/status | ConvertFrom-Json; 
  Start-Sleep -Seconds 1; 
  Clear-Host 
}
```

## Comportamiento automático

La extensión **automáticamente**:
1. Lee el prompt de `/api/prompt`
2. Cuando lo lee, el servidor marca `isProcessing = true`
3. Envía a ChatGPT y espera respuesta
4. Guarda la respuesta en `/api/save`
5. El servidor marca `isProcessing = false`

No necesitas hacer nada especial en la extensión, el bloqueo es transparente.

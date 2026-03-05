# AI Runner Server — Architecture Diagrams

## 1. Server Internal Structure

```mermaid
flowchart TD
    subgraph Server["AI Runner Server (Node.js / Express)"]
        direction TB

        subgraph Auth["Middleware"]
            AK["X-Api-Key validation<br/>all /api/* routes"]
        end

        subgraph Endpoints["HTTP Endpoints"]
            E1["POST /v1/chat/completions<br/>OpenAI-compatible"]
            E2["GET /api/prompt/wait<br/>long-poll for workers"]
            E3["POST /api/save<br/>extension posts response"]
            E4["GET /api/conversations/:id<br/>caller polls for result"]
            E5["GET /api/status<br/>workers, queue, active"]
            E6["GET /v1/threads<br/>DELETE /v1/threads/:id"]
        end

        subgraph State["In-Memory State"]
            PQ["promptQueue<br/>FIFO array"]
            WW["waitingWorkers<br/>array of resolver fns"]
            PR["pendingResolvers<br/>Map convId to resolve/reject"]
            AC["activeCount"]
        end

        subgraph Storage["File Storage"]
            CV["conversations/*.json<br/>one per thread"]
            IM["images/<br/>base64 to PNG files"]
        end

        WS["WebSocket /ws<br/>status broadcasts"]
    end

    E1 --> PQ
    E1 --> PR
    E2 --> WW
    WW -->|dequeue| PQ
    E3 --> PR
    PR -->|resolve| E1
    E3 --> CV
    E4 --> CV
    E6 --> CV
    E5 --> AC
    E5 --> PQ
    E5 --> WW
    AK --> E2
    AK --> E3
    AK --> E4
    AK --> E5
    AK --> E6
```

---

## 2. Request Lifecycle — Happy Path (< 30s)

```mermaid
sequenceDiagram
    participant C as Caller
    participant S as Server
    participant W as Extension Worker

    C->>S: POST /v1/chat/completions
    Note over S: generates convId, enqueues prompt

    alt Worker already long-polling
        S-->>W: prompt + id + modelFamily
    else No worker - prompt waits in queue
        W->>S: GET /api/prompt/wait
        S-->>W: prompt + id + modelFamily
    end

    Note over W: executes via Copilot
    W->>S: POST /api/save text + promptId
    Note over S: resolve pendingResolvers convId

    S-->>C: 200 OK - choices message content
```

---

## 3. Request Lifecycle — Slow Path (> 30s)

```mermaid
sequenceDiagram
    participant C as Caller
    participant S as Server
    participant W as Extension Worker

    C->>S: POST /v1/chat/completions
    Note over S: HTTP_TIMEOUT = 30s, worker not available

    S-->>C: 202 Accepted - conversationId + polling_url

    loop Poll every N seconds
        C->>S: GET /api/conversations/:id
        S-->>C: pending or result when ready
    end

    Note over W: eventually picks up the prompt
    W->>S: POST /api/save text + promptId
    Note over S: writes to conversations/*.json

    C->>S: GET /api/conversations/:id
    S-->>C: 200 result response text
```

---

## 4. Long-Poll Mechanics

```mermaid
sequenceDiagram
    participant W0 as Worker 0
    participant W1 as Worker 1
    participant W2 as Worker 2
    participant S as Server

    par Workers register
        W0->>S: GET /api/prompt/wait
        W1->>S: GET /api/prompt/wait
        W2->>S: GET /api/prompt/wait
    end

    Note over S: waitingWorkers = [W0, W1, W2]<br/>hold up to 30s (WORKER_WAIT_TIMEOUT)

    Note over S: new prompt arrives (POST /v1/chat/completions)

    S-->>W0: { prompt: "...", id: "conv_A", modelFamily: "gpt-4.1" }
    Note over W0: processes prompt

    S-->>W1: { prompt: "", id: null }
    Note over W1: timeout — re-polls immediately

    S-->>W2: { prompt: "", id: null }
    Note over W2: timeout — re-polls immediately

    W0->>S: POST /api/save (response)
    W0->>S: GET /api/prompt/wait (ready for next)
```

---

## 5. Timeout Hierarchy

```mermaid
flowchart LR
    A["Caller sends request"] --> B["Server queues prompt"]
    B --> C{"Worker picks up\nwithin 30s?"}

    C -->|Yes| D["Execute via Copilot\nup to 120s default"]
    C -->|No| E["202 Accepted\n→ caller polls /api/conversations/:id"]

    D --> F{"Copilot responds\nwithin 5 min?"}
    E --> F

    F -->|Yes| G["POST /api/save\n→ 200 to caller"]
    F -->|No| H["PROCESSING_TIMEOUT\nconversation dropped"]

    style E fill:#f0ad4e,color:#000
    style H fill:#d9534f,color:#fff
    style G fill:#5cb85c,color:#fff
```

# Redoor

Redoor is a distributed command execution system consisting of a central server and multiple agents that connect via WebSockets. The server exposes a REST API that allows clients to execute commands on remote agents.

## Overview

```mermaid
flowchart TB
    subgraph Client["REST API Client (UI/CLI)"]
        HTTP[HTTP Requests]
    end

    subgraph Server["Redoor Server"]
        Axum[Axum HTTP Server]
        WS[WebSocket Handler]
        Router[Router Actor]
        Session[Session Actor]
        CmdExec[Command Executor Actor]
        
        Axum --> WS
        Axum --> Router
        WS --> Session
        Session --> Router
        Router --> CmdExec
    end

    subgraph Agents["Redoor Agents"]
        Agent1[Agent Actor 1]
        Agent2[Agent Actor 2]
        Agent3[Agent Actor N...]
    end

    HTTP -->|"REST API<br/>GET /api/v1/agents/{id}/ls"| Axum
    WS <-->|"WebSocket<br/>JSON/Binary"| Agent1
    WS <-->|"WebSocket<br/>JSON/Binary"| Agent2
    WS <-->|"WebSocket<br/>JSON/Binary"| Agent3
```

## Architecture

The server is built on Tokio with Axum for HTTP/WebSocket handling and Ractor for the actor system.

### Actor Hierarchy

```mermaid
flowchart TB
    subgraph Server["Server Process"]
        Main[main.rs]
        
        subgraph Actors["Actor System (Ractor)"]
            Router[RouterActor<br/>- Manages agent registry<br/>- Routes commands<br/>- Tracks pending responses]
            
            subgraph Sessions["Session Actors"]
                Session1[SessionActor<br/>WebSocket Client 1]
                Session2[SessionActor<br/>Agent Connection 1]
                Session3[SessionActor<br/>Agent Connection 2]
            end
            
            CmdExec[CommandExecutorActor<br/>- Executes local commands]
        end
        
        Axum[Axum Router<br/>- REST API endpoints<br/>- WebSocket upgrade]
    end

    Main -->|spawns| Router
    Main -->|spawns| CmdExec
    Main -->|starts| Axum
    
    Axum -->|upgrade| Session1
    Axum -->|upgrade| Session2
    Axum -->|upgrade| Session3
    
    Session1 -->|register/unregister| Router
    Session2 -->|register/unregister| Router
    Session3 -->|register/unregister| Router
    
    Router -.->|routes commands| Session2
    Router -.->|routes commands| Session3
```

### Router Actor State

```mermaid
classDiagram
    class RouterState {
        +HashMap~String, AgentInfo~ agents
        +Vec~ActorRef~SessionMsg~~ web_clients
        +HashMap~String, ActorRef~SessionMsg~~ pending_responses
        +HashMap~u64, RpcReplyPort~CommandResult~~ rest_pending_responses
        +HashMap~u64, Sender~Vec~u8~~ rest_streaming_responses
        +u64 next_request_id
        +next_id() u64
    }
    
    class AgentInfo {
        +String agent_name
        +String socket_id
        +ActorRef~SessionMsg~ session_ref
        +i64 connected_at
        +String os
        +String arch
        +String hostname
        +String username
    }
    
    RouterState --> AgentInfo : manages
```

## Agent Architecture

Agents are standalone binaries that connect to the server and execute commands locally.

```mermaid
flowchart TB
    subgraph AgentProcess["Agent Process (redoor-agent)"]
        Main[main.rs]
        
        subgraph AgentActor["AgentActor"]
            State[AgentState
- agent_id
- agent_name
- server_url
- ws_tx
- active_request_id]
            
            Handler[Message Handler
- Connect
- WebSocketMessage
- ConnectionLost
- Reconnect]
        end
        
        CmdHandler[CommandHandler
- ls, cat, echo
- raw_download
- agent_info]
        
        WS[WebSocket Connection
(tokio-tungstenite)]
    end

    Main -->|spawns| AgentActor
    AgentActor -->|connects to| WS
    AgentActor -->|executes| CmdHandler
    
    WS <-->|WebSocket| Server[(Redoor Server)]
```

## Communication Flows

### 1. Agent Registration

```mermaid
sequenceDiagram
    participant Agent as AgentActor
    participant WS as WebSocket
    participant Session as SessionActor
    participant Router as RouterActor

    Agent->>WS: Connect to /ws
    WS->>Session: Upgrade connection
    Session->>Router: RegisterWebClient
    Agent->>WS: Send AgentRegister JSON
    WS->>Session: IncomingMessage
    Session->>Router: UnregisterWebClient
    Session->>Router: RegisterAgent<br/>(agent_id, name, metadata)
    Router->>Router: Store AgentInfo<br/>in agents HashMap
    Router->>Session: Broadcast AgentList<br/>to all web clients
```

### 2. REST API Command Execution

```mermaid
sequenceDiagram
    participant Client as REST Client
    participant Axum as Axum Handler
    participant Router as RouterActor
    participant Session as SessionActor
    participant Agent as Agent
    participant Cmd as CommandHandler

    Client->>Axum: GET /api/v1/agents/{id}/cat/{path}
    Axum->>Router: ExecuteCommandRest<br/>(agent_id, command, reply_port)
    Router->>Router: Generate request_id
    Router->>Router: Store reply_port in<br/>rest_pending_responses
    Router->>Session: OutgoingMessage(Command)
    Session->>Agent: WebSocket Text (JSON)
    Agent->>Cmd: execute(command)
    Cmd-->>Agent: CommandResult
    Agent->>Session: WebSocket Text (JSON)<br/>CommandResponse
    Session->>Router: RouteResponse<br/>(agent_id, request_id, result)
    Router->>Router: Lookup reply_port by<br/>request_id
    Router-->>Axum: Send CommandResult<br/>via reply_port
    Axum-->>Client: HTTP Response (JSON)
```

### 3. File Streaming (Binary Protocol)

```mermaid
sequenceDiagram
    participant Client as REST Client
    participant Axum as Axum Handler
    participant Router as RouterActor
    participant Session as SessionActor
    participant Agent as Agent
    participant File as Local File

    Client->>Axum: GET /api/v1/agents/{id}/raw/{path}
    Axum->>Router: ExecuteStreamCommandRest
    Router->>Router: Store chunk_sender channel
    Router->>Session: Command (RawDownload)
    Session->>Agent: WebSocket Text (JSON)
    
    loop Read file in chunks (64KB)
        Agent->>File: read(chunk_size)
        File-->>Agent: bytes
        Agent->>Session: WebSocket Binary<br/>StreamChunk
        Session->>Router: RouteStreamChunk
        Router->>Router: Forward to chunk_sender
    end
    
    Agent->>Session: Final chunk (is_last=true)
    Session->>Router: RouteStreamChunk
    Router->>Router: Remove channel
    
    Axum-->>Client: HTTP Stream Response
```

### 4. Binary Protocol Format

```mermaid
packetdiag {
    colwidth = 32
    node_height = 72

    0-31: "Magic (0x52415844)"
    32-95: "Request ID (u64)"
    96-159: "Chunk Index (u64)"
    160-167: "Is Last (u8)"
    168-175: "Is Error (u8)"
    176-183: "Reserved (u8)"
    184-184+n: "Data (n bytes)"
}
```

## Message Types

### JSON Message Protocol

```mermaid
classDiagram
    class Message {
        <<enum>>
        AgentRegister
        AgentUnregister
        AgentList
        Command
        CommandResponse
        Error
    }
    
    class Command {
        <<enum>>
        Ls { path }
        Cat { path }
        RawDownload { path }
        Metadata { path }
        Echo { request }
        AgentInfo
        GetAgentDetails
    }
    
    class CommandResult {
        <<enum>>
        LsDirectory
        LsFile
        Cat
        RawDownload
        Metadata
        Echo
        AgentInfo
        GetAgentDetails
        Error
    }
    
    Message --> Command : contains
    Message --> CommandResult : contains
```

### Router Message Types

```mermaid
flowchart LR
    subgraph RouterMsg["RouterMsg"]
        direction TB
        RegisterAgent["RegisterAgent<br/>(agent_id, name, socket_id, ...)"]
        UnregisterAgent["UnregisterAgent<br/>(agent_id)"]
        RegisterWebClient["RegisterWebClient<br/>(session_ref)"]
        UnregisterWebClient["UnregisterWebClient<br/>(session_ref)"]
        RouteCommand["RouteCommand<br/>(agent_id, command, originating_client)"]
        RouteResponse["RouteResponse<br/>(agent_id, request_id, result)"]
        GetAgentList["GetAgentList<br/>(reply)"]
        ExecuteCommandRest["ExecuteCommandRest<br/>(agent_id, command, reply)"]
        ExecuteStreamCommandRest["ExecuteStreamCommandRest<br/>(agent_id, command, reply, chunk_sender)"]
        RouteStreamChunk["RouteStreamChunk<br/>(agent_id, request_id, chunk_index, is_last, is_error, data)"]
    end
```

## REST API Endpoints

```mermaid
flowchart LR
    subgraph REST["REST API"]
        List["GET /api/v1/agents
List all agents"]
        Details["GET /api/v1/agents/{agent}
Get agent details"]
        Ls["GET /api/v1/agents/{agent}/ls/{path}
List directory/file info"]
        Cat["GET /api/v1/agents/{agent}/cat/{path}
Read file contents"]
        Raw["GET /api/v1/agents/{agent}/raw/{path}
Download file (streaming)"]
        Echo["POST /api/v1/agents/{agent}/echo
Test command"]
    end
    
    subgraph WS["WebSocket"]
        Conn["/ws
Agent connections"]
    end
```

## Data Flow Summary

```mermaid
flowchart LR
    subgraph External["External Clients"]
        UI[Web UI]
        CLI[curl/scripts]
    end
    
    subgraph Server["Redoor Server"]
        REST[REST API Layer]
        Actor[Actor System]
        WebSock[WebSocket Layer]
    end
    
    subgraph Remote["Remote Systems"]
        A1[Agent on Server A]
        A2[Agent on Server B]
        A3[Agent on Server C]
    end
    
    UI -->|HTTP| REST
    CLI -->|HTTP| REST
    REST -->|Actor messages| Actor
    Actor -->|Actor messages| WebSock
    WebSock <-->|WebSocket| A1
    WebSock <-->|WebSocket| A2
    WebSock <-->|WebSocket| A3
```

# CodePilot AI — Ollama Integration Guide

## Overview

CodePilot AI supports Ollama for local AI inference. In **LOCAL ONLY** mode, no source code leaves your machine.

## Recommended Models

### For Agentic Coding (Tool Calling)

| Model | Tool Calling | Context | Memory | Recommended |
|---|---|---|---|---|
| `qwen3:8b` | ✅ Structured | 32K | ~6GB | ✅ **Default** |
| `qwen3:4b` | ✅ Structured | 32K | ~3GB | Good for low RAM |
| `qwen2.5-coder:7b` | ❌ Text-only | 32K | ~5GB | Supported (no tools) |
| `qwen2.5-coder:3b` | ❌ Text-only | 32K | ~3GB | Supported (no tools) |

### For Embeddings (RAG)

| Model | Dimensions | Purpose |
|---|---|---|
| `nomic-embed-text` | 768 | Repository indexing, semantic search |

### For General Chat

| Model | Purpose |
|---|---|
| `llama3.2` | General conversation |

## Setup

### 1. Install Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.ai/install.sh | sh

# Or download from https://ollama.ai
```

### 2. Start Ollama

```bash
ollama serve
```

The server runs at `http://localhost:11434` by default.

### 3. Pull Models

```bash
# Recommended coding model (with tool calling)
ollama pull qwen3:8b

# Embedding model for RAG
ollama pull nomic-embed-text

# Optional: smaller coding model
ollama pull qwen2.5-coder:7b
```

### 4. Verify

```bash
# List available models
curl http://localhost:11434/api/tags | jq '.models[].name'

# Test tool calling with qwen3:8b
curl http://localhost:11434/api/chat -d '{
  "model": "qwen3:8b",
  "messages": [{"role": "user", "content": "What is 2+2?"}],
  "tools": [{"type": "function", "function": {"name": "calculator", "parameters": {"expression": "string"}}}]
}'
```

## Tool Calling

Only certain models support structured tool calls:

**✅ Supports structured tool calls:**
- `qwen3:8b`
- `qwen3:4b`
- `qwen3:14b`

**❌ Returns tool calls as text (not structured):**
- `qwen2.5-coder:7b`
- `qwen2.5-coder:3b`
- `llama3.2`

When using a model that doesn't support structured tool calls, CodePilot will show:
> "Selected model does not support reliable agentic tool calling."

**Recommendation:** Use `qwen3:8b` for the best agent experience.

## Configuration

### VS Code Settings

```json
{
  "codepilot.provider": "ollama",
  "codepilot.model": "qwen3:8b",
  "codepilot.privacyMode": "local",
  "codepilot.localAI.ollama.baseUrl": "http://localhost:11434",
  "codepilot.localAI.ollama.contextLength": 32768,
  "codepilot.localAI.ollama.temperature": 0.7,
  "codepilot.localAI.ollama.numPredict": 4096,
  "codepilot.localAI.ollama.keepAlive": 5
}
```

## Local Hardware Recommendations

| RAM | Recommended Model |
|---|---|
| 8GB | `qwen3:4b` or `qwen2.5-coder:3b` |
| 16GB | `qwen3:8b` or `qwen2.5-coder:7b` |
| 32GB+ | `qwen3:14b` or larger |

## Privacy

When `codepilot.privacyMode` is set to `local`:
- All inference happens locally via Ollama
- No source code is sent to cloud services
- No telemetry is sent externally
- Embeddings are generated locally using `nomic-embed-text`
- RAG indexing uses local PostgreSQL + pgvector

## Troubleshooting

### Ollama not responding

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Restart Ollama
ollama serve

# Check logs
journalctl -u ollama -f
```

### Model not found

```bash
# List available models
ollama list

# Pull the missing model
ollama pull qwen3:8b
```

### Tool calls not working

1. Ensure you're using `qwen3:8b` or another model that supports structured tool calls
2. Check the VS Code Output panel for CodePilot logs
3. Verify Ollama is responding: `curl http://localhost:11434/api/tags`

### High memory usage

- Use a smaller model: `qwen3:4b` instead of `qwen3:8b`
- Reduce `codepilot.localAI.ollama.keepAlive` to unload models faster
- Close other resource-intensive applications

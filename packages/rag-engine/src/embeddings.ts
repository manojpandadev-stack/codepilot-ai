/**
 * Embedding service for CodePilot RAG.
 * Generates vector embeddings using Ollama's embedding models (local-only).
 */

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  promptEvalCount: number;
}

/**
 * Generate embeddings using Ollama's /api/embed endpoint.
 * In LOCAL ONLY mode, this never sends data to cloud services.
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig = {
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
  },
): Promise<EmbeddingResult> {
  const response = await fetch(`${config.baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Ollama embedding failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    embeddings: number[][];
    model: string;
    prompt_eval_count?: number;
  };

  if (!data.embeddings || data.embeddings.length === 0) {
    throw new Error("Ollama returned empty embeddings");
  }

  return {
    embedding: data.embeddings[0]!,
    model: data.model,
    promptEvalCount: data.prompt_eval_count ?? 0,
  };
}

/**
 * Generate embeddings for multiple texts in batch.
 * Processes sequentially to avoid overloading Ollama.
 */
export async function generateBatchEmbeddings(
  texts: string[],
  config: EmbeddingConfig = {
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
  },
  onProgress?: (current: number, total: number) => void,
): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = [];
  for (let i = 0; i < texts.length; i++) {
    const result = await generateEmbedding(texts[i]!, config);
    results.push(result);
    onProgress?.(i + 1, texts.length);
  }
  return results;
}

/**
 * Check if Ollama embedding service is available.
 */
export async function checkEmbeddingService(
  baseUrl: string = "http://localhost:11434",
): Promise<{ available: boolean; model?: string }> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { available: false };

    const data = (await response.json()) as {
      models: Array<{ name: string }>;
    };
    const hasEmbedding = data.models.some(
      (m) => m.name.includes("nomic") || m.name.includes("embed"),
    );
    return {
      available: true,
      model: hasEmbedding ? "nomic-embed-text" : data.models[0]?.name,
    };
  } catch {
    return { available: false };
  }
}

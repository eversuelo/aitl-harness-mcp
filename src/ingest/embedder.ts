/**
 * Embeddings abstraction.
 *
 * Single place that turns text into vectors. Two backends:
 *   - local  : Transformers.js (Xenova/all-MiniLM-L6-v2, 384 dims, no API key) [default]
 *   - voyage : Voyage AI (voyage-3, 1024 dims) [opt-in, needs key]
 *
 * The active backend's dimensionality MUST match the vector index
 * (`src/db/indexes.ts`, `EMBEDDING_DIMS`). Changing models => recreate index + re-embed.
 */

import { settings } from "../config.js";
import { optionalImport } from "../util/optional.js";

export interface Embedder {
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Transformers.js backend. Downloads weights on first use (cached locally). */
export class LocalEmbedder implements Embedder {
  dims = 0;
  private pipe: any = null;
  private modelName: string;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  private async ensurePipe(): Promise<any> {
    if (this.pipe === null) {
      const { pipeline } = await optionalImport("@xenova/transformers");
      this.pipe = await pipeline("feature-extraction", this.modelName);
    }
    return this.pipe;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.ensurePipe();
    const out: number[][] = [];
    for (const t of texts) {
      const res = await pipe(t, { pooling: "mean", normalize: true });
      const vec = Array.from(res.data as Float32Array);
      this.dims = vec.length;
      out.push(vec);
    }
    return out;
  }
}

/** Voyage AI backend (HTTP). */
export class VoyageEmbedder implements Embedder {
  constructor(
    private modelName: string,
    private apiKey: string,
    public dims: number,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: texts, model: this.modelName, input_type: "document" }),
    });
    if (!resp.ok) throw new Error(`Voyage embeddings failed: ${resp.status} ${await resp.text()}`);
    const json = (await resp.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}

let _embedder: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (_embedder === null) {
    if (settings.embeddingProvider === "voyage") {
      if (!settings.voyageApiKey) throw new Error("EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is empty.");
      _embedder = new VoyageEmbedder(settings.embeddingModel, settings.voyageApiKey, settings.embeddingDims);
    } else {
      _embedder = new LocalEmbedder(settings.embeddingModel);
    }
  }
  return _embedder;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await getEmbedder().embed([text]))[0];
}

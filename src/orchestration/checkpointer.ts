/**
 * LangGraph checkpointer backed by MongoDB.
 *
 * Persisting graph state to Mongo gives durable, replayable runs — you can resume or
 * replay from an intermediate checkpoint (a key reason we chose LangGraph). Uses the
 * same MONGODB_URI as everything else, so local and cloud behave identically.
 */

import { settings } from "../config.js";

/**
 * Return a MongoDB-backed LangGraph checkpointer. Imported lazily so the package
 * imports cleanly even if the optional checkpoint package isn't installed yet.
 */
export async function getCheckpointer(): Promise<unknown> {
  const { optionalImport } = await import("../util/optional.js");
  let MongoDBSaver: any;
  try {
    ({ MongoDBSaver } = await optionalImport("@langchain/langgraph-checkpoint-mongodb"));
  } catch (exc) {
    throw new Error(
      "Install `@langchain/langgraph-checkpoint-mongodb` to enable durable checkpoints. " +
        `Original error: ${String(exc)}`,
    );
  }
  return MongoDBSaver.fromConnString(settings.mongodbUri, { dbName: settings.mongodbDb });
}

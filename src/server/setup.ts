/**
 * First-boot setup mode (ADR-0061).
 *
 * While the ACTIVE database has no real user (the auto-generated `local-root`
 * bootstrap does not count, ADR-0026), the API exposes a minimal
 * unauthenticated surface — restricted to loopback callers — so the web wizard
 * can create the Root account and, when Mongo itself is unreachable, fix the
 * connection first. As soon as a real user exists the mode closes itself.
 */

import type { IncomingMessage } from "node:http";

export interface MongoProbe {
  ok: boolean;
  error?: string;
  db?: string;
}

export interface SetupStatus {
  /** True while the wizard should run: Mongo unreachable OR no real users yet. */
  setup_required: boolean;
  mongo: MongoProbe;
  /** null when Mongo is unreachable (can't know). */
  has_real_users: boolean | null;
}

/** Probe the ACTIVE connection + user count (uses the process' Mongoose). */
export async function getSetupStatus(): Promise<SetupStatus> {
  const { settings } = await import("../config.js");
  try {
    const { ensureMongoose } = await import("../db/mongoose.js");
    await ensureMongoose();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { setup_required: true, mongo: { ok: false, error: message }, has_real_users: null };
  }
  const { hasRealUsers } = await import("../auth/users.js");
  const real = await hasRealUsers();
  return {
    setup_required: !real,
    mongo: { ok: true, db: settings.mongodbDb },
    has_real_users: real,
  };
}

/**
 * Try a candidate connection with an EPHEMERAL MongoClient — never touches the
 * process' Mongoose connection (changes apply via guided restart, ADR-0061).
 */
export async function probeMongo(uri: string, db?: string): Promise<MongoProbe> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await client.db(db || "admin").command({ ping: 1 });
    return { ok: true, db };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), db };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Setup endpoints are for the machine's own operator: any LAN host could
 * otherwise create the Root or repoint the server at a hostile Mongo while the
 * DB is down (`listen` binds all interfaces). Same trust model as the
 * local-root bootstrap, which prints its password to the local stdout.
 */
export function isLoopback(req: Pick<IncomingMessage, "socket">): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

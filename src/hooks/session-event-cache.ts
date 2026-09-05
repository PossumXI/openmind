/**
 * Local per-session event cache.
 *
 * The capture hook appends every normalized session event (the exact JSON
 * line it also INSERTs into the sessions-table `message` column) to a local
 * append-only file. The wiki-worker then reads this file instead of
 * re-`SELECT`ing the entire fat `message` column for the *current* session on
 * every periodic / session-end summary trigger.
 *
 * Why this exists: on a long "mega-session" (thousands of rows, tens of MB of
 * message payload) the worker's
 *   SELECT message, creation_date FROM sessions
 *   WHERE path LIKE '%<sessionId>%' ORDER BY creation_date
 * is an unindexed full scan of the fat `message` column. On a cold backend it
 * materializes the whole session (hundreds of MB, 10-16 s) — and the periodic
 * trigger re-pays that cost every ~50 events, re-reading the whole history the
 * client is *already* appending to. The local cache is row-for-row identical
 * to those DB rows, so the worker gets the same content from a local file read
 * (a few ms, zero backend load).
 *
 * The cache is a strict optimization, never a source of truth: whenever it is
 * absent (session resumed on another machine), empty, or shorter than the
 * offset already summarized (an incomplete local copy), the worker falls back
 * to the DB `SELECT`.
 *
 * File: ~/.claude/hooks/session-cache/<session_id>.jsonl
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log as _log } from "../utils/debug.js";

const dlog = (msg: string) => _log("session-event-cache", msg);

const CACHE_DIR = join(homedir(), ".claude", "hooks", "session-cache");

/**
 * Master opt-out. Set HIVEMIND_SESSION_EVENT_CACHE=0 (or "false") to disable
 * both the append (capture side) and the read (worker side), forcing the
 * wiki-worker back onto the DB `SELECT` for every trigger.
 */
export function sessionEventCacheDisabled(): boolean {
  const v = process.env.HIVEMIND_SESSION_EVENT_CACHE;
  return v === "0" || v === "false";
}

export function sessionEventCachePath(sessionId: string): string {
  return join(CACHE_DIR, `${sessionId}.jsonl`);
}

/**
 * Append one already-serialized event line to the session's cache. `line`
 * must not contain a newline — capture builds it via `JSON.stringify`, which
 * escapes embedded newlines, so one file line maps to exactly one event/row.
 * Best-effort: never throws into the capture hot path.
 */
export function appendSessionEvent(sessionId: string, line: string): void {
  if (!sessionId || sessionEventCacheDisabled()) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    appendFileSync(sessionEventCachePath(sessionId), line + "\n");
  } catch (e: any) {
    dlog(`append failed for ${sessionId}: ${e?.message ?? e}`);
  }
}

/**
 * Read the session's cached event lines in append (chronological) order.
 * Returns null when the cache is disabled, missing, or unreadable — the caller
 * then falls back to the DB. Blank lines (including the trailing newline) are
 * dropped so the returned length equals the event/row count.
 */
export function readSessionEventCache(sessionId: string): string[] | null {
  if (!sessionId || sessionEventCacheDisabled()) return null;
  try {
    const raw = readFileSync(sessionEventCachePath(sessionId), "utf-8");
    return raw.split("\n").filter(l => l.length > 0);
  } catch {
    // ENOENT (never captured on this machine) or any read error → DB fallback.
    return null;
  }
}

export type SessionEventCacheErasureResult = {
  state: "VERIFIED" | "FAILED" | "NOT_APPLICABLE";
  detail: string;
};

/**
 * Remove the whole local optimization cache for one session and verify absence.
 *
 * Familiar-memory forgetting deliberately does not rewrite one JSONL line in
 * place: capture may still be appending, and a line-level rewrite could lose
 * unrelated events. Removing the entire cache is safe because this file is not
 * source of truth; the wiki worker already falls back to the database when the
 * cache is missing/incomplete. Future events may recreate the file, but the
 * deleted historical event is not re-appended by that future capture path.
 */
export function eraseSessionEventCache(sessionId: string): SessionEventCacheErasureResult {
  const normalized = sessionId.trim();
  if (!normalized) {
    return { state: "NOT_APPLICABLE", detail: "No source session id was recorded for this familiar memory." };
  }
  if (sessionEventCacheDisabled()) {
    return { state: "NOT_APPLICABLE", detail: "The local session event cache is disabled in this runtime." };
  }

  const path = sessionEventCachePath(normalized);
  try {
    if (existsSync(path)) unlinkSync(path);
    if (existsSync(path)) {
      return { state: "FAILED", detail: "The local session event cache still exists after deletion." };
    }
    return {
      state: "VERIFIED",
      detail: "The affected session optimization cache is absent; source-of-truth history remains in the database.",
    };
  } catch (error) {
    return {
      state: "FAILED",
      detail: `The local session event cache could not be erased: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Best-effort removal of caches whose last write is older than `ttlMs`. Called
 * opportunistically (session-end) so per-session files don't accumulate
 * forever. A freshly-written (current-session) cache has a recent mtime and is
 * never pruned.
 */
export function pruneStaleSessionEventCaches(
  ttlMs: number = 14 * 24 * 3600 * 1000,
  now: number = Date.now(),
): void {
  try {
    for (const name of readdirSync(CACHE_DIR)) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(CACHE_DIR, name);
      try {
        if (now - statSync(p).mtimeMs > ttlMs) unlinkSync(p);
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* dir missing → nothing to prune */ }
}

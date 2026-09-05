/**
 * Shared summary-upload logic for claude-code + codex wiki workers.
 *
 * Combines the summary, size_bytes and description column writes into a
 * SINGLE UPDATE (or INSERT) statement — the Deeplake backend silently
 * drops one of two rapid UPDATEs on the same row, so splitting these
 * across two statements ends up losing the summary column while only
 * description lands.
 */

import { randomUUID } from "node:crypto";
import { embeddingSqlLiteral } from "../embeddings/sql.js";
import { redactSecrets } from "./shared/redact.js";

export type QueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

export interface UploadParams {
  tableName: string;
  vpath: string;
  fname: string;
  userName: string;
  project: string;
  agent: string;
  sessionId: string;
  text: string;
  ts?: string;
  /**
   * Pre-computed nomic embedding of `text` to store alongside the summary.
   * Passing `null` or `undefined` writes SQL NULL — the column stays
   * schema-compatible and the row is still reachable via the lexical
   * retrieval branch, it just won't show up in the semantic branch.
   */
  embedding?: number[] | null;
  /**
   * Hivemind plugin version that produced this summary.
   * - INSERT: omitted lands the column default (''), schema-compatible.
   * - UPDATE: omitted means "don't touch the column" — a refresh from a
   *   legacy spawner that doesn't pass pluginVersion must NOT overwrite
   *   a previously-stored real version with ''. Pass an explicit empty
   *   string when you genuinely want to clear it.
   */
  pluginVersion?: string;
}

export interface UploadResult {
  /**
   * Which write path ran. `"skip"` means a write guard refused to mutate the
   * existing row — no SQL mutation was sent.
   */
  path: "update" | "insert" | "skip";
  sql: string;
  descLength: number;
  summaryLength: number;
}

/** PostgreSQL E-string escaper: doubles backslashes and single quotes, strips control chars. */
export function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

const WHAT_HAPPENED_RE = /## What Happened\n([\s\S]*?)(?=\n##|$)/;

/** Derive the short description from the "## What Happened" section of a wiki summary. */
export function extractDescription(text: string): string {
  const match = text.match(WHAT_HAPPENED_RE);
  return match ? match[1].trim().slice(0, 300) : "completed";
}

/**
 * The SessionStart placeholder sentinel. A row with this description (and no
 * real summary/embedding) is an unfinalized stub created at SessionStart that
 * the wiki worker is expected to replace with a real summary.
 */
export const PLACEHOLDER_DESCRIPTION = "in progress";

/**
 * Controlled-forgetting regeneration barrier.
 *
 * `source-suppression.ts` sets the exact source-session summary to this state
 * only after the promoted source event has been digest-verified and replaced by
 * a non-secret audit tombstone. Ordinary/late wiki workers MUST NOT overwrite
 * this row, even with a fully finalized summary, because their input may have
 * been captured before source suppression completed.
 *
 * A later governed regeneration workflow may clear this sentinel explicitly
 * after rebuilding from the tombstoned source history. `uploadSummary()` itself
 * never clears it.
 */
export const FAMILIAR_FORGET_HOLD_DESCRIPTION = "familiar-memory-forget-hold";

/**
 * Is `desc` a finalized (real) description? A finalized row has a description
 * that is non-empty and is neither a SessionStart placeholder nor a controlled
 * forgetting HOLD sentinel.
 *
 * Proactive recall only surfaces normal completed summaries; a forgetting HOLD
 * is deliberately not considered finalized/recallable state.
 */
export function isFinalizedDescription(desc: unknown): boolean {
  if (typeof desc !== "string") return false;
  const d = desc.trim();
  return d !== "" && d !== PLACEHOLDER_DESCRIPTION && d !== FAMILIAR_FORGET_HOLD_DESCRIPTION;
}

/**
 * Is the EXISTING row (`summary`, `description`) a FINALIZED summary — i.e.
 * one that proactive recall can surface? Requires a non-empty summary body AND
 * a real (non-placeholder/non-HOLD) description. Used as the finalize-wins
 * guard: a finalized row must never be clobbered back to a placeholder/stub.
 */
export function isFinalizedRow(summary: unknown, description: unknown): boolean {
  const hasSummary = typeof summary === "string" && summary.trim() !== "";
  return hasSummary && isFinalizedDescription(description);
}

/**
 * Does `text` look like a REAL (finalized) wiki summary, as opposed to the
 * SessionStart placeholder or an empty/content-free stub?
 *
 * The wiki worker's prompt always emits a populated "## What Happened" section;
 * the SessionStart placeholder never does. So the presence of a non-empty
 * "## What Happened" body is the reliable signal that this write carries a real
 * summary. `extractDescription`'s "completed" fallback alone is NOT a reliable
 * signal, because a content-free stub also lands "completed" and would
 * otherwise masquerade as finalized and clobber a real row.
 */
export function isFinalizedSummaryText(text: unknown): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  const match = text.match(WHAT_HAPPENED_RE);
  return match ? match[1].trim() !== "" : false;
}

/**
 * Upload or refresh a wiki summary row.
 *
 * IMPORTANT: summary and description must stay in the SAME SQL statement.
 * See module docstring for the rationale.
 *
 * The forgetting HOLD is enforced twice: once after the read and again in the
 * SQL mutation predicate. The latter closes the TOCTOU window where an older
 * wiki worker read a normal row immediately before source suppression placed it
 * on HOLD.
 */
export async function uploadSummary(query: QueryFn, params: UploadParams): Promise<UploadResult> {
  const { tableName, vpath, fname, userName, project, agent } = params;
  // Mask any secret a summary may have quoted before it's stored/indexed.
  const text = redactSecrets(params.text);
  const ts = params.ts ?? new Date().toISOString();
  const desc = extractDescription(text);
  const sizeBytes = Buffer.byteLength(text);
  const embSql = embeddingSqlLiteral(params.embedding ?? null);
  // Keep undefined sentinel for UPDATE conditional. INSERT still defaults to ''.
  const pluginVersion = params.pluginVersion;
  const safePath = esc(vpath);
  const safeHold = esc(FAMILIAR_FORGET_HOLD_DESCRIPTION);

  const existing = await query(
    `SELECT path, summary, description FROM "${tableName}" WHERE path = '${safePath}' LIMIT 1`
  );

  if (existing.length > 0) {
    const existingDescription = existing[0]["description"];

    // FORGET-HOLD WINS over every ordinary wiki writer, including a writer
    // that already generated a valid finalized summary before suppression.
    // Only a separate governed regeneration path may clear the sentinel.
    if (existingDescription === FAMILIAR_FORGET_HOLD_DESCRIPTION) {
      return { path: "skip", sql: "", descLength: desc.length, summaryLength: text.length };
    }

    // FINALIZE-WINS: a finalized row (real summary + non-placeholder
    // description) must never be clobbered back to a placeholder/stub.
    const incomingFinalized = isFinalizedSummaryText(text);
    const existingFinalized = isFinalizedRow(existing[0]["summary"], existingDescription);
    if (!incomingFinalized && existingFinalized) {
      return { path: "skip", sql: "", descLength: desc.length, summaryLength: text.length };
    }

    const pluginVersionSet = pluginVersion === undefined
      ? ""
      : `plugin_version = '${esc(pluginVersion)}', `;
    const sql =
      `UPDATE "${tableName}" SET ` +
      `summary = E'${esc(text)}', ` +
      `summary_embedding = ${embSql}, ` +
      `size_bytes = ${sizeBytes}, ` +
      `description = E'${esc(desc)}', ` +
      pluginVersionSet +
      `last_update_date = '${ts}' ` +
      `WHERE path = '${safePath}' AND description <> '${safeHold}'`;
    await query(sql);
    return { path: "update", sql, descLength: desc.length, summaryLength: text.length };
  }

  // INSERT path: guard path existence at mutation time as well. This prevents a
  // stale worker whose SELECT saw no row from inserting after source suppression
  // has materialized a HOLD row for the same session path.
  const pluginVersionForInsert = pluginVersion ?? "";
  const sql =
    `INSERT INTO "${tableName}" (id, path, filename, summary, summary_embedding, author, mime_type, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) ` +
    `SELECT '${randomUUID()}', '${safePath}', '${esc(fname)}', E'${esc(text)}', ${embSql}, '${esc(userName)}', 'text/markdown', ` +
    `${sizeBytes}, '${esc(project)}', E'${esc(desc)}', '${esc(agent)}', '${esc(pluginVersionForInsert)}', '${ts}', '${ts}' ` +
    `WHERE NOT EXISTS (SELECT 1 FROM "${tableName}" WHERE path = '${safePath}')`;
  await query(sql);
  return { path: "insert", sql, descLength: desc.length, summaryLength: text.length };
}

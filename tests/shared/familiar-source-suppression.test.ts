import { describe, expect, it } from "vitest";
import {
  buildFamiliarMemoryCandidate,
  buildFamiliarPromotionCommit,
  buildFamiliarPromotionPlan,
  suppressFamiliarSourceAndSummary,
  type Digest,
} from "../../src/familiar/index.js";
import { FAMILIAR_FORGET_HOLD_DESCRIPTION } from "../../src/hooks/upload-summary.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const NOW = "2026-09-04T20:00:00.000Z";
type Row = Record<string, unknown>;

function event(content = "forgettable payload") {
  return {
    id: "event-1",
    type: "user_message" as const,
    session_id: "session-1",
    timestamp: NOW,
    content,
  };
}

function promotionCommit() {
  const candidate = buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 2,
    event: event(),
  });
  return buildFamiliarPromotionCommit(buildFamiliarPromotionPlan({
    candidate,
    memoryId: "memory-1",
    originLabelDigest: D1,
    actorRef: "principal:operator",
    reasonDigest: D2,
    policyEpoch: 3,
    createdAt: NOW,
  }));
}

function database(sourceMessage: Row, initialSummary = false) {
  const statements: string[] = [];
  const sessionRows: Row[] = [{
    id: "event-1",
    message: sourceMessage,
    message_embedding: [0.1, 0.2],
    author: "operator",
    project: "project-1",
    path: "/sessions/operator/session-1.jsonl",
    creation_date: NOW,
  }];
  const memoryRows: Row[] = initialSummary ? [{
    path: "/summaries/operator/session-1.md",
    summary: "old summary with forgettable payload",
    summary_embedding: [0.3],
    description: "completed",
  }] : [];

  const query = async (statement: string): Promise<Row[]> => {
    statements.push(statement);

    if (statement.startsWith('SELECT id, message, message_embedding, author, project, path, creation_date FROM "sessions"')) {
      return [...sessionRows];
    }
    if (statement.startsWith('UPDATE "sessions" SET message = ')) {
      const match = statement.match(/SET message = '(.+)'::jsonb, message_embedding = NULL,/s);
      if (!match) throw new Error(`could not parse source tombstone SQL: ${statement}`);
      sessionRows[0].message = JSON.parse(match[1].replace(/''/g, "'"));
      sessionRows[0].message_embedding = null;
      return [];
    }
    if (statement.startsWith('SELECT id, message, message_embedding, author, project FROM "sessions"')) {
      return [...sessionRows];
    }
    if (statement.startsWith('UPDATE "memory" SET summary = \'\'')) {
      for (const row of memoryRows) {
        row.summary = "";
        row.summary_embedding = null;
        row.description = FAMILIAR_FORGET_HOLD_DESCRIPTION;
      }
      return [];
    }
    if (statement.startsWith('SELECT path, summary, summary_embedding, description FROM "memory"')) {
      return [...memoryRows];
    }
    if (statement.startsWith('INSERT INTO "memory"')) {
      if (memoryRows.length === 0) {
        memoryRows.push({
          path: "/summaries/operator/session-1.md",
          summary: "",
          summary_embedding: null,
          description: FAMILIAR_FORGET_HOLD_DESCRIPTION,
        });
      }
      return [];
    }
    return [];
  };

  return { query, statements, sessionRows, memoryRows };
}

describe("FMP source suppression", () => {
  it("fails before destructive rewrite when the source digest no longer matches promotion", async () => {
    const commit = promotionCommit();
    const db = database(event("tampered source payload"));

    const result = await suppressFamiliarSourceAndSummary({
      query: db.query,
      sessionsTableName: "sessions",
      memoryTableName: "memory",
      commit,
      now: NOW,
    });

    expect(result.embedding.state).toBe("FAILED");
    expect(result.summary.state).toBe("FAILED");
    expect(db.statements.some((sql) => sql.startsWith('UPDATE "sessions"'))).toBe(false);
    expect((db.sessionRows[0].message as Row).content).toBe("tampered source payload");
  });

  it("materializes a summary HOLD even when no summary row existed", async () => {
    const commit = promotionCommit();
    const db = database(event());

    const result = await suppressFamiliarSourceAndSummary({
      query: db.query,
      sessionsTableName: "sessions",
      memoryTableName: "memory",
      commit,
      now: NOW,
    });

    expect(result.embedding.state).toBe("VERIFIED");
    expect(result.summary.state).toBe("VERIFIED");
    expect(db.memoryRows).toHaveLength(1);
    expect(db.memoryRows[0]).toMatchObject({
      path: "/summaries/operator/session-1.md",
      summary: "",
      summary_embedding: null,
      description: FAMILIAR_FORGET_HOLD_DESCRIPTION,
    });
    const tombstone = db.sessionRows[0].message as Row;
    expect(tombstone.type).toBe("familiar_memory_forgotten_source");
    expect(tombstone.original_event_digest).toBe(commit.sourceEventDigest);
    expect(tombstone.content).toBeUndefined();
  });

  it("is retry-safe after the original plaintext has already been suppressed", async () => {
    const commit = promotionCommit();
    const db = database(event(), true);

    const first = await suppressFamiliarSourceAndSummary({
      query: db.query,
      sessionsTableName: "sessions",
      memoryTableName: "memory",
      commit,
      now: NOW,
    });
    const second = await suppressFamiliarSourceAndSummary({
      query: db.query,
      sessionsTableName: "sessions",
      memoryTableName: "memory",
      commit,
      now: NOW,
    });

    expect(first.embedding.state).toBe("VERIFIED");
    expect(first.summary.state).toBe("VERIFIED");
    expect(second.embedding.state).toBe("VERIFIED");
    expect(second.summary.state).toBe("VERIFIED");
    expect((db.sessionRows[0].message as Row).original_event_digest).toBe(commit.sourceEventDigest);
  });
});

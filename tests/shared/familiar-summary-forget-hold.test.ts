import { describe, expect, it } from "vitest";
import {
  FAMILIAR_FORGET_HOLD_DESCRIPTION,
  isFinalizedDescription,
  uploadSummary,
} from "../../src/hooks/upload-summary.js";

const BASE = {
  tableName: "memory",
  vpath: "/summaries/operator/session-1.md",
  fname: "session-1.md",
  userName: "operator",
  project: "project-1",
  agent: "claude_code",
  sessionId: "session-1",
  ts: "2026-09-04T20:00:00.000Z",
};

const FINAL_TEXT = "# Session\n\n## What Happened\nThis text was generated from a stale pre-forget snapshot.";

describe("FMP summary regeneration HOLD", () => {
  it("does not classify a forgetting HOLD as finalized recall state", () => {
    expect(isFinalizedDescription(FAMILIAR_FORGET_HOLD_DESCRIPTION)).toBe(false);
  });

  it("refuses a fully finalized stale wiki writer while HOLD is already visible", async () => {
    const statements: string[] = [];
    const query = async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("SELECT")) {
        return [{
          path: BASE.vpath,
          summary: "",
          description: FAMILIAR_FORGET_HOLD_DESCRIPTION,
        }];
      }
      throw new Error(`unexpected mutation: ${sql}`);
    };

    const result = await uploadSummary(query, {
      ...BASE,
      text: FINAL_TEXT,
      embedding: [0.1, 0.2],
    });

    expect(result.path).toBe("skip");
    expect(result.sql).toBe("");
    expect(statements).toHaveLength(1);
  });

  it("also refuses a placeholder/stub writer while HOLD is active", async () => {
    let mutations = 0;
    const query = async (sql: string) => {
      if (sql.startsWith("SELECT")) {
        return [{
          path: BASE.vpath,
          summary: "",
          description: FAMILIAR_FORGET_HOLD_DESCRIPTION,
        }];
      }
      mutations += 1;
      return [];
    };

    const result = await uploadSummary(query, {
      ...BASE,
      text: "in progress",
      embedding: null,
    });

    expect(result.path).toBe("skip");
    expect(mutations).toBe(0);
  });

  it("carries the HOLD predicate into UPDATE to close a stale-read TOCTOU race", async () => {
    const statements: string[] = [];
    const query = async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("SELECT")) {
        return [{
          path: BASE.vpath,
          summary: "old summary",
          description: "old finalized summary",
        }];
      }
      return [];
    };

    const result = await uploadSummary(query, {
      ...BASE,
      text: FINAL_TEXT,
      embedding: [0.1, 0.2],
    });

    expect(result.path).toBe("update");
    expect(result.sql).toContain(`description <> '${FAMILIAR_FORGET_HOLD_DESCRIPTION}'`);
    expect(statements[1]).toBe(result.sql);
  });

  it("re-checks path absence inside INSERT so a newly materialized HOLD wins", async () => {
    const statements: string[] = [];
    const query = async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("SELECT path")) return [];
      return [];
    };

    const result = await uploadSummary(query, {
      ...BASE,
      text: FINAL_TEXT,
      embedding: [0.1, 0.2],
    });

    expect(result.path).toBe("insert");
    expect(result.sql).toContain("WHERE NOT EXISTS");
    expect(result.sql).toContain(`WHERE path = '${BASE.vpath}'`);
    expect(statements[1]).toBe(result.sql);
  });
});

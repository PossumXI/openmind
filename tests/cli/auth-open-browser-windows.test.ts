import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openCommandFor } from "../../src/dashboard/open.js";

const AUTH_SRC = readFileSync(
  join(import.meta.dirname, "../../src/commands/auth.ts"),
  "utf-8",
);

// The device-flow login opened a new console window instead of a browser on
// Windows, for a reason this repo had already found and written down in
// dashboard/open.ts: under cmd.exe, `start "<url>"` treats its first quoted
// argument as the WINDOW TITLE. auth.ts had its own copy of the open logic and
// never got the fix, so Windows users installed fine and then could not log in
// — a drop-off indistinguishable from someone walking away.
describe("device-flow login opens a browser on Windows", () => {
  it("passes the empty title argument that makes the URL an argument", () => {
    const { command, args } = openCommandFor("win32", "https://example.com/device?code=ABCD");

    expect(command).toBe("cmd");
    // The "" is the whole bug. Without it the URL becomes the window title.
    expect(args).toEqual(["/c", "start", "", "https://example.com/device?code=ABCD"]);
    expect(args[2]).toBe("");
  });

  // A unit test of openCommandFor cannot catch auth.ts keeping a second,
  // divergent implementation — which is exactly how this shipped. Assert the
  // caller actually routes through the shared helper.
  it("auth.ts delegates to the shared helper instead of building its own command", () => {
    expect(AUTH_SRC).toContain("openInBrowser");
    expect(AUTH_SRC).not.toMatch(/start\s+"\$\{url\}"/);
    expect(AUTH_SRC).not.toMatch(/execSync\(\s*cmd/);
  });
});

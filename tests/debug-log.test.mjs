import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDebugLogService, formatLogLine, formatLocalTs } from "../server.mjs";
import { createDebugLogClient } from "../client.mjs";

describe("debug-log-service", () => {
  let svc;
  let client;
  let logFile;

  before(async () => {
    logFile = join(tmpdir(), `debug-logs-test-${Date.now()}.txt`);
    await writeFile(logFile, "", "utf8");
    svc = createDebugLogService({ port: 0, host: "127.0.0.1", logFile });
    const { port } = await svc.listen();
    client = createDebugLogClient({
      baseUrl: `http://127.0.0.1:${port}`,
      source: "test",
    });
  });

  after(async () => {
    await svc.close();
  });

  it("formats local timestamp", () => {
    const ts = formatLocalTs(new Date(2026, 2, 22, 9, 5, 7, 3));
    assert.match(ts, /^2026-03-22 09:05:07\.003$/);
  });

  it("formats log line with data", () => {
    const line = formatLogLine({
      ts: "2026-03-22 12:00:00.000",
      source: "frontend",
      level: "info",
      message: "clicked",
      data: { btn: "ok" },
    });
    assert.equal(
      line,
      '[2026-03-22 12:00:00.000] [frontend] [info] clicked | {"btn":"ok"}'
    );
  });

  it("writes via API and reads back", async () => {
    await client.clear();
    await client.info("frontend", "hello", { n: 1 });
    await client.warn("backend", "slow", { ms: 120 });
    const text = await readFile(logFile, "utf8");
    assert.match(text, /\[frontend\] \[info\] hello/);
    assert.match(text, /\[backend\] \[warn\] slow/);
    const json = await client.read({ format: "json" });
    assert.equal(json.ok, true);
    assert.ok(json.count >= 2);
  });

  it("batch write", async () => {
    await client.clear();
    await client.writeMany([
      { source: "a", level: "debug", message: "one" },
      { source: "b", level: "error", message: "two", data: { x: true } },
    ]);
    const json = await client.read({ format: "json" });
    assert.equal(json.count, 2);
  });

  it("health", async () => {
    const res = await fetch(`${client.baseUrl}/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, "debug-log-service");
  });
});

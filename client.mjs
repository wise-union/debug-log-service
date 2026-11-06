/**
 * Tiny client for debug-log-service (Node / browser via fetch).
 *
 * Node:
 *   import { debugLog } from "./client.mjs";
 *   await debugLog.info("backend", "hello", { id: 1 });
 *
 * Browser:
 *   await fetch("http://127.0.0.1:18796/api/log", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify({ source: "frontend", level: "info", message: "hello" }),
 *   });
 */

const DEFAULT_BASE = "http://127.0.0.1:18796";

export function createDebugLogClient(opts = {}) {
  const baseUrl = String(opts.baseUrl || process.env.DEBUG_LOG_URL || DEFAULT_BASE).replace(
    /\/+$/,
    ""
  );
  const fetchImpl = opts.fetch || globalThis.fetch;
  const defaultSource = opts.source || "client";

  async function write(entry) {
    const payload = {
      source: entry.source || defaultSource,
      level: entry.level || "info",
      message: entry.message ?? entry.msg ?? "",
    };
    if (entry.data !== undefined) payload.data = entry.data;
    if (entry.ts) payload.ts = entry.ts;

    const res = await fetchImpl(`${baseUrl}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const err = new Error(json.error || `HTTP_${res.status}`);
      err.response = json;
      throw err;
    }
    return json;
  }

  async function writeMany(entries) {
    const res = await fetchImpl(`${baseUrl}/api/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const err = new Error(json.error || `HTTP_${res.status}`);
      err.response = json;
      throw err;
    }
    return json;
  }

  function levelFn(level) {
    return (sourceOrMsg, msgOrData, maybeData) => {
      // debugLog.info("hello")
      // debugLog.info("backend", "hello")
      // debugLog.info("backend", "hello", { a: 1 })
      // debugLog.info("hello", { a: 1 })  when defaultSource set
      if (typeof msgOrData === "undefined" && typeof maybeData === "undefined") {
        return write({ level, source: defaultSource, message: String(sourceOrMsg) });
      }
      if (typeof msgOrData === "object" && msgOrData !== null && typeof maybeData === "undefined") {
        return write({
          level,
          source: defaultSource,
          message: String(sourceOrMsg),
          data: msgOrData,
        });
      }
      return write({
        level,
        source: String(sourceOrMsg),
        message: String(msgOrData ?? ""),
        data: maybeData,
      });
    };
  }

  return {
    baseUrl,
    write,
    writeMany,
    debug: levelFn("debug"),
    info: levelFn("info"),
    warn: levelFn("warn"),
    error: levelFn("error"),
    async clear() {
      const res = await fetchImpl(`${baseUrl}/api/logs`, { method: "DELETE" });
      return res.json();
    },
    async read(optsRead = {}) {
      const q = new URLSearchParams();
      if (optsRead.tail != null) q.set("tail", String(optsRead.tail));
      q.set("format", optsRead.format || "json");
      const res = await fetchImpl(`${baseUrl}/api/logs?${q}`);
      if ((optsRead.format || "json") === "text") return res.text();
      return res.json();
    },
  };
}

/** Default singleton-style helpers */
export const debugLog = createDebugLogClient({ source: "backend" });

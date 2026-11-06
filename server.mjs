/**
 * debug-log-service — localhost shared debug log sink.
 * Zero npm dependencies. Bind 127.0.0.1 only.
 * Writes to <repo>/tests/debug-logs.txt for frontend + backend.
 */
import http from "node:http";
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
  access,
  constants as fsConstants,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(ROOT, "..", "..");
const DEFAULT_LOG_FILE = join(REPO_ROOT, "tests", "debug-logs.txt");

const LEVELS = new Set(["debug", "info", "warn", "error"]);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

/** Local wall time: yyyy-MM-dd HH:mm:ss.SSS */
export function formatLocalTs(date = new Date()) {
  return (
    date.getFullYear() +
    "-" +
    pad2(date.getMonth() + 1) +
    "-" +
    pad2(date.getDate()) +
    " " +
    pad2(date.getHours()) +
    ":" +
    pad2(date.getMinutes()) +
    ":" +
    pad2(date.getSeconds()) +
    "." +
    pad3(date.getMilliseconds())
  );
}

function serializeData(data) {
  if (data === undefined) return "";
  try {
    return JSON.stringify(data);
  } catch {
    return JSON.stringify(String(data));
  }
}

/**
 * Build one log line.
 * Format: [ts] [source] [level] message | dataJson
 */
export function formatLogLine(entry) {
  const ts = entry.ts || formatLocalTs();
  const source = String(entry.source || "unknown").trim() || "unknown";
  const levelRaw = String(entry.level || "info").toLowerCase();
  const level = LEVELS.has(levelRaw) ? levelRaw : "info";
  const message = String(entry.message ?? entry.msg ?? "").replace(/\r?\n/g, "\\n");
  const dataStr = serializeData(entry.data);
  const base = `[${ts}] [${source}] [${level}] ${message}`;
  return dataStr ? `${base} | ${dataStr}` : base;
}

export function createDebugLogService(opts = {}) {
  const port = Number(opts.port || process.env.DEBUG_LOG_PORT || 18796);
  const host = opts.host || "127.0.0.1";
  const logFile = resolve(opts.logFile || process.env.DEBUG_LOG_FILE || DEFAULT_LOG_FILE);
  let boundPort = port;
  let writeChain = Promise.resolve();

  function withWriteLock(fn) {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => {});
    return next;
  }

  async function ensureLogFile() {
    await mkdir(dirname(logFile), { recursive: true });
    try {
      await access(logFile, fsConstants.F_OK);
    } catch {
      await writeFile(logFile, "", "utf8");
    }
  }

  async function appendLines(lines) {
    if (!lines.length) return;
    await ensureLogFile();
    const chunk = lines.map((l) => (l.endsWith("\n") ? l : l + "\n")).join("");
    await withWriteLock(() => appendFile(logFile, chunk, "utf8"));
  }

  async function readLogText() {
    await ensureLogFile();
    return readFile(logFile, "utf8");
  }

  async function clearLog() {
    await ensureLogFile();
    await withWriteLock(() => writeFile(logFile, "", "utf8"));
  }

  function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  function json(res, status, obj) {
    cors(res);
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function text(res, status, body, contentType = "text/plain; charset=utf-8") {
    cors(res);
    const buf = Buffer.from(body, "utf8");
    res.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": buf.byteLength,
    });
    res.end(buf);
  }

  function readBody(req) {
    return new Promise((resolveBody, reject) => {
      const chunks = [];
      let size = 0;
      const max = 2 * 1024 * 1024;
      req.on("data", (c) => {
        size += c.length;
        if (size > max) {
          reject(new Error("BODY_TOO_LARGE"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolveBody({});
          return;
        }
        try {
          resolveBody(JSON.parse(raw));
        } catch {
          reject(new Error("BAD_JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  function normalizeEntries(body) {
    if (!body || typeof body !== "object") return [];
    if (Array.isArray(body.entries)) return body.entries;
    if (Array.isArray(body.logs)) return body.logs;
    if (body.message != null || body.msg != null) return [body];
    return [];
  }

  async function handleWrite(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      json(res, code === "BODY_TOO_LARGE" ? 413 : 400, { ok: false, error: code });
      return;
    }
    const entries = normalizeEntries(body);
    if (!entries.length) {
      json(res, 400, {
        ok: false,
        error: "EMPTY",
        hint: 'Send { "source","level","message","data"? } or { "entries": [...] }',
      });
      return;
    }
    const lines = entries.map((e) => formatLogLine(e && typeof e === "object" ? e : { message: String(e) }));
    await appendLines(lines);
    json(res, 200, { ok: true, written: lines.length, file: logFile });
  }

  async function handleRead(req, res, url) {
    const format = String(url.searchParams.get("format") || "text").toLowerCase();
    const tailRaw = url.searchParams.get("tail");
    let content = await readLogText();
    if (tailRaw != null && String(tailRaw).trim() !== "") {
      const n = Math.max(0, Number(tailRaw) || 0);
      const all = content.split(/\r?\n/);
      // drop trailing empty from final newline
      if (all.length && all[all.length - 1] === "") all.pop();
      content = (n > 0 ? all.slice(-n) : []).join("\n") + (all.length && n > 0 ? "\n" : "");
    }
    if (format === "json") {
      const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
      json(res, 200, { ok: true, file: logFile, lines, count: lines.length });
      return;
    }
    text(res, 200, content, "text/plain; charset=utf-8");
  }

  async function handleClear(_req, res) {
    await clearLog();
    json(res, 200, { ok: true, cleared: true, file: logFile });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}`);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && path === "/health") {
        json(res, 200, {
          ok: true,
          name: "debug-log-service",
          file: logFile,
          port: boundPort,
        });
        return;
      }

      // write: POST /api/log  or  POST /api/logs
      if (req.method === "POST" && (path === "/api/log" || path === "/api/logs")) {
        await handleWrite(req, res);
        return;
      }

      // read: GET /api/logs?tail=100&format=text|json
      if (req.method === "GET" && path === "/api/logs") {
        await handleRead(req, res, url);
        return;
      }

      // clear: DELETE /api/logs  or  POST /api/logs/clear
      if (
        (req.method === "DELETE" && path === "/api/logs") ||
        (req.method === "POST" && path === "/api/logs/clear")
      ) {
        await handleClear(req, res);
        return;
      }

      json(res, 404, { ok: false, error: "NOT_FOUND" });
    } catch (e) {
      json(res, 500, {
        ok: false,
        error: "INTERNAL",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  server.on("listening", () => {
    const addr = server.address();
    if (addr && typeof addr === "object" && addr.port) boundPort = addr.port;
  });

  return {
    server,
    logFile,
    formatLogLine,
    appendLines,
    listen() {
      return new Promise((resolveListen) => {
        server.listen(port, host, () => {
          const addr = server.address();
          boundPort = addr && typeof addr === "object" ? addr.port : port;
          resolveListen({ host, port: boundPort, logFile });
        });
      });
    },
    close() {
      return new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const svc = createDebugLogService();
  svc.listen().then(({ host, port, logFile }) => {
    console.log(`[debug-log-service] http://${host}:${port}`);
    console.log(`[debug-log-service] file → ${logFile}`);
    console.log(`[debug-log-service] POST /api/log  GET /api/logs  DELETE /api/logs`);
  });
}

// Rampart PII-redaction service — see clusters/home/rampart/README.md.
//
//   GET  /                  playground UI
//   GET  /healthz           liveness/readiness (+ session count)
//   POST /protect           { text, session? }              → { session, text, placeholders }
//   POST /reveal            { text, session }               → { text, known }
//   POST /protect-messages  { messages: [...], session? }   → { session, messages, placeholders }
//
// Sessions: each session id owns a ChatGuard whose entity table keeps
// placeholders stable across turns ("Alex" is [GIVEN_NAME_1] every time).
// Omit `session` and one is created for you (returned in the response).
// Tables live only in this pod's memory and expire after SESSION_TTL.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initClassifier, classifierReady, newGuard, RAMPART_MODEL_ID } from "./guard-runtime.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 60 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 2000);
const MAX_BODY = 1 * 1024 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const playgroundHtml = readFileSync(join(here, "public", "index.html"));
const startedAt = Date.now();

/** session id → { guard, touched } */
const sessions = new Map();

function getSession(id) {
  const wanted = id ?? randomUUID();
  let entry = sessions.get(wanted);
  if (!entry) {
    if (sessions.size >= MAX_SESSIONS) evictOldest();
    entry = { guard: newGuard(), touched: Date.now() };
    sessions.set(wanted, entry);
  }
  entry.touched = Date.now();
  return { id: wanted, guard: entry.guard };
}

function evictOldest() {
  let oldestKey, oldestTouched = Infinity;
  for (const [k, v] of sessions) if (v.touched < oldestTouched) { oldestKey = k; oldestTouched = v.touched; }
  if (oldestKey) sessions.delete(oldestKey);
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, v] of sessions) if (v.touched < cutoff) sessions.delete(k);
}, 5 * 60 * 1000).unref();

function json(res, status, body) {
  const buf = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("invalid JSON body"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

const routes = {
  "POST /protect": async (body) => {
    if (typeof body.text !== "string") throw Object.assign(new Error("`text` (string) is required"), { status: 400 });
    const { id, guard } = getSession(body.session);
    const result = await guard.protect(body.text);
    return { session: id, text: result.text, placeholders: result.placeholders };
  },

  "POST /reveal": async (body) => {
    if (typeof body.text !== "string") throw Object.assign(new Error("`text` (string) is required"), { status: 400 });
    if (typeof body.session !== "string") throw Object.assign(new Error("`session` (string) is required"), { status: 400 });
    const known = sessions.has(body.session);
    if (!known) return { text: body.text, known };
    const { guard } = getSession(body.session);
    return { text: guard.reveal(body.text), known };
  },

  // Redact a whole chat completion payload in one shared session, so the same
  // name maps to the same placeholder across every message. Used by the
  // LiteLLM rampart guardrail (observability/litellm/).
  "POST /protect-messages": async (body) => {
    if (!Array.isArray(body.messages)) throw Object.assign(new Error("`messages` (array) is required"), { status: 400 });
    const { id, guard } = getSession(body.session);
    const placeholders = new Set();
    const messages = [];
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") { messages.push(msg); continue; }
      if (typeof msg.content === "string") {
        const r = await guard.protect(msg.content);
        r.placeholders.forEach((p) => placeholders.add(p));
        messages.push({ ...msg, content: r.text });
      } else if (Array.isArray(msg.content)) {
        // OpenAI multimodal content: redact the text parts, pass the rest through.
        const parts = [];
        for (const part of msg.content) {
          if (part && part.type === "text" && typeof part.text === "string") {
            const r = await guard.protect(part.text);
            r.placeholders.forEach((p) => placeholders.add(p));
            parts.push({ ...part, text: r.text });
          } else {
            parts.push(part);
          }
        }
        messages.push({ ...msg, content: parts });
      } else {
        messages.push(msg);
      }
    }
    return { session: id, messages, placeholders: [...placeholders] };
  },
};

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(playgroundHtml);
  }
  if (req.method === "GET" && path === "/healthz") {
    return json(res, classifierReady() ? 200 : 503, {
      ok: classifierReady(),
      model: RAMPART_MODEL_ID,
      sessions: sessions.size,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    });
  }

  const handler = routes[`${req.method} ${path}`];
  if (!handler) return json(res, 404, { error: "not found" });
  try {
    json(res, 200, await handler(await readBody(req)));
  } catch (err) {
    json(res, err.status ?? 500, { error: err.message });
  }
});

console.log(`loading ${RAMPART_MODEL_ID} (cpu)…`);
await initClassifier();
server.listen(PORT, () => console.log(`rampart listening on :${PORT}`));

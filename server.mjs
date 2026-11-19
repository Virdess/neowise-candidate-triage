import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
export const TOPICS = new Set(["delivery", "pricing", "other"]);
const MAX_BODY_BYTES = 64 * 1024;
const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class InvalidInput extends Error {}

async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInput("body too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidInput("malformed JSON");
  }
  const text = body?.text;
  if (typeof text !== "string" || text.trim() === "") throw new InvalidInput("text must be a non-empty string");
  return text;
}

// Проверка результата AI: HTTP-успех модели ничего не гарантирует,
// поэтому принимаем только JSON-объект с темой из списка и непустым черновиком.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const { topic, draft } = data;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

// Ждём модель не дольше timeoutMs. При таймауте отменяем запрос через AbortSignal,
// а Promise.race гарантирует ответ, даже если провайдер игнорирует сигнал.
export async function triage(text, { classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model timeout"));
    }, timeoutMs);
  });
  try {
    const raw = await Promise.race([classify(text, { signal: controller.signal }), timeout]);
    const result = parseModelOutput(raw);
    return result ? { status: "ready", ...result } : { ...MANUAL_REVIEW };
  } catch {
    return { ...MANUAL_REVIEW };
  } finally {
    clearTimeout(timer);
  }
}

export function createAppServer(options = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      const text = await readText(request);
      json(response, 200, await triage(text, options));
    } catch (error) {
      if (error instanceof InvalidInput) return json(response, 400, { status: "invalid_input" });
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createAppServer().listen(port, "127.0.0.1", () => {
    console.log(`Listening on http://127.0.0.1:${port}`);
  });
}

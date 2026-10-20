const AI_MAX_MESSAGE_CHARS = 8000;
const AI_MAX_TOTAL_CHARS = 24000;
const AI_MAX_HISTORY_MESSAGES = 12;
const AI_RATE_LIMIT_WINDOW_MS = 60_000;
const AI_RATE_LIMIT_MAX_REQUESTS = 12;
const AI_UPSTREAM_START_TIMEOUT_MS = 15_000;
const AI_STREAM_IDLE_TIMEOUT_MS = 60_000;
const AI_DEFAULT_MODEL = "gemini-3.5-flash-lite";
const AI_DEFAULT_FALLBACK_MODEL = "gemini-3.1-flash-lite";

const AI_SYSTEM_INSTRUCTION = [
  "You are 1117 AI, a capable, practical general assistant inside the 1117 website.",
  "Help with questions, math, problem solving, programming, HTML/CSS/JavaScript, and browser game creation.",
  "Be direct, accurate, and helpful. For math and reasoning, provide a concise explanation with useful solution steps.",
  "For code, favor complete, runnable examples and explain how to use them. For HTML games, prefer a self-contained one-file solution unless the user asks otherwise.",
  "Say when you are uncertain. Do not invent sources, claim to browse the web, or claim to perform actions you cannot perform.",
  "Protect user privacy and avoid requesting secrets, passwords, or API keys.",
].join("\n");

const aiRateLimitBuckets = new Map();
const aiEncoder = new TextEncoder();

function aiJson(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function aiSseEvent(event, body) {
  return aiEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

function canUseAi(clientId) {
  const now = Date.now();
  const existing = aiRateLimitBuckets.get(clientId);
  if (!existing || existing.resetAt <= now) {
    aiRateLimitBuckets.set(clientId, { count: 1, resetAt: now + AI_RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (existing.count >= AI_RATE_LIMIT_MAX_REQUESTS) return false;
  existing.count += 1;
  return true;
}

function normalizeAiRequest(payload) {
  if (!payload || !Array.isArray(payload.messages)) return null;
  const rawMessages = payload.messages.slice(-AI_MAX_HISTORY_MESSAGES);
  if (!rawMessages.length) return null;

  let totalChars = 0;
  const messages = [];

  for (const rawMessage of rawMessages) {
    if (!rawMessage || (rawMessage.role !== "user" && rawMessage.role !== "assistant")) return null;
    if (typeof rawMessage.content !== "string") return null;

    const content = rawMessage.content.trim();
    if (!content || content.length > AI_MAX_MESSAGE_CHARS) return null;
    totalChars += content.length;
    if (totalChars > AI_MAX_TOTAL_CHARS) return null;

    messages.push({
      role: rawMessage.role === "assistant" ? "model" : "user",
      content,
    });
  }

  if (messages.at(-1)?.role !== "user") return null;
  const mode = ["fast", "balanced", "deep"].includes(payload.mode) ? payload.mode : "balanced";
  return { messages, mode, stream: payload.stream === true };
}

function sanitizeModel(value, fallback) {
  const model = value?.trim() || fallback;
  return /^[a-zA-Z0-9._-]+$/.test(model) ? model : fallback;
}

function generationConfigFor(mode) {
  if (mode === "fast") return { temperature: 0.2, maxOutputTokens: 1000 };
  if (mode === "deep") return { temperature: 0.45, maxOutputTokens: 4096 };
  return { temperature: 0.35, maxOutputTokens: 2200 };
}

function buildGeminiRequest(request) {
  return {
    systemInstruction: { parts: [{ text: AI_SYSTEM_INSTRUCTION }] },
    contents: request.messages.map((message) => ({
      role: message.role,
      parts: [{ text: message.content }],
    })),
    generationConfig: generationConfigFor(request.mode),
  };
}

function isTimeoutError(error) {
  return error && typeof error === "object" && (error.name === "AbortError" || error.name === "TimeoutError");
}

function canRetryWithFallback(status, timedOut) {
  return timedOut || status === null || status === 404 || status >= 500;
}

function errorForUpstreamFailure(status, timedOut) {
  if (timedOut) {
    return {
      status: 504,
      error: "1117 AI took too long to start a response. Please try again.",
      code: "AI_TIMEOUT",
    };
  }
  if (status === 401 || status === 403) {
    return {
      status: 503,
      error: "1117 AI's private server connection needs attention. Please try again later.",
      code: "AI_CONFIGURATION_ERROR",
    };
  }
  if (status === 429) {
    return {
      status: 429,
      error: "1117 AI is busy right now. Please wait a moment, then try again.",
      code: "AI_BUSY",
    };
  }
  return {
    status: 502,
    error: "1117 AI could not reach its model service. Please try again.",
    code: "AI_UPSTREAM_ERROR",
  };
}

async function requestGemini(apiKey, model, request, stream) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_UPSTREAM_START_TIMEOUT_MS);

  try {
    const endpoint = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(buildGeminiRequest(request)),
        signal: controller.signal,
      },
    );
    return { response, timedOut: false };
  } catch (error) {
    return { response: null, timedOut: isTimeoutError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function aiStreamResponse(upstreamResponse, metadata) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    return new Response(aiSseEvent("error", {
      error: "1117 AI received an empty stream. Please try again.",
      code: "AI_EMPTY_STREAM",
    }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
    });
  }

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(aiSseEvent("meta", metadata));
      let streamTimedOut = false;
      let idleTimer = setTimeout(() => {
        streamTimedOut = true;
        void reader.cancel();
      }, AI_STREAM_IDLE_TIMEOUT_MS);

      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          streamTimedOut = true;
          void reader.cancel();
        }, AI_STREAM_IDLE_TIMEOUT_MS);
      };

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              resetIdleTimer();
              controller.enqueue(value);
            }
          }
          if (streamTimedOut) {
            controller.enqueue(aiSseEvent("error", {
              error: "1117 AI stopped responding while generating. Please try again.",
              code: "AI_STREAM_TIMEOUT",
            }));
          }
          controller.enqueue(aiSseEvent("done", {}));
        } catch {
          controller.enqueue(aiSseEvent("error", {
            error: "1117 AI lost the connection while generating. Please try again.",
            code: "AI_STREAM_INTERRUPTED",
          }));
          controller.enqueue(aiSseEvent("done", {}));
        } finally {
          clearTimeout(idleTimer);
          reader.releaseLock();
          controller.close();
        }
      };
      void pump();
    },
    cancel() {
      return reader.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    },
  });
}

function aiHealthResponse(request, env) {
  if (request.method !== "GET") {
    return aiJson(405, { error: "Use GET for AI health checks.", code: "METHOD_NOT_ALLOWED" }, { Allow: "GET" });
  }
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  return aiJson(200, {
    ready: apiKey ? "true" : "false",
    provider: "gemini",
    model: sanitizeModel(env.GEMINI_MODEL, AI_DEFAULT_MODEL),
    streaming: "true",
    webSearch: "false",
  });
}

async function handleAiRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "POST, OPTIONS" } });
  }

  if (request.method !== "POST") {
    return aiJson(
      405,
      { error: "Use POST for 1117 AI requests.", code: "METHOD_NOT_ALLOWED" },
      { Allow: "POST, OPTIONS" },
    );
  }

  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) {
    return aiJson(503, {
      error:
        "1117 AI is not configured on this server yet. Add GEMINI_API_KEY as a private server secret.",
      code: "AI_NOT_CONFIGURED",
    });
  }

  const clientId =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  if (!canUseAi(clientId)) {
    return aiJson(429, {
      error: "1117 AI is busy right now. Please wait a moment, then try again.",
      code: "RATE_LIMITED",
    });
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > AI_MAX_TOTAL_CHARS * 2) {
    return aiJson(400, {
      error: "Please send a shorter text-only message and try again.",
      code: "INVALID_REQUEST",
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return aiJson(400, {
      error: "Please send a valid text conversation and try again.",
      code: "INVALID_REQUEST",
    });
  }

  const aiRequest = normalizeAiRequest(payload);
  if (!aiRequest) {
    return aiJson(400, {
      error: "Please send a valid text conversation and try again.",
      code: "INVALID_REQUEST",
    });
  }

  const primaryModel = sanitizeModel(env.GEMINI_MODEL, AI_DEFAULT_MODEL);
  const fallbackModel = sanitizeModel(env.GEMINI_FALLBACK_MODEL, AI_DEFAULT_FALLBACK_MODEL);
  const candidates = primaryModel === fallbackModel ? [primaryModel] : [primaryModel, fallbackModel];
  const stream = aiRequest.stream || request.headers.get("accept")?.includes("text/event-stream") === true;
  let upstreamResponse = null;
  let activeModel = primaryModel;
  let lastStatus = null;
  let lastTimedOut = false;

  for (const model of candidates) {
    const attempt = await requestGemini(apiKey, model, aiRequest, stream);
    if (attempt.response?.ok) {
      upstreamResponse = attempt.response;
      activeModel = model;
      break;
    }
    lastStatus = attempt.response?.status ?? null;
    lastTimedOut = attempt.timedOut;
    await attempt.response?.body?.cancel().catch(() => undefined);
    if (!canRetryWithFallback(lastStatus, lastTimedOut)) break;
  }

  if (!upstreamResponse) {
    const failure = errorForUpstreamFailure(lastStatus, lastTimedOut);
    return aiJson(failure.status, { error: failure.error, code: failure.code });
  }

  if (stream) return aiStreamResponse(upstreamResponse, { model: activeModel, mode: aiRequest.mode });

  const upstreamData = await upstreamResponse.json().catch(() => null);
  const text = upstreamData?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();
  if (!text) {
    return aiJson(422, {
      error: "1117 AI could not generate a response to that request. Try rephrasing it.",
      code: "AI_EMPTY_RESPONSE",
    });
  }
  return aiJson(200, { text });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ai/health") {
      return aiHealthResponse(request, env);
    }

    if (url.pathname === "/api/ai") {
      return handleAiRequest(request, env);
    }

    // 1. Handle VPN / Proxy Requests directly on Cloudflare Edge!
    if (url.pathname.startsWith("/api/proxy") || url.pathname.startsWith("/api/vpn")) {
      const targetUrl = url.searchParams.get("url");
      const serverId = url.searchParams.get("server") || "us-east";

      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing url parameter" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      let fullUrl = targetUrl.trim();
      if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
        fullUrl = "https://" + fullUrl;
      }

      const serverProfiles = {
        "us-east": { ip: "198.51.100.42", lang: "en-US,en;q=0.9", name: "US East (Ashburn)" },
        "de-fra": {
          ip: "142.132.241.88",
          lang: "de-DE,de;q=0.9,en;q=0.8",
          name: "Germany (Frankfurt)",
        },
        "ch-zrh": {
          ip: "185.220.101.5",
          lang: "de-CH,de;q=0.9,en;q=0.8",
          name: "Switzerland (Zurich)",
        },
        "is-rey": {
          ip: "193.187.91.22",
          lang: "is-IS,is;q=0.9,en;q=0.8",
          name: "Iceland (Reykjavik)",
        },
        "sg-sin": { ip: "103.253.144.19", lang: "en-SG,en;q=0.9", name: "Singapore" },
        "jp-tyo": { ip: "133.130.54.12", lang: "ja-JP,ja;q=0.9,en;q=0.8", name: "Japan (Tokyo)" },
        "uk-lon": { ip: "185.107.56.20", lang: "en-GB,en;q=0.9", name: "United Kingdom (London)" },
        "ca-mon": {
          ip: "149.56.128.91",
          lang: "en-CA,fr-CA;q=0.9,en;q=0.8",
          name: "Canada (Montreal)",
        },
      };
      const profile = serverProfiles[serverId] || serverProfiles["us-east"];

      try {
        const resp = await fetch(fullUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": profile.lang,
            "X-Forwarded-For": profile.ip,
            "X-Real-IP": profile.ip,
          },
          redirect: "follow",
        });

        const contentType = resp.headers.get("content-type") || "text/html";
        const newHeaders = new Headers(resp.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS, POST");
        newHeaders.delete("Content-Security-Policy");
        newHeaders.delete("X-Frame-Options");
        newHeaders.delete("Frame-Options");
        newHeaders.set("X-VPN-Node", profile.name);
        newHeaders.set("X-VPN-Virtual-IP", profile.ip);

        if (contentType.includes("text/html")) {
          let html = await resp.text();
          html = html.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, "");
          html = html.replace(/<meta[^>]*http-equiv=["']?X-Frame-Options["']?[^>]*>/gi, "");
          html = html.replace(/if\s*\(top\s*!==\s*self\)[^}]+}/gi, "");

          const injection = `
<base href="${fullUrl}">
<script>
  window.__VPN_SERVER__ = "${serverId}";
  window.__VPN_VIRTUAL_IP__ = "${profile.ip}";
  window.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("a[href]").forEach(a => {
      const href = a.getAttribute("href");
      if (href && !href.startsWith("#") && !href.startsWith("javascript:") && !href.startsWith("mailto:")) {
        try {
          const abs = new URL(href, "${fullUrl}").href;
          a.setAttribute("href", "/api/proxy?url=" + encodeURIComponent(abs) + "&server=" + window.__VPN_SERVER__);
        } catch(e){}
      }
    });
  });
</script>
`;
          if (html.includes("<head>")) {
            html = html.replace("<head>", "<head>" + injection);
          } else {
            html = injection + html;
          }
          return new Response(html, {
            status: resp.status,
            headers: newHeaders,
          });
        }

        return new Response(resp.body, {
          status: resp.status,
          headers: newHeaders,
        });
      } catch (err) {
        return new Response(
          `<div style="background:#090d16;color:#fff;font-family:sans-serif;padding:36px;border-radius:12px;text-align:center;max-width:500px;margin:40px auto;border:1px solid #1e293b;">
            <h2 style="color:#22d3ee;margin:0 0 8px;">🛡️ 1117 VPN Gateway</h2>
            <p style="color:#94a3b8;font-size:14px;">Connection through ${profile.name} timed out or destination refused.</p>
            <p style="color:#ef4444;font-size:12px;font-family:monospace;margin:12px 0;">${err.message || "Failed to reach host"}</p>
          </div>`,
          {
            status: 502,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
    }

    // 2. Serve static asset from the Cloudflare asset store
    try {
      if (env.ASSETS) {
        const response = await env.ASSETS.fetch(request);
        if (response.status !== 404) {
          return response;
        }

        // 3. Normalize nested assets
        if (url.pathname.includes("/assets/")) {
          const cleanAssetPath = "/assets/" + url.pathname.split("/assets/").pop();
          const cleanRequest = new Request(new URL(cleanAssetPath, request.url), request);
          const assetResponse = await env.ASSETS.fetch(cleanRequest);
          if (assetResponse.status !== 404) {
            return assetResponse;
          }
        }

        // 4. Single-Page Application (SPA) Fallback: Serve /index.html for all page routes
        const indexRequest = new Request(new URL("/index.html", request.url), request);
        return await env.ASSETS.fetch(indexRequest);
      }
    } catch (_err) {
      if (env.ASSETS) {
        try {
          return await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
        } catch (_e) {}
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

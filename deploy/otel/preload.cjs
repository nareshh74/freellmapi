"use strict";
(function () {
  try {
    if (process.env.OTEL_SDK_DISABLED === "true") return;
    if (process.argv.includes("-e") || process.argv.includes("--eval")) return;
    const { trace, context, isSpanContextValid } = require("@opentelemetry/api");
    const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
    const { resourceFromAttributes } = require("@opentelemetry/resources");
    const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
    const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
    const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
    const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
    const { LoggerProvider, BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
    const { registerInstrumentations } = require("@opentelemetry/instrumentation");
    const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
    const { UndiciInstrumentation } = require("@opentelemetry/instrumentation-undici");

    const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318").replace(/\/$/, "");
    const TIMEOUT = Number(process.env.OTEL_EXPORTER_OTLP_TIMEOUT) || 2000;
    const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "freellmapi";

    const resource = resourceFromAttributes({
      "service.name": SERVICE_NAME,
      "service.namespace": "local-ai",
    });
    const batch = {
      maxQueueSize: 2048,
      maxExportBatchSize: 256,
      scheduledDelayMillis: 2000,
      exportTimeoutMillis: TIMEOUT,
    };
    const tp = new NodeTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: base + "/v1/traces", timeoutMillis: TIMEOUT }),
          batch
        ),
      ],
    });
    tp.register();

    const lp = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({ url: base + "/v1/logs", timeoutMillis: TIMEOUT }),
          batch
        ),
      ],
    });
    logs.setGlobalLoggerProvider(lp);
    const otelLogger = logs.getLogger("freellmapi.http");

    const stripPath = (u) => (u || "").split("?")[0];
    const hasTraceparent = (req) => Boolean(req && req.headers && req.headers.traceparent);
    const isNoise = (p, req) => {
      if (p === "/api/ping" || p === "/livez" || p === "/readyz") {
        return !hasTraceparent(req);
      }
      if (p === "/" && !hasTraceparent(req)) {
        const ua = String((req && req.headers && req.headers["user-agent"]) || "");
        if (/otel|go-http-client/i.test(ua)) return true;
      }
      if (/^\/(assets\/|favicon\.ico$|robots\.txt$)/.test(p)) return true;
      return false;
    };
    const isLlm = (p) =>
      /^\/(v1|v1beta)\/(chat\/completions|responses|completions|messages|embeddings|models|rerank|images|audio)/.test(p) ||
      /^\/api\/(chat|generate|embed|embeddings)/.test(p);

    const OPS = {
      "chat/completions": "chat",
      responses: "chat",
      completions: "text_completion",
      messages: "chat",
      embeddings: "embeddings",
    };
    const SKEY = Symbol("freellmapi.otel");
    const hdr = (res, n) => {
      const v = res.getHeader(n);
      return v == null ? undefined : String(v);
    };
    const tryJson = (s) => {
      try {
        return JSON.parse(s);
      } catch (_) {
        return undefined;
      }
    };

    function parseResponse(text) {
      const out = {};
      const pick = (o) => {
        if (!o || typeof o !== "object") return;
        if (o.model) out.model = o.model;
        const u = o.usage || (o.message && o.message.usage) || (o.response && o.response.usage);
        if (u) {
          const i = u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens;
          const c = u.completion_tokens != null ? u.completion_tokens : u.output_tokens;
          if (i != null) out.in = i;
          if (c != null) out.out = c;
        }
        if (o.response) pick(o.response);
        if (o.message) pick(o.message);
      };
      const whole = tryJson(text);
      if (whole) {
        pick(whole);
        return out;
      }
      for (const line of text.split("\n")) {
        if (line.startsWith("data:") && line.length > 6) {
          pick(tryJson(line.slice(5).trim()));
        }
      }
      return out;
    }

    const httpInst = new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => isNoise(stripPath(req.url), req),
      ignoreOutgoingRequestHook: (req) => {
        const host = (req && (req.hostname || req.host || (req.headers && req.headers.host))) || "";
        return String(host).includes("otel-collector") && String(req.path || "").startsWith("/v1/");
      },
      requestHook(span, request) {
        try {
          if (!request || typeof request.push !== "function") return;
          const path = stripPath(request.url);
          const st = {
            startMs: Date.now(),
            path,
            llm: request.method === "POST" && isLlm(path),
            req: [],
            reqLen: 0,
            res: [],
            resLen: 0,
          };
          request[SKEY] = st;
          if (st.llm) {
            const push = request.push;
            request.push = function (chunk, enc) {
              try {
                if (chunk && st.reqLen < 262144) {
                  st.req.push(Buffer.from(chunk));
                  st.reqLen += chunk.length;
                }
              } catch (_) {}
              return push.call(this, chunk, enc);
            };
          }
        } catch (_) {}
      },
      responseHook(span, res) {
        try {
          if (!res || typeof res.getHeader !== "function") return;
          const req = res.req;
          const st = req && req[SKEY];
          if (!st) return;

          if (st.llm) {
            const w = res.write;
            const e = res.end;
            const tap = (c) => {
              if (c && typeof c !== "function" && st.resLen < 262144) {
                const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
                st.res.push(b);
                st.resLen += b.length;
              }
            };
            res.write = function (c) {
              try { tap(c); } catch (_) {}
              return w.apply(this, arguments);
            };
            res.end = function (c) {
              try { tap(c); } catch (_) {}
              return e.apply(this, arguments);
            };
          }

          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            try {
              const durationMs = Date.now() - st.startMs;
              const attrs = { "freellmapi.route": st.path };
              const routedVia = hdr(res, "x-routed-via");
              const xProv = hdr(res, "x-provider");
              const xModel = hdr(res, "x-model");
              const cacheHdr = hdr(res, "x-freellm-cache");
              const reqId = hdr(res, "x-request-id");

              if (routedVia) {
                attrs["freellmapi.routed_via"] = routedVia;
                const slash = routedVia.indexOf("/");
                if (slash > 0) {
                  attrs["gen_ai.provider.name"] = routedVia.slice(0, slash);
                  attrs["gen_ai.response.model"] = routedVia.slice(slash + 1);
                }
              } else if (xProv) {
                attrs["gen_ai.provider.name"] = xProv;
              }
              if (xModel && !attrs["gen_ai.response.model"]) {
                attrs["gen_ai.response.model"] = xModel;
              }
              if (cacheHdr) attrs["freellmapi.cache"] = cacheHdr;
              if (reqId) attrs["freellmapi.request_id"] = reqId;
              if (res.statusCode >= 400) attrs["error.type"] = String(res.statusCode);

              if (st.llm) {
                const reqBody = tryJson(Buffer.concat(st.req).toString("utf8")) || {};
                const text = Buffer.concat(st.res).toString("utf8");
                const out = parseResponse(text);
                const tail = st.path.replace(/^\/(v1|v1beta)\//, "");
                attrs["gen_ai.operation.name"] = OPS[tail] || "chat";
                if (!attrs["gen_ai.provider.name"]) attrs["gen_ai.provider.name"] = "freellmapi";
                if (reqBody.model) attrs["gen_ai.request.model"] = String(reqBody.model);
                if (out.model) attrs["gen_ai.response.model"] = String(out.model);
                if (out.in != null) attrs["gen_ai.usage.input_tokens"] = out.in;
                if (out.out != null) attrs["gen_ai.usage.output_tokens"] = out.out;
              }

              span.setAttributes(attrs);

              const sc = span.spanContext();
              const valid = isSpanContextValid(sc);
              const traceId = valid ? sc.traceId : undefined;
              const spanId = valid ? sc.spanId : undefined;

              const logObj = {
                event: "http_request",
                service: SERVICE_NAME,
                method: req.method,
                path: st.path,
                status: res.statusCode,
                duration_ms: durationMs,
              };
              if (traceId) logObj.trace_id = traceId;
              if (spanId) logObj.span_id = spanId;
              if (reqId) logObj.request_id = reqId;
              if (routedVia) logObj.routed_via = routedVia;
              if (attrs["gen_ai.request.model"]) logObj.request_model = attrs["gen_ai.request.model"];
              if (attrs["gen_ai.response.model"]) logObj.response_model = attrs["gen_ai.response.model"];

              process.stdout.write(JSON.stringify(logObj) + "\n");

              otelLogger.emit({
                severityNumber: res.statusCode >= 500 ? SeverityNumber.ERROR : res.statusCode >= 400 ? SeverityNumber.WARN : SeverityNumber.INFO,
                body: JSON.stringify(logObj),
                attributes: {
                  "http.request.method": req.method || "",
                  "url.path": st.path,
                  "http.response.status_code": res.statusCode || 0,
                  "trace_id": traceId || "",
                  "span_id": spanId || "",
                },
                context: trace.setSpan(context.active(), span),
              });
            } catch (_) {}
          };
          res.prependOnceListener("finish", finish);
          res.prependOnceListener("close", finish);
        } catch (_) {}
      },
    });

    const undiciInst = new UndiciInstrumentation({
      ignoreRequestHook: (req) => {
        const origin = String((req && req.origin) || "");
        const path = String((req && req.path) || "");
        if (origin.includes("otel-collector")) return true;
        if ((origin.includes("127.0.0.1:3001") || origin.includes("localhost:3001")) && path === "/api/ping") return true;
        return false;
      },
    });

    registerInstrumentations({ instrumentations: [httpInst, undiciInst] });

    process.on("SIGTERM", () => {
      Promise.allSettled([tp.shutdown(), lp.shutdown()]);
    });
  } catch (err) {
    try {
      console.warn("[otel-preload] disabled:", err && err.message);
    } catch (_) {}
  }
})();

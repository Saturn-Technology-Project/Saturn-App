import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace, type Span } from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
} from "@opentelemetry/semantic-conventions";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { failSpan, instruments, seconds, tracer } from "../infrastructure/telemetry.js";

const SPAN = Symbol("saturn.span");

/**
 * A server span per HTTP request, continuing any trace the caller sent in `traceparent`.
 * Named "<METHOD> <route template>" once routing has matched, so ids never end up in span names.
 */
export function traceRequests(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // The Telemetry page polls /telemetry; tracing those reads would only record the act of looking.
    if (req.method === "OPTIONS" || req.path.startsWith("/telemetry")) {
      next();
      return;
    }
    const parent = propagation.extract(ROOT_CONTEXT, req.headers);
    const span = tracer.startSpan(
      req.method,
      {
        kind: SpanKind.SERVER,
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: req.method, [ATTR_URL_PATH]: req.path },
      },
      parent,
    );
    (res as Response & { [SPAN]?: Span })[SPAN] = span;
    const startedAt = performance.now();
    res.once("finish", () => {
      const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : undefined;
      const status = res.statusCode;
      if (route) {
        span.updateName(`${req.method} ${route}`);
        span.setAttribute(ATTR_HTTP_ROUTE, route);
      }
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      instruments().httpDuration.record(seconds(startedAt), {
        [ATTR_HTTP_REQUEST_METHOD]: req.method,
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: status,
        ...(route ? { [ATTR_HTTP_ROUTE]: route } : {}),
      });
    });
    context.with(trace.setSpan(parent, span), next);
  };
}

/** Called by the error handler so a failed request carries the exception on its span. */
export function recordRequestError(res: Response, error: unknown): void {
  const span = (res as Response & { [SPAN]?: Span })[SPAN];
  if (span) failSpan(span, error);
}

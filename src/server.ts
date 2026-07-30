import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { GaslessError, ValidationError } from "./errors.js";
import type { ListenOptions, PoolInfo, PoolServer } from "./types.js";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export interface PoolServerHandlers {
  /** Rules and address the pool publishes at `GET /conditions`. */
  info(): PoolInfo;
  /** Validate and co-sign; returns the signed transaction CBOR. */
  sign(txCbor: string): Promise<string>;
  /** Origins allowed to call the server from a browser. */
  allowedOrigins?: string[];
}

const readBody = (request: IncomingMessage, maxBytes: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new GaslessError("InvalidInput", `Request body exceeds ${maxBytes} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const sendJson = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
};

/**
 * Errors cross a network boundary here, so they are reduced to a code and a
 * message. Anything that is not a deliberate rejection becomes a generic 500:
 * internal failures should not leak provider URLs or stack traces to callers.
 */
const toErrorResponse = (error: unknown): { status: number; body: unknown } => {
  if (error instanceof ValidationError) {
    return { status: 400, body: { data: null, error: error.toJSON(), success: false } };
  }
  if (error instanceof GaslessError && error.code === "InvalidInput") {
    return { status: 400, body: { data: null, error: error.toJSON(), success: false } };
  }
  return {
    status: 500,
    body: {
      data: null,
      error: {
        code: "SigningServerError",
        message: "The pool server could not sign this transaction.",
      },
      success: false,
    },
  };
};

/**
 * Start the pool signing server.
 *
 * `POST /` validates and co-signs a transaction; `GET /conditions` publishes
 * the pool address and rules so a sponsor can pre-validate.
 */
export const startPoolServer = (
  handlers: PoolServerHandlers,
  options: ListenOptions = {},
): Promise<PoolServer> => {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const origins = handlers.allowedOrigins;

  const applyCors = (request: IncomingMessage, response: ServerResponse): void => {
    if (!origins?.length) return;
    const origin = request.headers.origin;
    if (origin && origins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  const server = createServer((request, response) => {
    applyCors(request, response);

    void (async () => {
      try {
        const path =
          new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";

        if (request.method === "OPTIONS") {
          response.writeHead(204).end();
          return;
        }

        if (request.method === "GET" && path === "/conditions") {
          sendJson(response, 200, handlers.info());
          return;
        }

        if (request.method === "POST" && path === "/") {
          const raw = await readBody(request, maxBodyBytes);

          let payload: { txCbor?: unknown };
          try {
            payload = JSON.parse(raw) as { txCbor?: unknown };
          } catch {
            throw new GaslessError("InvalidInput", "Request body must be JSON.");
          }

          if (typeof payload.txCbor !== "string" || payload.txCbor.length === 0) {
            throw new GaslessError("InvalidInput", "Request body must contain a `txCbor` string.");
          }

          sendJson(response, 200, {
            data: await handlers.sign(payload.txCbor),
            error: null,
            success: true,
          });
          return;
        }

        sendJson(response, 404, {
          data: null,
          error: { code: "InvalidInput", message: `No route for ${request.method} ${path}.` },
          success: false,
        });
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        if (!response.headersSent) sendJson(response, status, body);
      }
    })();
  });

  return new Promise<PoolServer>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(
        new GaslessError("ProviderError", `Pool server could not start: ${error.message}`, error),
      );
    };

    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

      resolve({
        port,
        url: `http://${options.hostname ?? "localhost"}:${port}`,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
            server.closeAllConnections?.();
          }),
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 8080, options.hostname);
  });
};

/**
 * Remote transport: MCP over Streamable HTTP behind the owner OAuth server, so
 * claude.ai (web, desktop and mobile) can use the connector as a custom
 * connector. Run behind an HTTPS tunnel or reverse proxy.
 */
import express from "express";
import { rateLimit } from "express-rate-limit";
import type { Server } from "node:http";
import { join } from "node:path";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ConnectorContext } from "./context.js";
import { MAIL_SCOPE, OwnerOAuthProvider } from "./oauth.js";
import { parseRedirectList } from "./redirects.js";
import { createMcpServer } from "./tools.js";

export interface HttpOptions {
  /** Public HTTPS origin clients reach, e.g. https://mail.example.com. */
  publicUrl: URL;
  ownerPassword: string;
  host: string;
  port: number;
  /** Express "trust proxy" setting; loopback suits a local tunnel daemon. */
  trustProxy: string | number | boolean;
  redirectUris: string[];
  storePath: string;
}

export function httpOptionsFromEnv(
  ctx: ConnectorContext,
  env: NodeJS.ProcessEnv = process.env
): HttpOptions {
  const publicUrl = env.ICLOUD_MAIL_PUBLIC_URL;
  if (!publicUrl) throw new Error("Set ICLOUD_MAIL_PUBLIC_URL to the server's public HTTPS URL.");
  const ownerPassword = env.ICLOUD_MAIL_OWNER_PASSWORD;
  if (!ownerPassword) throw new Error("Set ICLOUD_MAIL_OWNER_PASSWORD to approve OAuth clients.");
  const trust = env.ICLOUD_MAIL_TRUST_PROXY ?? "loopback";
  return {
    publicUrl: new URL(publicUrl),
    ownerPassword,
    host: env.ICLOUD_MAIL_HTTP_HOST || "127.0.0.1",
    port: Number.parseInt(env.ICLOUD_MAIL_HTTP_PORT || "8787", 10),
    trustProxy: /^\d+$/.test(trust) ? Number(trust) : trust === "true" ? true : trust,
    redirectUris: parseRedirectList(env.ICLOUD_MAIL_OAUTH_REDIRECT_URIS),
    storePath: env.ICLOUD_MAIL_OAUTH_STORE || join(ctx.dataDirectory, "oauth.json"),
  };
}

export function createHttpApp(ctx: ConnectorContext, options: HttpOptions) {
  const origin = new URL(options.publicUrl.origin);
  const mcpUrl = new URL("/mcp", origin);
  const provider = new OwnerOAuthProvider({
    storePath: options.storePath,
    ownerPassword: options.ownerPassword,
    resourceUrl: mcpUrl,
    redirectUris: options.redirectUris,
  });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: origin,
      resourceServerUrl: mcpUrl,
      scopesSupported: [MAIL_SCOPE],
      resourceName: "iCloud Mail",
    })
  );
  app.post(
    "/oauth/approve",
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: "4kb" }),
    (req, res) => {
      const body = req.body as Record<string, unknown>;
      const result = provider.approve(
        String(body.request_id ?? ""),
        String(body.password ?? ""),
        String(body.decision ?? "")
      );
      res.set("Cache-Control", "no-store");
      if ("redirect" in result) res.redirect(302, result.redirect);
      else res.status(result.status).type("text/plain").send(result.error);
    }
  );

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [MAIL_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
  // Stateless: each request gets its own server instance, while the context
  // (draft registry and operation queue) is shared.
  app.post("/mcp", bearer, express.json({ limit: "40mb" }), async (req, res) => {
    const server = createMcpServer(ctx, { remote: true });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error instanceof Error ? error.message : error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  app.all("/mcp", bearer, (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
  });
  return app;
}

export function startHttpServer(ctx: ConnectorContext, options: HttpOptions): Promise<Server> {
  const app = createHttpApp(ctx, options);
  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, options.host, () => {
      console.error(
        `iCloud Mail MCP listening on http://${options.host}:${options.port} for ${new URL("/mcp", options.publicUrl.origin).href}`
      );
      resolve(server);
    });
    server.on("error", reject);
  });
}

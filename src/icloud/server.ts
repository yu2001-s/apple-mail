#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dropAllPools } from "../services/imapClient.js";
import { loadContext } from "./context.js";
import { createMcpServer } from "./tools.js";
import { httpOptionsFromEnv, startHttpServer } from "./http.js";

const ctx = loadContext();
const remote = process.argv.includes("--http") || process.env.ICLOUD_MAIL_TRANSPORT === "http";
let close: () => Promise<void> = async () => undefined;

async function main() {
  // Seed settings.json from the account configuration on first run.
  await ctx.refresh();
  if (remote) {
    const server = await startHttpServer(ctx, httpOptionsFromEnv(ctx));
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  } else {
    const server = createMcpServer(ctx);
    close = () => server.close();
    process.stdin.on("end", () => {
      void stop();
    });
    await server.connect(new StdioServerTransport());
  }
}

async function stop() {
  await dropAllPools();
  await close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stop().finally(() => process.exit(0));
  });
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

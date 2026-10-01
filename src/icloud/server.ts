#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dropAllPools } from "../services/imapClient.js";
import { loadContext } from "./context.js";
import { createMcpServer } from "./tools.js";
import { httpOptionsFromEnv, startHttpServer } from "./http.js";

const ctx = loadContext();
const remote = process.argv.includes("--http") || process.env.ICLOUD_MAIL_TRANSPORT === "http";

let close: () => Promise<void>;
if (remote) {
  const http = startHttpServer(ctx, httpOptionsFromEnv(ctx));
  http.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
  close = async () => {
    const server = await http;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
} else {
  const server = createMcpServer(ctx);
  close = () => server.close();
  process.stdin.on("end", () => {
    void stop();
  });
  server.connect(new StdioServerTransport()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function stop() {
  await dropAllPools();
  await close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stop().finally(() => process.exit(0));
  });

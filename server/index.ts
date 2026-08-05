import path from "node:path";

import { buildApp } from "./app.js";

const port = parsePort(process.env.PORT);
// Bind all interfaces by default so devices on the local network can connect.
// Set HOST=127.0.0.1 when local-only access is preferred.
const host = process.env.HOST ?? "0.0.0.0";
const storageDirectory = path.resolve(process.env.STORAGE_DIR ?? "data");

const app = await buildApp({
  storageDirectory,
  appBaseUrl: process.env.APP_BASE_URL,
  logger: true,
  serveClient: process.env.NODE_ENV === "production",
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return 3000;
  }
  const parsed = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}

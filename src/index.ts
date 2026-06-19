import * as http from "http";

import * as config from "./config";
import * as runner from "./runner";
import { app, attachWebSocket } from "./server";

function main(): void {
  // Keep this local single-user server alive on a stray error rather than letting
  // an unhandled rejection terminate the process (Node 15+ exits by default).
  process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
  process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

  runner.ensureScaffold();   // create msgragtest/{input,output,prompts} + seed prompts

  const server = http.createServer(app);
  attachWebSocket(server);

  // A bind failure is fatal (the server can't serve), so exit clearly instead of
  // lingering uselessly -- otherwise the uncaughtException handler above would
  // swallow EADDRINUSE and the process would hang without listening.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${config.PORT} is already in use — is the app already running? ` +
        `Stop the other process or change PORT in src/config.ts.`);
    } else {
      console.error("Server error:", err.message);
    }
    process.exit(1);
  });

  server.listen(config.PORT, config.HOST, () => {
    const bar = "=".repeat(70);
    console.log(bar);
    console.log(" GraphRAG Test UI  (Node.js + TypeScript)");
    console.log(`   USE_MOCK : ${config.USE_MOCK}  (edit src/config.ts to change)`);
    console.log(`   BASE_DIR : ${config.BASE_DIR}`);
    console.log(`   URL      : http://${config.HOST}:${config.PORT}`);
    console.log(bar);
  });
}

main();

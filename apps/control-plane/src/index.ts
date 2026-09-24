import { config } from "./config.js";
import { createServer } from "./server.js";
import { logEvent } from "./memory.js";

const server = createServer();

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      msg: "control-plane up",
      url: `http://${config.host}:${config.port}`,
      agentMode: config.agentMode,
      sandboxMode: config.sandboxMode,
      dryRun: config.dryRun,
      providers: config.modelOrder,
    }),
  );
  logEvent(null, "server.start", { port: config.port });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}

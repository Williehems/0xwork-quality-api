import { config } from "./config.js";
import { createApiApp, logApiStartupNotes } from "./app.js";

const app = createApiApp();

app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port} (env=${config.nodeEnv})`);
  logApiStartupNotes();
});

import { loadConfig } from "../config.ts";
import { startServer } from "./app.ts";

const { server } = await startServer(await loadConfig());
console.log(`doi is running at ${server.url}`);

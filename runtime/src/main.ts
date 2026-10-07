import os from "node:os";
import path from "node:path";
import { createApp } from "./presentation/app.js";
import { FileStore } from "./infrastructure/store.js";

const host = process.env.SATURN_RUNTIME_HOST ?? "127.0.0.1";
const port = Number(process.env.SATURN_RUNTIME_PORT ?? 4700);
const directory = process.env.SATURN_DATA_DIR ?? path.join(os.homedir(), ".saturn-app");

const store = new FileStore(directory);
await store.load();
const { app } = createApp(store);
app.listen(port, host, () => {
  console.log(`Saturn Runtime listening on http://${host}:${port}`);
});

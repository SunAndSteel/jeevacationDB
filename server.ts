// deno run -A server.ts --db records.sqlite --port 8787
import { createApp } from "./server/app.ts";

function arg(name: string, def?: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Deno.args[i + 1];
  if (!v || v.startsWith("--")) return def;
  return v;
}

const app = createApp({
  dbPath: arg("db", "records.sqlite")!,
  port: Number(arg("port", "8787") ?? "8787"),
  runId: (arg("run", "content") ?? "content").trim(),
});

app.start();

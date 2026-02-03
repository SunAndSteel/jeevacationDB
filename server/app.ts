import { openDatabase } from "./db.ts";
import { createHandlers } from "./handlers.ts";
import { INDEX_HTML } from "./ui.ts";

export type AppOptions = {
  dbPath: string;
  port: number;
  runId: string;
};

export function createApp(options: AppOptions) {
  const { db, runId } = openDatabase(options.dbPath, options.runId);
  const handlers = createHandlers(db, runId);

  function start() {
    Deno.serve({ port: options.port }, (req) => {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/") {
        return handlers.text(INDEX_HTML, 200, "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/api/search") {
        return handlers.handleSearch(url);
      }
      if (req.method === "GET" && url.pathname === "/api/doc") {
        return handlers.handleDoc(url);
      }
      if (req.method === "POST" && url.pathname === "/api/mark") {
        return handlers.handleMark(req);
      }
      if (req.method === "GET" && url.pathname === "/api/marks") {
        return handlers.handleMarks();
      }
      if (req.method === "GET" && url.pathname === "/api/export") {
        return handlers.handleExport(url);
      }
      return handlers.text("Not found", 404);
    });

    console.log(`Server ready: http://localhost:${options.port}`);
    console.log(`DB: ${options.dbPath} | run_id: ${runId}`);
  }

  return { start };
}

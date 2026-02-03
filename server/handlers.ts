import type { DB } from "https://deno.land/x/sqlite@v3.9.1/mod.ts";

function toInt(v: string | null, def: number, min = 1, max = 200): number {
  const n = v ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function createHandlers(db: DB, runId: string) {
  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
    return new Response(body, {
      status,
      headers: { "content-type": contentType, "cache-control": "no-store" },
    });
  }

  const qChunks = db.prepareQuery(`
    SELECT
      c.doc_id AS doc_id,
      COALESCE(c.source_file, d.source_file) AS source_file,
      c.order_index AS order_index,
      snippet(chunks_fts, 0, '[', ']', ' … ', 12) AS snippet,
      bm25(chunks_fts) AS score,
      CASE WHEN m.doc_id IS NULL THEN 0 ELSE 1 END AS marked
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    LEFT JOIN docs d ON d.run_id = c.run_id AND d.doc_id = c.doc_id
    LEFT JOIN marks m ON m.run_id = c.run_id AND m.doc_id = c.doc_id
    WHERE c.run_id = ? AND chunks_fts MATCH ?
    ORDER BY score
    LIMIT ? OFFSET ?;
  `);

  const qDocs = db.prepareQuery(`
    SELECT
      c.doc_id AS doc_id,
      MIN(COALESCE(c.source_file, d.source_file)) AS source_file,
      MIN(bm25(chunks_fts)) AS best_score,
      COUNT(*) AS hit_chunks,
      CASE WHEN m.doc_id IS NULL THEN 0 ELSE 1 END AS marked
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    LEFT JOIN docs d ON d.run_id = c.run_id AND d.doc_id = c.doc_id
    LEFT JOIN marks m ON m.run_id = c.run_id AND m.doc_id = c.doc_id
    WHERE c.run_id = ? AND chunks_fts MATCH ?
    GROUP BY c.doc_id
    ORDER BY best_score
    LIMIT ? OFFSET ?;
  `);

  const qDocText = db.prepareQuery(`
    SELECT
      COALESCE(
        (SELECT source_file FROM docs WHERE run_id = ? AND doc_id = ?),
        (SELECT MIN(source_file) FROM chunks WHERE run_id = ? AND doc_id = ?)
      ) AS source_file,
      EXISTS(
        SELECT 1 FROM marks WHERE run_id = ? AND doc_id = ?
      ) AS marked
  `);

  const qDocChunks = db.prepareQuery(`
    SELECT order_index, text
    FROM chunks
    WHERE run_id = ? AND doc_id = ?
    ORDER BY order_index;
  `);

  const qMarks = db.prepareQuery(`
    SELECT m.doc_id, m.created_at, MIN(COALESCE(c.source_file, d.source_file)) AS source_file
    FROM marks m
    LEFT JOIN chunks c ON c.run_id = m.run_id AND c.doc_id = m.doc_id
    LEFT JOIN docs d ON d.run_id = m.run_id AND d.doc_id = m.doc_id
    WHERE m.run_id = ?
    GROUP BY m.doc_id, m.created_at
    ORDER BY m.created_at DESC;
  `);

  const qMarkInsert = db.prepareQuery(`
    INSERT INTO marks(run_id, doc_id) VALUES(?, ?)
    ON CONFLICT(run_id, doc_id) DO UPDATE SET created_at = datetime('now');
  `);

  const qMarkDelete = db.prepareQuery(`
    DELETE FROM marks WHERE run_id = ? AND doc_id = ?;
  `);

  function handleSearch(url: URL): Response {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return json({ items: [] });

    const mode = (url.searchParams.get("mode") ?? "chunks").toLowerCase();
    const limit = toInt(url.searchParams.get("limit"), 25, 1, 100);
    const offset = toInt(url.searchParams.get("offset"), 0, 0, 2_000_000);

    try {
      if (mode === "docs") {
        const items = qDocs.all([runId, q, limit, offset]).map((r) => ({
          doc_id: r[0],
          source_file: r[1],
          best_score: r[2],
          hit_chunks: r[3],
          marked: Boolean(r[4]),
        }));
        return json({ items });
      }

      const items = qChunks.all([runId, q, limit, offset]).map((r) => ({
        doc_id: r[0],
        source_file: r[1],
        order_index: r[2],
        snippet: r[3],
        score: r[4],
        marked: Boolean(r[5]),
      }));
      return json({ items });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  function handleDoc(url: URL): Response {
    const docId = (url.searchParams.get("doc_id") ?? "").trim();
    const maxChars = toInt(url.searchParams.get("max_chars"), 120000, 1000, 2_000_000);
    if (!docId) return json({ error: "missing doc_id" }, 400);

    try {
      const metaRow = qDocText.first([runId, docId, runId, docId, runId, docId]);
      const sourceFile = metaRow ? String(metaRow[0] ?? "") : "";
      const marked = metaRow ? Boolean(metaRow[1]) : false;

      let out = "";
      let total = 0;
      for (const r of qDocChunks.all([runId, docId])) {
        const t = String(r[1] ?? "");
        if (!t) continue;
        if (total + t.length > maxChars) {
          const remain = maxChars - total;
          if (remain > 0) out += (out ? "\n\n" : "") + t.slice(0, remain);
          break;
        }
        out += (out ? "\n\n" : "") + t;
        total += t.length;
      }
      return json({ doc_id: docId, source_file: sourceFile, text: out, marked });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  async function handleMark(req: Request): Promise<Response> {
    try {
      const data = await req.json();
      const docId = String(data?.doc_id ?? "").trim();
      const state = Boolean(data?.state);
      if (!docId) return json({ error: "missing doc_id" }, 400);
      if (state) {
        qMarkInsert.execute([runId, docId]);
        return json({ ok: true, marked: true });
      }
      qMarkDelete.execute([runId, docId]);
      return json({ ok: true, marked: false });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  function handleMarks(): Response {
    try {
      const items = qMarks.all([runId]).map((r) => ({
        doc_id: r[0],
        created_at: r[1],
        source_file: r[2],
      }));
      return json({ items });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  function toCsv(rows: Array<Record<string, string>>): string {
    const header = ["doc_id", "source_file", "created_at"];
    const escape = (v: string) => `"${v.replaceAll(`"`, `""`)}"`;
    const lines = [header.join(",")];
    for (const row of rows) {
      lines.push([row.doc_id, row.source_file, row.created_at].map((v) => escape(v ?? "")).join(","));
    }
    return lines.join("\n");
  }

  function handleExport(url: URL): Response {
    try {
      const format = (url.searchParams.get("format") ?? "json").toLowerCase();
      const rows = qMarks.all([runId]).map((r) => ({
        doc_id: String(r[0] ?? ""),
        source_file: String(r[2] ?? ""),
        created_at: String(r[1] ?? ""),
      }));
      if (format === "csv") {
        return text(toCsv(rows), 200, "text/csv; charset=utf-8");
      }
      return json({ items: rows });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  return { handleSearch, handleDoc, handleMark, handleMarks, handleExport, json, text };
}

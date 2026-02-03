// server.ts
// deno run -A server.ts --db records.sqlite --port 8787
import { DB } from "https://deno.land/x/sqlite@v3.9.1/mod.ts";

function arg(name: string, def?: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Deno.args[i + 1];
  if (!v || v.startsWith("--")) return def;
  return v;
}

function toInt(v: string | null, def: number, min = 1, max = 200): number {
  const n = v ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

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

const INDEX_HTML = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Records Search</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0b0c10;
      --fg: #e7e7e7;
      --muted: #a7a7a7;
      --card: rgba(255,255,255,0.06);
      --border: rgba(255,255,255,0.12);
      --accent: #7dd3fc;
    }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 18px; }
    h1 { font-size: 18px; margin: 0 0 12px; color: var(--fg); font-weight: 650; }
    .bar { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; }
    input[type="text"] {
      width: 100%; padding: 12px 12px; border-radius: 12px;
      border: 1px solid var(--border); background: rgba(255,255,255,0.04); color: var(--fg);
      outline: none;
    }
    select, button {
      padding: 11px 12px; border-radius: 12px; border: 1px solid var(--border);
      background: rgba(255,255,255,0.04); color: var(--fg); cursor: pointer;
    }
    button { font-weight: 600; }
    button:hover { border-color: rgba(255,255,255,0.22); }
    .hint { margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.35; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 14px; }
    .card {
      border: 1px solid var(--border); background: var(--card); border-radius: 14px; padding: 12px 12px;
    }
    .row { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; }
    .meta { color: var(--muted); font-size: 12px; }
    .doc { color: var(--accent); font-weight: 650; }
    .snippet { margin-top: 8px; white-space: pre-wrap; font-size: 13px; line-height: 1.35; }
    .snippet mark { background: rgba(125,211,252,0.25); color: inherit; padding: 0 2px; border-radius: 4px; }
    .pager { display: flex; gap: 8px; margin-top: 14px; align-items: center; }
    .pager .sp { flex: 1; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    dialog { max-width: 900px; width: 92vw; border: 1px solid var(--border); border-radius: 16px; background: #0f1116; color: var(--fg); }
    dialog::backdrop { background: rgba(0,0,0,0.55); }
    .dochead { display:flex; gap:10px; align-items:center; justify-content:space-between; margin-bottom:10px; }
    .docbody { white-space: pre-wrap; font-size: 13px; line-height: 1.4; }
    .close { padding: 10px 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Records Search</h1>

    <div class="bar">
      <input id="q" type="text" placeholder='Ex: "training program" Antalya OR Rixos' />
      <select id="mode">
        <option value="chunks">Passages</option>
        <option value="docs">Documents</option>
      </select>
      <button id="go">Chercher</button>
    </div>

    <div class="hint">
      Syntaxe FTS : <span class="mono">mots</span>, <span class="mono">"phrase"</span>, <span class="mono">OR</span>, <span class="mono">AND</span>, <span class="mono">NOT</span>.<br/>
      Tout est local : rien n’est envoyé sur Internet.
    </div>

    <div id="results" class="grid"></div>

    <div class="pager">
      <button id="prev">← Précédent</button>
      <button id="next">Suivant →</button>
      <div class="sp"></div>
      <div class="meta" id="status"></div>
    </div>
  </div>

  <dialog id="dlg">
    <div class="dochead">
      <div>
        <div class="doc" id="dlgDoc"></div>
        <div class="meta" id="dlgFile"></div>
      </div>
      <button class="close" id="dlgClose">Fermer</button>
    </div>
    <div class="docbody" id="dlgBody"></div>
  </dialog>

<script>
(() => {
  const qEl = document.getElementById("q");
  const modeEl = document.getElementById("mode");
  const resEl = document.getElementById("results");
  const statusEl = document.getElementById("status");
  const prevEl = document.getElementById("prev");
  const nextEl = document.getElementById("next");
  const goEl = document.getElementById("go");

  const dlg = document.getElementById("dlg");
  const dlgDoc = document.getElementById("dlgDoc");
  const dlgFile = document.getElementById("dlgFile");
  const dlgBody = document.getElementById("dlgBody");
  const dlgClose = document.getElementById("dlgClose");

  let offset = 0;
  let limit = 25;
  let lastCount = 0;

  async function search() {
    const q = (qEl.value || "").trim();
    const mode = modeEl.value;
    if (!q) {
      resEl.innerHTML = "";
      statusEl.textContent = "";
      return;
    }
    statusEl.textContent = "Recherche…";

    const url = new URL("/api/search", location.origin);
    url.searchParams.set("q", q);
    url.searchParams.set("mode", mode);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const r = await fetch(url);
    const data = await r.json();
    lastCount = (data.items || []).length;

    resEl.innerHTML = "";
    for (const item of (data.items || [])) {
      const card = document.createElement("div");
      card.className = "card";

      const top = document.createElement("div");
      top.className = "row";

      const left = document.createElement("div");
      const doc = document.createElement("a");
      doc.href = "#";
      doc.textContent = item.doc_id;
      doc.className = "doc mono";
      doc.addEventListener("click", async (e) => {
        e.preventDefault();
        await openDoc(item.doc_id);
      });
      left.appendChild(doc);

      const right = document.createElement("div");
      right.className = "meta mono";
      if (mode === "chunks") {
        right.textContent = "score=" + Number(item.score).toFixed(4) + "  idx=" + item.order_index;
      } else {
        right.textContent = "best=" + Number(item.best_score).toFixed(4) + "  hits=" + item.hit_chunks;
      }

      top.appendChild(left);
      top.appendChild(right);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = item.source_file || "";

      const sn = document.createElement("div");
      sn.className = "snippet";
      sn.innerHTML = (item.snippet || "").replaceAll("[", "<mark>").replaceAll("]", "</mark>");

      card.appendChild(top);
      card.appendChild(meta);
      if (mode === "chunks") card.appendChild(sn);

      resEl.appendChild(card);
    }

    statusEl.textContent = "offset=" + offset + "  •  affichés=" + lastCount + "  •  requête=" + JSON.stringify(q);
  }

  async function openDoc(docId) {
    dlgDoc.textContent = docId;
    dlgFile.textContent = "";
    dlgBody.textContent = "Chargement…";
    dlg.showModal();

    const url = new URL("/api/doc", location.origin);
    url.searchParams.set("doc_id", docId);
    url.searchParams.set("max_chars", "120000");

    const r = await fetch(url);
    const data = await r.json();
    dlgFile.textContent = data.source_file || "";
    dlgBody.textContent = data.text || "(vide)";
  }

  goEl.addEventListener("click", () => { offset = 0; search(); });
  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { offset = 0; search(); }
  });

  prevEl.addEventListener("click", () => {
    offset = Math.max(0, offset - limit);
    search();
  });
  nextEl.addEventListener("click", () => {
    if (lastCount < limit) return;
    offset += limit;
    search();
  });

  dlgClose.addEventListener("click", () => dlg.close());
})();
</script>
</body>
</html>`;

// Args
const dbPath = arg("db", "records.sqlite")!;
const port = Number(arg("port", "8787") ?? "8787");
const runId = (arg("run", "content") ?? "content").trim();

const db = new DB(dbPath);

// Prepared queries
const qChunks = db.prepareQuery(`
  SELECT
    c.doc_id AS doc_id,
    c.source_file AS source_file,
    c.order_index AS order_index,
    snippet(chunks_fts, 0, '[', ']', ' … ', 12) AS snippet,
    bm25(chunks_fts) AS score
  FROM chunks_fts
  JOIN chunks c ON c.id = chunks_fts.rowid
  WHERE c.run_id = ? AND chunks_fts MATCH ?
  ORDER BY score
  LIMIT ? OFFSET ?;
`);

const qDocs = db.prepareQuery(`
  SELECT
    c.doc_id AS doc_id,
    MIN(c.source_file) AS source_file,
    MIN(bm25(chunks_fts)) AS best_score,
    COUNT(*) AS hit_chunks
  FROM chunks_fts
  JOIN chunks c ON c.id = chunks_fts.rowid
  WHERE c.run_id = ? AND chunks_fts MATCH ?
  GROUP BY c.doc_id
  ORDER BY best_score
  LIMIT ? OFFSET ?;
`);

const qDocText = db.prepareQuery(`
  SELECT MIN(source_file) AS source_file
  FROM chunks
  WHERE run_id = ? AND doc_id = ?;
`);

const qDocChunks = db.prepareQuery(`
  SELECT order_index, text
  FROM chunks
  WHERE run_id = ? AND doc_id = ?
  ORDER BY order_index;
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
      }));
      return json({ items });
    }

    const items = qChunks.all([runId, q, limit, offset]).map((r) => ({
      doc_id: r[0],
      source_file: r[1],
      order_index: r[2],
      snippet: r[3],
      score: r[4],
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
    const metaRow = qDocText.first([runId, docId]);
    const sourceFile = metaRow ? String(metaRow[0] ?? "") : "";

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
    return json({ doc_id: docId, source_file: sourceFile, text: out });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

Deno.serve({ port }, (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/") {
    return text(INDEX_HTML, 200, "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/api/search") {
    return handleSearch(url);
  }
  if (req.method === "GET" && url.pathname === "/api/doc") {
    return handleDoc(url);
  }
  return text("Not found", 404);
});

console.log(`Server ready: http://localhost:${port}`);
console.log(`DB: ${dbPath} | run_id: ${runId}`);

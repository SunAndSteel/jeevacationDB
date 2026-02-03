export const INDEX_HTML = `<!doctype html>
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
    .bar { display: grid; grid-template-columns: 1fr auto auto auto; gap: 10px; align-items: center; }
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
    .row .left { display: flex; align-items: center; gap: 10px; }
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
    .mark { border-radius: 999px; padding: 6px 10px; border: 1px solid var(--border); background: rgba(255,255,255,0.04); }
    .mark[data-active="true"] { border-color: rgba(125,211,252,0.6); box-shadow: 0 0 0 1px rgba(125,211,252,0.3) inset; }
    .marks-dialog ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
    .marks-dialog li { border: 1px solid var(--border); border-radius: 12px; padding: 8px 10px; }
    .marks-actions { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
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
      <button id="marksBtn">Marqués</button>
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
      <div>
        <button class="mark" id="dlgMark" data-active="false">⭐ Marquer</button>
        <button class="close" id="dlgClose">Fermer</button>
      </div>
    </div>
    <div class="docbody" id="dlgBody"></div>
  </dialog>

  <dialog id="marksDlg" class="marks-dialog">
    <div class="dochead">
      <div>
        <div class="doc">Documents marqués</div>
        <div class="meta" id="marksCount"></div>
      </div>
      <button class="close" id="marksClose">Fermer</button>
    </div>
    <div class="marks-actions">
      <button id="exportJson">Exporter JSON</button>
      <button id="exportCsv">Exporter CSV</button>
    </div>
    <ul id="marksList"></ul>
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
  const dlgMark = document.getElementById("dlgMark");
  const marksBtn = document.getElementById("marksBtn");
  const marksDlg = document.getElementById("marksDlg");
  const marksClose = document.getElementById("marksClose");
  const marksList = document.getElementById("marksList");
  const marksCount = document.getElementById("marksCount");
  const exportJson = document.getElementById("exportJson");
  const exportCsv = document.getElementById("exportCsv");

  let offset = 0;
  let limit = 25;
  let lastCount = 0;
  let currentDocId = "";
  let currentMarked = false;

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
      left.className = "left";
      const markBtn = document.createElement("button");
      markBtn.className = "mark";
      markBtn.dataset.active = String(Boolean(item.marked));
      markBtn.textContent = item.marked ? "⭐" : "☆";
      markBtn.title = item.marked ? "Retirer des marques" : "Marquer ce document";
      markBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await setMark(item.doc_id, !item.marked);
        item.marked = !item.marked;
        markBtn.dataset.active = String(Boolean(item.marked));
        markBtn.textContent = item.marked ? "⭐" : "☆";
      });
      const doc = document.createElement("a");
      doc.href = "#";
      doc.textContent = item.doc_id;
      doc.className = "doc mono";
      doc.addEventListener("click", async (e) => {
        e.preventDefault();
        await openDoc(item.doc_id);
      });
      left.appendChild(markBtn);
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
    currentDocId = docId;
    currentMarked = false;
    dlgDoc.textContent = docId;
    dlgFile.textContent = "";
    dlgBody.textContent = "Chargement…";
    dlgMark.dataset.active = "false";
    dlgMark.textContent = "⭐ Marquer";
    dlg.showModal();

    const url = new URL("/api/doc", location.origin);
    url.searchParams.set("doc_id", docId);
    url.searchParams.set("max_chars", "120000");

    const r = await fetch(url);
    const data = await r.json();
    dlgFile.textContent = data.source_file || "";
    dlgBody.textContent = data.text || "(vide)";
    currentMarked = Boolean(data.marked);
    dlgMark.dataset.active = String(currentMarked);
    dlgMark.textContent = currentMarked ? "⭐ Marqué" : "⭐ Marquer";
  }

  async function setMark(docId, state) {
    if (!docId) return;
    const r = await fetch("/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc_id: docId, state }),
    });
    const data = await r.json();
    if (data.error) {
      alert(data.error);
    }
    if (docId === currentDocId) {
      currentMarked = state;
      dlgMark.dataset.active = String(state);
      dlgMark.textContent = state ? "⭐ Marqué" : "⭐ Marquer";
    }
  }

  async function loadMarks() {
    marksList.innerHTML = "";
    marksCount.textContent = "Chargement…";
    const r = await fetch("/api/marks");
    const data = await r.json();
    const items = data.items || [];
    marksCount.textContent = `${items.length} documents`;
    for (const item of items) {
      const li = document.createElement("li");
      const title = document.createElement("div");
      title.className = "doc mono";
      title.textContent = item.doc_id;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = item.source_file || "";
      li.appendChild(title);
      li.appendChild(meta);
      marksList.appendChild(li);
    }
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
  dlgMark.addEventListener("click", () => setMark(currentDocId, !currentMarked));

  marksBtn.addEventListener("click", () => {
    marksDlg.showModal();
    loadMarks();
  });
  marksClose.addEventListener("click", () => marksDlg.close());

  exportJson.addEventListener("click", () => {
    window.open("/api/export?format=json", "_blank");
  });
  exportCsv.addEventListener("click", () => {
    window.open("/api/export?format=csv", "_blank");
  });
})();
</script>
</body>
</html>`;

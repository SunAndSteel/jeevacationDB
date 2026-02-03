#!/usr/bin/env -S deno run -A
// deno run -A index_records_txt.ts --input ./epstein-justice-files-text/Datasets-9-12 --db records.sqlite --run content --dedupe 1 --chunk-size 2000
import { DB } from "https://deno.land/x/sqlite@v3.9.1/mod.ts";
import { bold, cyan, green, red, yellow } from "https://deno.land/std@0.224.0/fmt/colors.ts";
import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";

type Block = {
  sourceLine: string;
  metadataSource: string;
  metadataFilename: string;
  body: string;
};

type Stats = {
  docs: number;
  chunks: number;
  dupSkipped: number;
  lastFile?: string;
};

const SPLIT_MARKER = "----------------------------------------";
const SOURCE_RE = /^--- SOURCE:\s*(.+?)\s*---\s*$/gm;
const EFTA_RE = /\bEFTA\d{8}\b/;

function cleanText(text: string): string {
  return text.normalize("NFKC");
}

function sha256Hex(data: string): string {
  const bytes = new TextEncoder().encode(data);
  return [...new Uint8Array(crypto.subtle.digestSync("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseBlocks(fileText: string): Block[] {
  const matches = [...fileText.matchAll(SOURCE_RE)];
  if (!matches.length) return [];

  const blocks: Block[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const start = match.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? fileText.length) : fileText.length;
    const header = match[1] ?? "";
    const chunk = fileText.slice(start, end).trim();

    const metadataSource = chunk.match(/METADATA_SOURCE:\s*(.+)/)?.[1]?.trim() ?? "";
    const metadataFilename = chunk.match(/METADATA_FILENAME:\s*(.+)/)?.[1]?.trim() ?? "";

    const body = chunk.includes(SPLIT_MARKER)
      ? chunk.split(SPLIT_MARKER, 2)[1]?.trim() ?? ""
      : chunk.replace(/^--- SOURCE:.*---\s*/m, "").trim();

    blocks.push({
      sourceLine: header.trim(),
      metadataSource,
      metadataFilename,
      body,
    });
  }

  return blocks;
}

function extractEftaId(value: string): string | null {
  const match = value.match(EFTA_RE);
  return match?.[0] ?? null;
}

function guessType(body: string): string {
  const head = body.slice(0, 1500);
  const looksEmail = /(^|\n)\s*From:\s*/i.test(head) && /(^|\n)\s*Subject:\s*/i.test(head);
  return looksEmail ? "email_like" : "document_like";
}

function stripNoise(body: string): string {
  let t = body;
  t = t.replace(/--- PAGE \d+ ---/g, "\n");
  t = t.replace(/^METADATA_(SOURCE|FILENAME):.*$/gim, "");
  t = t.replace(/^Couldn't load plugin\.\s*$/gim, "");
  t = t.replace(/This communication contains information[\s\S]{0,900}?applicable law\.\s*/gi, "");
  t = t.replace(/please note[\s\S]{0,1400}?copyright -all rights reserved\s*/gi, "");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function chunkParagraph(text: string, targetSize: number): string[] {
  const parts = text.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return [text.trim()];

  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + part.length + 2 > targetSize) {
      chunks.push(current);
      current = part;
    } else {
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function ensureSchema(db: DB): void {
  db.execute("PRAGMA journal_mode=WAL");
  db.execute("PRAGMA synchronous=NORMAL");
  db.execute("PRAGMA temp_store=MEMORY");
  db.execute("PRAGMA mmap_size=268435456");
  db.execute("PRAGMA busy_timeout=5000");

  db.execute(`
    CREATE TABLE IF NOT EXISTS docs(
      run_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      meta_json TEXT,
      text_sha256 TEXT,
      text_chars INTEGER,
      PRIMARY KEY(run_id, doc_id)
    );
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS chunks(
      id INTEGER PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      order_index INTEGER,
      doc_id TEXT,
      source_file TEXT,
      text TEXT
    );
  `);
  db.execute("CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(run_id, doc_id, order_index)");
  db.execute("CREATE INDEX IF NOT EXISTS idx_docs_hash ON docs(run_id, text_sha256)");
  db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_uid ON chunks(uid)");

  db.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content='chunks',
      content_rowid='id',
      tokenize="unicode61"
    );
  `);
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function updateStatus(stats: Stats): void {
  const line = [
    `docs=${stats.docs.toLocaleString()}`,
    `chunks=${stats.chunks.toLocaleString()}`,
    `dup=${stats.dupSkipped.toLocaleString()}`,
    stats.lastFile ? `file=${stats.lastFile}` : "",
  ].filter(Boolean).join(" | ");
  Deno.stdout.writeSync(new TextEncoder().encode(`\r${line}   `));
}

function finishStatus(): void {
  Deno.stdout.writeSync(new TextEncoder().encode("\n"));
}

const flags = parse(Deno.args, {
  string: ["input", "db", "run"],
  boolean: ["dedupe", "reset"],
  default: {
    db: "records.sqlite",
    run: "content",
    dedupe: true,
    reset: false,
    "chunk-size": 2000,
  },
});

const inputDir = String(flags.input ?? "");
const dbPath = String(flags.db ?? "records.sqlite");
const runId = String(flags.run ?? "content").trim();
const dedupe = Boolean(flags.dedupe);
const chunkSize = Math.max(200, Number(flags["chunk-size"] ?? 2000));
const reset = Boolean(flags.reset);

if (!inputDir) {
  console.error(red("Error: --input is required"));
  Deno.exit(1);
}
if (!runId) {
  console.error(red("Error: --run must not be empty"));
  Deno.exit(1);
}

const inputStat = await Deno.stat(inputDir).catch(() => null);
if (!inputStat?.isDirectory) {
  console.error(red(`Error: input directory not found: ${inputDir}`));
  Deno.exit(1);
}

console.log(
  cyan(
    `runId="${runId}" | dedupe=${dedupe ? 1 : 0} | chunk_size=${chunkSize} | reset=${reset ? 1 : 0}`,
  ),
);

const db = new DB(dbPath);
ensureSchema(db);

if (reset) {
  console.log(yellow(`Resetting existing run_id data: ${runId}`));
  db.execute("BEGIN");
  db.query("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE run_id = ?)", [runId]);
  db.query("DELETE FROM chunks WHERE run_id = ?", [runId]);
  db.query("DELETE FROM docs WHERE run_id = ?", [runId]);
  db.execute("COMMIT");
}

const stmtDoc = db.prepareQuery(`
  INSERT INTO docs(run_id, doc_id, meta_json, text_sha256, text_chars)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(run_id, doc_id) DO UPDATE SET
    meta_json=excluded.meta_json,
    text_sha256=excluded.text_sha256,
    text_chars=excluded.text_chars;
`);

const stmtChunk = db.prepareQuery(`
  INSERT OR IGNORE INTO chunks(uid, run_id, chunk_id, order_index, doc_id, source_file, text)
  VALUES (?, ?, ?, ?, ?, ?, ?);
`);

const stmtFts = db.prepareQuery(`
  INSERT OR IGNORE INTO chunks_fts(rowid, text)
  VALUES (?, ?);
`);

const stmtDup = dedupe
  ? db.prepareQuery("SELECT doc_id FROM docs WHERE run_id = ? AND text_sha256 = ? LIMIT 1")
  : null;

const stats: Stats = { docs: 0, chunks: 0, dupSkipped: 0 };
let docSinceCommit = 0;

const encoder = new TextEncoder();

for await (const entry of walk(inputDir, { includeDirs: false, exts: [".txt"] })) {
  stats.lastFile = entry.path.split("/").pop() ?? entry.path;
  updateStatus(stats);

  const raw = await Deno.readTextFile(entry.path).catch(() => "");
  if (!raw) continue;

  const blocks = parseBlocks(cleanText(raw));
  if (!blocks.length) continue;

  db.execute("BEGIN");
  for (const block of blocks) {
    const efta =
      extractEftaId(block.sourceLine) ??
      extractEftaId(block.metadataFilename) ??
      extractEftaId(block.body);

    const docId = efta ?? `doc_${sha256Hex(`${block.sourceLine}|${entry.path}`)}`;
    const bodyClean = stripNoise(cleanText(block.body));
    const textSha = sha256Hex(bodyClean);

    if (stmtDup) {
      const dupRow = stmtDup.first([runId, textSha]);
      if (dupRow) {
        stats.dupSkipped += 1;
        continue;
      }
    }

    const meta = {
      doc_id: docId,
      type: guessType(bodyClean),
      source_txt_file: entry.path,
      record_source: block.sourceLine,
      metadata_source: block.metadataSource,
      metadata_filename: block.metadataFilename,
      text_sha256: textSha,
      chars: bodyClean.length,
      chunk_mode: "paragraph",
      chunk_target_size: chunkSize,
    };

    stmtDoc.execute([runId, docId, JSON.stringify(meta), textSha, bodyClean.length]);
    stats.docs += 1;
    docSinceCommit += 1;

    const parts = chunkParagraph(bodyClean, chunkSize);
    for (let i = 0; i < parts.length; i += 1) {
      const chunkId = `${docId}:${String(i).padStart(4, "0")}`;
      const uid = `${runId}:${chunkId}`;
      stmtChunk.execute([uid, runId, chunkId, i, docId, entry.path, parts[i]]);
      const rowid = db.lastInsertRowId;
      if (rowid) {
        stmtFts.execute([rowid, parts[i]]);
      }
      stats.chunks += 1;
    }
  }
  db.execute("COMMIT");

  if (docSinceCommit >= 200) {
    docSinceCommit = 0;
    db.execute("PRAGMA wal_checkpoint(PASSIVE)");
  }
}

finishStatus();
console.log(green("Indexing complete."));

db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
try {
  db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
} catch {
  console.warn(yellow("FTS optimize skipped."));
}
db.execute("PRAGMA optimize");
db.execute("ANALYZE");
db.execute("VACUUM");

const docsCount = db.queryEntries<{ count: number }>(
  "SELECT COUNT(*) as count FROM docs WHERE run_id = ?",
  [runId],
)[0]?.count ?? 0;
const chunksCount = db.queryEntries<{ count: number }>(
  "SELECT COUNT(*) as count FROM chunks WHERE run_id = ?",
  [runId],
)[0]?.count ?? 0;
const avgChunk = db.queryEntries<{ avg: number }>(
  "SELECT AVG(LENGTH(text)) as avg FROM chunks WHERE run_id = ?",
  [runId],
)[0]?.avg ?? 0;

const dbStat = await Deno.stat(dbPath);

console.log(bold("============================================================"));
console.log(`Documents:           ${docsCount.toLocaleString()}`);
console.log(`Chunks:              ${chunksCount.toLocaleString()}`);
console.log(`Duplicates skipped:  ${stats.dupSkipped.toLocaleString()}`);
console.log(`Avg chunk size:      ${Math.round(avgChunk)} chars`);
console.log(`Database size:       ${formatBytes(dbStat.size)}`);
console.log(`Database file:       ${dbPath}`);
console.log(bold("============================================================"));

db.close();

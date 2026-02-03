import { DB } from "https://deno.land/x/sqlite@v3.9.1/mod.ts";

function isSqliteHeader(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  const header = new TextDecoder().decode(data.subarray(0, 16));
  return header.startsWith("SQLite format 3");
}

function ensureSqliteFile(path: string): void {
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(path);
  } catch (e) {
    throw new Error(
      `DB introuvable: ${path} (${e}). La DB n'est pas committée: indique --db vers ton fichier local.`,
    );
  }
  if (!stat.isFile) {
    throw new Error(`DB invalide (pas un fichier): ${path}`);
  }
  const head = Deno.readFileSync(path).subarray(0, 16);
  if (!isSqliteHeader(head)) {
    throw new Error(
      `Fichier invalide: ${path} (entête SQLite manquante). Vérifie que tu ouvres bien le .sqlite et pas un .txt/.wal/.shm.`,
    );
  }
}

export function openDatabase(dbPath: string, runId: string): { db: DB; runId: string } {
  ensureSqliteFile(dbPath);
  const db = new DB(dbPath);
  db.execute("PRAGMA busy_timeout=5000");

  db.execute(`
    CREATE TABLE IF NOT EXISTS marks(
      run_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(run_id, doc_id)
    );
  `);
  db.execute("CREATE INDEX IF NOT EXISTS idx_marks_run ON marks(run_id, created_at)");

  return { db, runId };
}

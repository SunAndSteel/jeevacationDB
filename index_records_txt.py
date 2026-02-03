#!/usr/bin/env python3
# python index_records_txt.py --input ./epstein-justice-files-text/Datasets-9-12 --db records.sqlite --run content --dedupe 1

import sqlite3
import hashlib
import json
import os
import sys
import argparse
from pathlib import Path
import re


def clean_text(text: str) -> str:
    """Remove illegal surrogates and fix unicode issues"""
    return text.encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")


def sha256_hex(data: bytes) -> str:
    """Calculate SHA-256 hash and return as hex string"""
    return hashlib.sha256(data).hexdigest()


def ensure_schema(conn: sqlite3.Connection):
    """Create database schema (FTS external content)"""
    cur = conn.cursor()

    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS docs(
            run_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            meta_json TEXT,
            text_sha256 TEXT,
            text_chars INTEGER,
            PRIMARY KEY(run_id, doc_id)
        )
    """)

    # IMPORTANT: on remet text dans chunks (external content FTS ne duplique pas le texte)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chunks(
            id INTEGER PRIMARY KEY,
            uid TEXT NOT NULL UNIQUE,
            run_id TEXT NOT NULL,
            chunk_id TEXT NOT NULL,
            order_index INTEGER,
            doc_id TEXT,
            source_file TEXT,
            text TEXT
        )
    """)

    cur.execute("CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(run_id, doc_id, order_index)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_docs_hash ON docs(run_id, text_sha256)")
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_uid ON chunks(uid)")

    # FTS5 external content: le texte n'est pas stocké dans chunks_fts_content,
    # il référence chunks(text) via rowid=id
    cur.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            text,
            content='chunks',
            content_rowid='id',
            tokenize="unicode61"
        )
    """)

    conn.commit()
    cur.close()


def parse_blocks(file_text: str) -> list:
    """Parse file into record blocks"""
    pattern = re.compile(r"^--- SOURCE:\s*(.+?)\s*---\s*$", re.MULTILINE)
    matches = list(pattern.finditer(file_text))

    if not matches:
        return []

    blocks = []
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(file_text)
        header = match.group(1)

        chunk = file_text[start:end].strip()

        ms = re.search(r"METADATA_SOURCE:\s*(.+)", chunk)
        mf = re.search(r"METADATA_FILENAME:\s*(.+)", chunk)

        split_marker = "----------------------------------------"
        if split_marker in chunk:
            body = chunk.split(split_marker, 1)[1].strip()
        else:
            body = re.sub(r"^--- SOURCE:.*---\s*", "", chunk, flags=re.MULTILINE).strip()

        blocks.append({
            "source_line": header,
            "metadata_source": ms.group(1).strip() if ms else "",
            "metadata_filename": mf.group(1).strip() if mf else "",
            "body": body
        })

    return blocks


def extract_efta_id(s: str) -> str | None:
    """Extract EFTA ID from string"""
    match = re.search(r"\bEFTA\d{8}\b", s)
    return match.group(0) if match else None


def guess_type(body: str) -> str:
    """Guess if content is email-like or document-like"""
    head = body[:1500]
    looks_email = bool(
        re.search(r"(^|\n)\s*From:\s*", head, re.IGNORECASE)
        and re.search(r"(^|\n)\s*Subject:\s*", head, re.IGNORECASE)
    )
    return "email_like" if looks_email else "document_like"


def strip_noise(body: str) -> str:
    """Remove common OCR noise and boilerplate (UNCHANGED)"""
    t = body

    t = re.sub(r"--- PAGE \d+ ---", "\n", t)
    t = re.sub(r"^METADATA_(SOURCE|FILENAME):.*$", "", t, flags=re.MULTILINE | re.IGNORECASE)
    t = re.sub(r"^Couldn't load plugin\.\s*$", "", t, flags=re.MULTILINE | re.IGNORECASE)

    # OCR boilerplate
    t = re.sub(r"This communication contains information[\s\S]{0,900}?applicable law\.\s*", "", t, flags=re.IGNORECASE)
    t = re.sub(r"please note[\s\S]{0,1400}?copyright -all rights reserved\s*", "", t, flags=re.IGNORECASE)

    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    return t


def chunk_paragraph(text: str, target_size: int = 2000) -> list[str]:
    """Split text into larger chunks (~target_size chars each) (UNCHANGED)"""
    parts = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]

    chunks = []
    current = ""

    for p in parts:
        if current and len(current) + len(p) + 2 > target_size:
            chunks.append(current)
            current = p
        else:
            current = current + "\n\n" + p if current else p

    if current:
        chunks.append(current)

    return chunks if chunks else [text.strip()]


def supports_returning(conn: sqlite3.Connection) -> bool:
    """Detect whether SQLite likely supports RETURNING (>= 3.35)."""
    cur = conn.cursor()
    cur.execute("select sqlite_version()")
    v = cur.fetchone()[0]
    cur.close()

    try:
        major, minor, patch = (int(x) for x in v.split("."))
    except Exception:
        return False

    return (major, minor, patch) >= (3, 35, 0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Input directory")
    parser.add_argument("--db", default="records.sqlite", help="Database file")
    parser.add_argument("--run", default="content", help="Run ID")
    parser.add_argument("--dedupe", default="1", help="Enable deduplication (1 or 0)")
    parser.add_argument("--chunk-size", type=int, default=2000, help="Target chunk size in characters (default: 2000)")
    args = parser.parse_args()

    input_dir = Path(args.input)
    db_path = args.db
    run_id = args.run.strip()
    dedupe = args.dedupe == "1"
    chunk_size = args.chunk_size

    if not run_id:
        print("Error: --run must not be empty", file=sys.stderr)
        sys.exit(1)

    print(f'runId = "{run_id}" | dedupe={1 if dedupe else 0} | chunk_size={chunk_size}')

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    try:
        ensure_schema(conn)
        has_returning = supports_returning(conn)
        print(f"SQLite RETURNING support: {has_returning}")

        # Test parameter binding
        cur = conn.cursor()
        cur.execute("SELECT ? as x", (run_id,))
        bind_test = cur.fetchone()[0]
        cur.close()
        if bind_test != run_id:
            raise Exception(f"Param binding broken: got {bind_test} expected {run_id}")

        doc_count = 0
        chunk_count = 0
        dup_skipped = 0

        cur = conn.cursor()

        # Prepared statements (faster + fewer surprises)
        stmt_doc = """
            INSERT INTO docs(run_id, doc_id, meta_json, text_sha256, text_chars)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(run_id, doc_id) DO UPDATE SET
                meta_json=excluded.meta_json,
                text_sha256=excluded.text_sha256,
                text_chars=excluded.text_chars
        """

        stmt_chunk_insert_returning = """
            INSERT INTO chunks(uid, run_id, chunk_id, order_index, doc_id, source_file, text)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(uid) DO NOTHING
            RETURNING id
        """

        stmt_chunk_insert_no_returning = """
            INSERT OR IGNORE INTO chunks(uid, run_id, chunk_id, order_index, doc_id, source_file, text)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """

        # External content FTS: on insère dans l'index (rowid = chunks.id)
        stmt_fts = """
            INSERT OR IGNORE INTO chunks_fts(rowid, text)
            VALUES (?, ?)
        """

        # Process all .txt files
        txt_files = list(input_dir.rglob("*.txt"))
        print(f"Found {len(txt_files)} .txt files to process\n")

        for file_idx, txt_file in enumerate(txt_files, 1):
            if file_idx % 10 == 0:
                print(f"Processing file {file_idx}/{len(txt_files)}: {txt_file.name}")

            try:
                file_text = clean_text(txt_file.read_text(encoding="utf-8", errors="ignore"))
            except Exception as e:
                print(f"Error reading {txt_file}: {e}", file=sys.stderr)
                continue

            blocks = parse_blocks(file_text)
            if not blocks:
                continue

            for block in blocks:
                # Extract or generate doc_id
                efta = (
                    extract_efta_id(block["source_line"])
                    or extract_efta_id(block["metadata_filename"])
                    or extract_efta_id(block["body"])
                )

                if efta:
                    doc_id = efta
                else:
                    hash_input = f"{block['source_line']}|{txt_file}"
                    doc_id = f"doc_{sha256_hex(hash_input.encode('utf-8'))}"

                body_clean = strip_noise(clean_text(block["body"]))
                text_sha = sha256_hex(body_clean.encode("utf-8"))

                # Check duplicates (UNCHANGED logic)
                if dedupe:
                    cur.execute(
                        "SELECT doc_id FROM docs WHERE run_id = ? AND text_sha256 = ? LIMIT 1",
                        (run_id, text_sha),
                    )
                    if cur.fetchone():
                        dup_skipped += 1
                        continue

                meta = {
                    "doc_id": doc_id,
                    "type": guess_type(body_clean),
                    "source_txt_file": str(txt_file),
                    "record_source": block["source_line"],
                    "metadata_source": block["metadata_source"],
                    "metadata_filename": block["metadata_filename"],
                    "text_sha256": text_sha,
                    "chars": len(body_clean),
                    "chunk_mode": "paragraph",
                    "chunk_target_size": chunk_size,
                }

                # Insert/update docs
                cur.execute(stmt_doc, (run_id, doc_id, json.dumps(meta), text_sha, len(body_clean)))
                doc_count += 1

                # Chunks
                parts = chunk_paragraph(body_clean, target_size=chunk_size)
                for i, part in enumerate(parts):
                    chunk_id = f"chunk_{str(chunk_count).zfill(8)}"
                    uid = f"{run_id}:{chunk_id}"

                    chunk_row_id = None

                    if has_returning:
                        cur.execute(
                            stmt_chunk_insert_returning,
                            (uid, run_id, chunk_id, i, doc_id, str(txt_file), part),
                        )
                        row = cur.fetchone()
                        # Si conflit uid => DO NOTHING => RETURNING renvoie None
                        if row:
                            chunk_row_id = row[0]
                    else:
                        # Fallback: insert OR IGNORE, puis lastrowid si insertion
                        cur.execute(
                            stmt_chunk_insert_no_returning,
                            (uid, run_id, chunk_id, i, doc_id, str(txt_file), part),
                        )
                        # rowcount = 1 si insert, 0 si ignore
                        if cur.rowcount == 1:
                            chunk_row_id = cur.lastrowid

                    if chunk_row_id is not None:
                        cur.execute(stmt_fts, (chunk_row_id, part))

                    chunk_count += 1

                # Commit periodically
                if doc_count % 200 == 0:
                    conn.commit()
                    conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
                    print(f"docs: {doc_count} | chunks: {chunk_count} | dup_skipped: {dup_skipped}")

        conn.commit()
        cur.close()

        # Final checkpoint (reduce WAL)
        print("\nCheckpoint final du WAL...")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()

        # FTS optimize + PRAGMA optimize + ANALYZE + VACUUM
        # (VACUUM est le plus coûteux, mais c'est ce qui rend l'espace disque)
        print("Optimisation FTS et DB (optimize/analyze/vacuum)...")
        try:
            conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
        except Exception as e:
            # Certains builds peuvent refuser optimize selon config; pas bloquant
            print(f"FTS optimize skipped: {e}", file=sys.stderr)

        try:
            conn.execute("PRAGMA optimize")
        except Exception:
            pass

        try:
            conn.execute("ANALYZE")
        except Exception:
            pass

        conn.commit()

        # Important: VACUUM après checkpoint + commit
        try:
            conn.execute("VACUUM")
        except Exception as e:
            print(f"VACUUM failed: {e}", file=sys.stderr)

        conn.commit()

        # Final stats
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM docs WHERE run_id = ?", (run_id,))
        docs = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (run_id,))
        chunks = cur.fetchone()[0]

        # FTS entries: rows in chunks_fts
        cur.execute("SELECT COUNT(*) FROM chunks_fts")
        fts = cur.fetchone()[0]

        cur.execute("SELECT AVG(LENGTH(text)) FROM chunks WHERE run_id = ?", (run_id,))
        avg_chunk_size = cur.fetchone()[0] or 0

        cur.close()

        db_size_mb = os.path.getsize(db_path) / 1024 / 1024

        print(f"\n{'='*60}")
        print("✅ Done!")
        print(f"{'='*60}")
        print(f"Documents:           {docs:,}")
        print(f"Chunks:              {chunks:,}")
        print(f"FTS entries:         {fts:,}")
        print(f"Duplicates skipped:  {dup_skipped:,}")
        print(f"Avg chunk size:      {avg_chunk_size:.0f} chars")
        print(f"Database size:       {db_size_mb:.2f} MB")
        print(f"Database file:       {db_path}")
        print(f"{'='*60}")

    finally:
        conn.close()


if __name__ == "__main__":
    main()

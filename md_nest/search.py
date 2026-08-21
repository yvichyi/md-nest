#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""md_nest/search.py — Markdown 知识库索引与检索(零依赖)
"""
from __future__ import annotations
import os, re, sqlite3
from pathlib import Path
from typing import List, Optional

__version__ = "0.1.0"

class MarkdownNest:
    def __init__(self, root: str | Path, db_path: Optional[str | Path] = None):
        self.root = Path(root).expanduser().resolve()
        self.db_path = Path(db_path or self.root / ".mdnest" / "index.db")
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn: Optional[sqlite3.Connection] = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(str(self.db_path))
            self._conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path, title, content)")
        return self._conn

    def _index_file(self, path: Path) -> Optional[tuple]:
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except Exception: return None
        if not content.strip(): return None
        m = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
        title = m.group(1).strip() if m else path.stem
        return (str(path.relative_to(self.root)), title, content)

    def rebuild(self) -> int:
        self.conn.execute("DELETE FROM docs")
        count = 0
        for path in sorted(self.root.rglob("*.md")):
            if ".mdnest" in path.parts: continue
            entry = self._index_file(path)
            if entry:
                self.conn.execute("INSERT INTO docs (path, title, content) VALUES (?,?,?)", entry)
                count += 1
        self.conn.commit()
        return count

    def search(self, query: str, limit: int = 8) -> List[dict]:
        terms = [t for t in re.split(r"\s+", query.strip()) if t]
        if not terms: return []
        fts_query = " OR ".join(f'"{t}"' for t in terms)
        rows = []
        try:
            rows = self.conn.execute(
                "SELECT path, title, snippet(docs, 2, '[', ']', '…', 12) "
                "FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?",
                (fts_query, limit),
            ).fetchall()
        except sqlite3.OperationalError: pass
        if not rows:
            for term in terms:
                like_rows = self.conn.execute(
                    "SELECT path, title, substr(content, 1, 120) as snippet FROM docs "
                    "WHERE content LIKE ? LIMIT ?", (f"%{term}%", limit),
                ).fetchall()
                rows.extend(like_rows)
                if len(rows) >= limit: break
        return [{"path": r[0], "title": r[1], "snippet": r[2] or ""} for r in rows[:limit]]

    def list_docs(self, limit: int = 100) -> List[dict]:
        rows = self.conn.execute("SELECT path, title FROM docs ORDER BY title LIMIT ?", (limit,)).fetchall()
        return [{"path": r[0], "title": r[1]} for r in rows]

    def stats(self) -> dict:
        n = self.conn.execute("SELECT count(*) FROM docs").fetchone()[0]
        size = sum(r[0] for r in self.conn.execute("SELECT length(content) FROM docs").fetchall())
        return {"docs": n, "chars": size, "db": os.path.getsize(self.db_path)}

    def close(self):
        if self._conn: self._conn.close(); self._conn = None

def main():
    import sys
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__); sys.exit(0)
    if args[0] in ("-v", "--version"):
        print(f"md-nest {__version__}"); sys.exit(0)
    root = args[0]
    nest = MarkdownNest(root)
    cmd = args[1] if len(args) > 1 else "search"
    rest = args[2:]
    if cmd in ("search", "ask", "stats", "list"):
        if not nest.list_docs(limit=1):
            n = nest.rebuild()
            print(f"(自动索引 {n} 篇文档)", file=sys.stderr)
    if cmd == "rebuild":
        n = nest.rebuild()
        print(f"✓ 索引重建:{n} 篇文档")
    elif cmd == "list":
        for d in nest.list_docs(): print(f"  {d['path']}  ({d['title']})")
    elif cmd == "stats":
        s = nest.stats()
        print(f"📚 {s['docs']} 篇 / {s['chars']} 字 / db {s['db']}B")
    elif cmd == "ask":
        from .ask import main as ask_main
        ask_main(root, nest)
    else:
        query = " ".join([cmd] + rest)
        hits = nest.search(query)
        if not hits: print("无结果")
        for h in hits:
            print(f"\n📄 [{h['title']}]")
            print(f"    {h['path']}")
            if h["snippet"]: print(f"    …{h['snippet']}…")
    nest.close()

if __name__ == "__main__": main()

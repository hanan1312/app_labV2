#!/usr/bin/env python3
"""
Reusable schema-audit script for the local SQLite database.

Introspects every table (columns, types, defaults, PK/FK, indexes) plus row
counts, and renders the result as Markdown. Re-run any time the local schema
changes to refresh docs/current_sqlite_schema.md.

Usage:
    python scripts/dump_sqlite_schema.py [path/to/db] [--out path/to/output.md]

Defaults to database/app.db and prints to stdout.
"""
import argparse
import sqlite3
import sys
from pathlib import Path


def get_tables(cur):
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    return [row[0] for row in cur.fetchall()]


def render_table_section(cur, table):
    lines = [f"### `{table}`", ""]

    cur.execute(f"SELECT COUNT(*) FROM {table}")
    row_count = cur.fetchone()[0]
    lines.append(f"Rows: **{row_count}**")
    lines.append("")

    lines.append("| Column | Type | Not Null | Default | PK |")
    lines.append("|---|---|---|---|---|")
    cur.execute(f"PRAGMA table_info({table})")
    for cid, name, col_type, notnull, default, pk in cur.fetchall():
        lines.append(f"| {name} | {col_type} | {'yes' if notnull else ''} | {default if default is not None else ''} | {'yes' if pk else ''} |")
    lines.append("")

    cur.execute(f"PRAGMA foreign_key_list({table})")
    fks = cur.fetchall()
    if fks:
        lines.append("Foreign keys:")
        for fk in fks:
            # (id, seq, table, from, to, on_update, on_delete, match)
            lines.append(f"- `{fk[3]}` -> `{fk[2]}.{fk[4]}` (on_delete={fk[6]})")
        lines.append("")

    cur.execute(f"PRAGMA index_list({table})")
    indexes = cur.fetchall()
    if indexes:
        lines.append("Indexes:")
        for idx in indexes:
            idx_name = idx[1]
            is_unique = idx[2]
            cur.execute(f"PRAGMA index_info({idx_name})")
            cols = [c[2] for c in cur.fetchall()]
            lines.append(f"- `{idx_name}`{' (unique)' if is_unique else ''}: {', '.join(cols)}")
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db_path", nargs="?", default="database/app.db")
    parser.add_argument("--out", help="write Markdown to this file instead of stdout")
    args = parser.parse_args()

    db_path = Path(args.db_path)
    if not db_path.exists():
        print(f"error: database not found at {db_path}", file=sys.stderr)
        sys.exit(1)

    con = sqlite3.connect(str(db_path))
    cur = con.cursor()

    tables = get_tables(cur)
    out = [f"# SQLite Schema Audit — `{db_path}`", "", f"{len(tables)} tables.", ""]
    for table in tables:
        out.append(render_table_section(cur, table))

    markdown = "\n".join(out)
    if args.out:
        Path(args.out).write_text(markdown)
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(markdown)

    con.close()


if __name__ == "__main__":
    main()

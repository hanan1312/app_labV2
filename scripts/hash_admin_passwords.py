#!/usr/bin/env python3
"""
Migrates admins.json's master-admin passwords from plaintext to Werkzeug password hashes
(pbkdf2:sha256, matching how the User model already hashes regular users' passwords).
src/routes/user.py's login() checks these with check_password_hash() instead of a plaintext
`==` comparison.

Idempotent: any value that already looks like a Werkzeug hash (starts with a known hash
method prefix) is left untouched, so it's safe to re-run.

Usage:
    python scripts/hash_admin_passwords.py
"""
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

from werkzeug.security import generate_password_hash

ADMINS_JSON = Path(__file__).resolve().parent.parent / 'admins.json'
HASH_PREFIXES = ('pbkdf2:', 'scrypt:', 'argon2:')


def main():
    if not ADMINS_JSON.exists():
        print(f"{ADMINS_JSON} not found, nothing to migrate.")
        return

    with open(ADMINS_JSON) as f:
        admins = json.load(f)

    already_hashed = [u for u, p in admins.items() if str(p).startswith(HASH_PREFIXES)]
    to_hash = [u for u, p in admins.items() if not str(p).startswith(HASH_PREFIXES)]

    if not to_hash:
        print(f"All {len(already_hashed)} account(s) already hashed, nothing to do.")
        return

    backup_path = ADMINS_JSON.with_name(f"admins.json.bak-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}")
    shutil.copy(ADMINS_JSON, backup_path)
    print(f"Backed up {ADMINS_JSON} -> {backup_path}")

    for username in to_hash:
        admins[username] = generate_password_hash(admins[username])

    with open(ADMINS_JSON, 'w') as f:
        json.dump(admins, f, indent=2)

    print(f"Hashed {len(to_hash)} account(s): {', '.join(to_hash)}")
    if already_hashed:
        print(f"Already hashed, left unchanged: {', '.join(already_hashed)}")


if __name__ == '__main__':
    main()

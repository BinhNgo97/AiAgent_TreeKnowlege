"""
migrate_to_multiuser.py — Phase 2 data migration
=================================================
Chạy 1 lần để chuyển data hiện có (data/*.jsonl) vào cấu trúc per-user:
  data/users/default/containers.jsonl
  data/users/default/nodes.jsonl
  ...

Chạy:
  python migrate_to_multiuser.py

An toàn khi chạy nhiều lần — không ghi đè nếu đích đã tồn tại.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT     = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

DATA_DIR  = ROOT / "data"
# Dùng APP_USERNAME từ .env — đây là user_id cho toàn bộ data hiện có
TARGET_USER = os.environ.get("APP_USERNAME", "default").strip() or "default"
USER_DIR    = DATA_DIR / "users" / TARGET_USER

FILES = [
    "containers.jsonl",
    "nodes.jsonl",
    "edges.jsonl",
    "sources.jsonl",
    "deleted_ids.json",
]


def migrate():
    USER_DIR.mkdir(parents=True, exist_ok=True)
    migrated = []
    skipped  = []

    for fname in FILES:
        src = DATA_DIR / fname
        dst = USER_DIR / fname

        if not src.exists():
            print(f"  ─ {fname}: không tồn tại, bỏ qua")
            continue

        if dst.exists():
            print(f"  ✓ {fname}: đã migrate trước đó, giữ nguyên")
            skipped.append(fname)
            continue

        # Với .jsonl: thêm user_id vào mỗi record (containers)
        if fname == "containers.jsonl":
            lines_out = []
            for line in src.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                record.setdefault("user_id", "default")
                lines_out.append(json.dumps(record, ensure_ascii=False))
            dst.write_text("\n".join(lines_out) + "\n", encoding="utf-8")
            print(f"  ✓ {fname}: {len(lines_out)} records → {dst}")
        else:
            shutil.copy2(src, dst)
            print(f"  ✓ {fname}: copied → {dst}")

        migrated.append(fname)

    print()
    if migrated:
        print(f"Migration xong: {len(migrated)} file(s) chuyển thành công.")
        print("Data cũ vẫn còn trong data/ — xoá thủ công khi đã verify xong.")
    else:
        print("Không có file nào cần migrate.")


if __name__ == "__main__":
    print(f"=== Migrate data → {USER_DIR} (user: {TARGET_USER}) ===\n")
    migrate()

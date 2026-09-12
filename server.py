from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "workbench.sqlite3"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                route TEXT NOT NULL,
                note TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id)
            );
            """
        )
        count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        if count == 0:
            seed = [
                ("p-退婚药", "退婚当天，我押十箱救命药闯雪关", "定制卡点扩写", "第1—10集 · 待人工确认"),
                ("p-绑手车祸", "绑手砸车造车祸，转头我包下整条货运线", "定制卡点扩写", "一卡规划 · 已保存"),
                ("p-倒计时", "倒计时爱人", "海外原创", "第1—10集 · 待朱雀"),
            ]
            for project_id, name, route, note in seed:
                stamp = now_iso()
                conn.execute(
                    "INSERT INTO projects(id,name,route,note,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                    (project_id, name, route, note, stamp, stamp),
                )


def project_dict(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "name": row["name"], "route": row["route"], "note": row["note"], "updatedAt": row["updated_at"]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        # Keep the terminal readable; application events are stored in SQLite.
        return

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/api/health":
            self.send_json({"ok": True, "service": "剧本创作总控台", "storage": "sqlite"})
            return
        if path == "/api/projects":
            with db() as conn:
                rows = conn.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
            self.send_json({"projects": [project_dict(row) for row in rows]})
            return
        if path.startswith("/api/projects/") and path.endswith("/events"):
            project_id = path.split("/")[3]
            with db() as conn:
                rows = conn.execute(
                    "SELECT kind,message,created_at FROM activity_logs WHERE project_id=? ORDER BY id DESC LIMIT 50",
                    (project_id,),
                ).fetchall()
            self.send_json({"events": [dict(row) for row in rows]})
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path == "/api/projects":
            try:
                data = self.read_json()
                name = str(data.get("name", "")).strip()
                route = str(data.get("route", "完全原创 / 市场参考")).strip()
                if not name or len(name) > 120:
                    self.send_json({"error": "项目名称不能为空且不超过120字"}, 400)
                    return
                project_id = "p-" + uuid.uuid4().hex[:12]
                stamp = now_iso()
                note = "新项目 · 待立项"
                with db() as conn:
                    conn.execute(
                        "INSERT INTO projects(id,name,route,note,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                        (project_id, name, route, note, stamp, stamp),
                    )
                    conn.execute(
                        "INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)",
                        (project_id, "project", "创建项目：" + name, stamp),
                    )
                    row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
                self.send_json({"project": project_dict(row)}, 201)
            except (ValueError, json.JSONDecodeError) as exc:
                self.send_json({"error": f"请求格式错误：{exc}"}, 400)
            return
        if path.startswith("/api/projects/") and path.endswith("/events"):
            project_id = path.split("/")[3]
            data = self.read_json()
            kind = str(data.get("kind", "task"))[:30]
            message = str(data.get("message", "")).strip()
            if not message:
                self.send_json({"error": "事件内容不能为空"}, 400)
                return
            stamp = now_iso()
            with db() as conn:
                exists = conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone()
                if not exists:
                    self.send_json({"error": "项目不存在"}, 404)
                    return
                conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, kind, message, stamp))
                conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (stamp, project_id))
            self.send_json({"ok": True, "createdAt": stamp})
            return
        self.send_json({"error": "接口不存在"}, 404)


if __name__ == "__main__":
    init_db()
    server = ThreadingHTTPServer(("127.0.0.1", 8786), Handler)
    print("剧本创作总控台：http://127.0.0.1:8786")
    print(f"本地数据：{DB_PATH}")
    server.serve_forever()

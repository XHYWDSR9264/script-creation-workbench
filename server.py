from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "workbench.sqlite3"
ASSET_TYPES = ("synopsis", "characters", "world", "beat_matrix")
GATES = (("G0", "立项与参数"), ("G1", "方案与卡点"), ("G2", "第1—3集校准"), ("G3", "批次创作"), ("G4", "内容终审"), ("G5", "朱雀同版检测"), ("G6", "交付与归档"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def seed_workspace(conn: sqlite3.Connection, project_id: str, stamp: str, profile: dict | None = None) -> None:
    p = profile or {}
    conn.execute("""INSERT OR IGNORE INTO project_profiles
        (project_id,region,medium,genre,total_episodes,submission_start,submission_end,opening_template,current_stage,progress,status,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
        (project_id, p.get("region", "国内"), p.get("medium", "AI漫剧"), p.get("genre", "待设定"),
         int(p.get("totalEpisodes", 60)), int(p.get("submissionStart", 1)), int(p.get("submissionEnd", 10)),
         p.get("openingTemplate", "老王模板"), "G0 立项与参数", 10, "待立项", stamp))
    for index, (code, title) in enumerate(GATES):
        conn.execute("INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at) VALUES(?,?,?,?,?,?)",
                     (project_id, code, title, "current" if index == 0 else "pending", "等待参数确认" if index == 0 else "未开始", stamp))
    for asset_type in ASSET_TYPES:
        conn.execute("INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?)", (project_id, asset_type, "", stamp))


def init_db() -> None:
    with db() as conn:
        conn.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
        for row in conn.execute("SELECT id,updated_at FROM projects").fetchall():
            seed_workspace(conn, row["id"], row["updated_at"])


def project_summary(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "name": row["name"], "route": row["route"], "note": row["note"], "updatedAt": row["updated_at"]}


def get_detail(conn: sqlite3.Connection, project_id: str) -> dict | None:
    project = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if not project:
        return None
    profile = conn.execute("SELECT * FROM project_profiles WHERE project_id=?", (project_id,)).fetchone()
    assets = conn.execute("SELECT asset_type,content,version,updated_at FROM story_assets WHERE project_id=?", (project_id,)).fetchall()
    versions = conn.execute("SELECT id,label,range_start,range_end,sha256,source,status,created_at FROM draft_versions WHERE project_id=? ORDER BY created_at DESC", (project_id,)).fetchall()
    gates = conn.execute("SELECT gate_code,title,status,note,updated_at FROM gates WHERE project_id=? ORDER BY gate_code", (project_id,)).fetchall()
    events = conn.execute("SELECT kind,message,created_at FROM activity_logs WHERE project_id=? ORDER BY id DESC LIMIT 50", (project_id,)).fetchall()
    return {"project": project_summary(project), "profile": dict(profile) if profile else None,
            "assets": {r["asset_type"]: {"content": r["content"], "version": r["version"], "updatedAt": r["updated_at"]} for r in assets},
            "versions": [dict(r) for r in versions], "gates": [dict(r) for r in gates], "events": [dict(r) for r in events]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        return

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 5_000_000: raise ValueError("请求内容过大")
        return json.loads(self.rfile.read(length).decode("utf-8") if length else "{}")

    @staticmethod
    def parts(path: str) -> list[str]:
        return [unquote(x) for x in path.split("/") if x]

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/") or "/"; parts = self.parts(path)
        if path == "/api/health": self.send_json({"ok": True, "service": "剧本创作总控台", "storage": "sqlite", "version": "0.2.0"}); return
        if path == "/api/projects":
            with db() as conn: rows = conn.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
            self.send_json({"projects": [project_summary(r) for r in rows]}); return
        if len(parts) == 3 and parts[:2] == ["api", "projects"]:
            with db() as conn: detail = get_detail(conn, parts[2])
            self.send_json({"detail": detail} if detail else {"error": "项目不存在"}, 200 if detail else 404); return
        if len(parts) == 4 and parts[:2] == ["api", "versions"] and parts[3] == "content":
            with db() as conn: row = conn.execute("SELECT * FROM draft_versions WHERE id=?", (parts[2],)).fetchone()
            self.send_json({"version": dict(row)} if row else {"error": "版本不存在"}, 200 if row else 404); return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/"); parts = self.parts(path)
        try:
            if path == "/api/projects":
                data = self.read_json(); name = str(data.get("name", "")).strip(); route = str(data.get("route", "完全原创 / 市场参考")).strip()
                if not name or len(name) > 120: self.send_json({"error": "项目名称不能为空且不超过120字"}, 400); return
                project_id = "p-" + uuid.uuid4().hex[:12]; stamp = now_iso(); note = "新项目 · 待立项"
                with db() as conn:
                    conn.execute("INSERT INTO projects(id,name,route,note,created_at,updated_at) VALUES(?,?,?,?,?,?)", (project_id, name, route, note, stamp, stamp)); seed_workspace(conn, project_id, stamp, data)
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "project", "创建项目：" + name, stamp)); row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
                self.send_json({"project": project_summary(row)}, 201); return
            if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "events":
                data = self.read_json(); message = str(data.get("message", "")).strip(); kind = str(data.get("kind", "task"))[:30]
                if not message: self.send_json({"error": "事件内容不能为空"}, 400); return
                stamp = now_iso()
                with db() as conn:
                    if not conn.execute("SELECT 1 FROM projects WHERE id=?", (parts[2],)).fetchone(): self.send_json({"error": "项目不存在"}, 404); return
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (parts[2], kind, message, stamp)); conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (stamp, parts[2]))
                self.send_json({"ok": True, "createdAt": stamp}); return
            if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "versions":
                data = self.read_json(); content = str(data.get("content", "")); label = str(data.get("label", "")).strip(); start, end = int(data.get("rangeStart", 1)), int(data.get("rangeEnd", 3))
                if not label or not content.strip() or start < 1 or end < start: self.send_json({"error": "版本名称、正文和集数范围必须有效"}, 400); return
                version_id = "v-" + uuid.uuid4().hex[:12]; stamp = now_iso(); digest = hashlib.sha256(content.encode("utf-8")).hexdigest(); source = str(data.get("source", "人工编辑"))
                with db() as conn:
                    if not conn.execute("SELECT 1 FROM projects WHERE id=?", (parts[2],)).fetchone(): self.send_json({"error": "项目不存在"}, 404); return
                    conn.execute("INSERT INTO draft_versions(id,project_id,label,range_start,range_end,content,sha256,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (version_id, parts[2], label, start, end, content, digest, source, "已保存", stamp))
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (parts[2], "version", f"保存正文版本 {label}（第{start}—{end}集）", stamp)); conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (stamp, parts[2]))
                self.send_json({"version": {"id": version_id, "label": label, "range_start": start, "range_end": end, "sha256": digest, "source": source, "status": "已保存", "created_at": stamp}}, 201); return
        except (ValueError, json.JSONDecodeError) as exc: self.send_json({"error": f"请求格式错误：{exc}"}, 400); return
        self.send_json({"error": "接口不存在"}, 404)

    def do_PUT(self):
        path = urlparse(self.path).path.rstrip("/"); parts = self.parts(path)
        try:
            if len(parts) == 5 and parts[:2] == ["api", "projects"] and parts[3] == "assets" and parts[4] in ASSET_TYPES:
                data = self.read_json(); content = str(data.get("content", "")); stamp = now_iso()
                with db() as conn:
                    if not conn.execute("SELECT 1 FROM projects WHERE id=?", (parts[2],)).fetchone(): self.send_json({"error": "项目不存在"}, 404); return
                    conn.execute("""INSERT INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(project_id,asset_type) DO UPDATE SET content=excluded.content,version=story_assets.version+1,updated_at=excluded.updated_at""", (parts[2], parts[4], content, stamp))
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (parts[2], "asset", f"更新项目资料：{parts[4]}", stamp)); conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (stamp, parts[2])); row = conn.execute("SELECT content,version,updated_at FROM story_assets WHERE project_id=? AND asset_type=?", (parts[2], parts[4])).fetchone()
                self.send_json({"asset": dict(row)}); return
        except (ValueError, json.JSONDecodeError) as exc: self.send_json({"error": f"请求格式错误：{exc}"}, 400); return
        self.send_json({"error": "接口不存在"}, 404)


if __name__ == "__main__":
    init_db(); server = ThreadingHTTPServer(("127.0.0.1", 8786), Handler)
    print("剧本创作总控台：http://127.0.0.1:8786"); print(f"本地数据：{DB_PATH}"); server.serve_forever()

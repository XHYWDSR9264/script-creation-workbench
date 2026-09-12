from __future__ import annotations

import hashlib
import base64
import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "workbench.sqlite3"
STORAGE_ROOT = ROOT / "data" / "projects"
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
    sources = conn.execute("SELECT id,name,mime,byte_size,sha256,extraction_status,created_at FROM source_documents WHERE project_id=? ORDER BY created_at DESC", (project_id,)).fetchall()
    audits = conn.execute("SELECT id,version_id,score,status,summary,findings_json,sha256,created_at FROM audit_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20", (project_id,)).fetchall()
    detectors = conn.execute("SELECT id,version_id,human_score,suspected_score,ai_score,report_name,sha256,status,created_at FROM detector_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20", (project_id,)).fetchall()
    return {"project": project_summary(project), "profile": dict(profile) if profile else None,
            "assets": {r["asset_type"]: {"content": r["content"], "version": r["version"], "updatedAt": r["updated_at"]} for r in assets},
            "versions": [dict(r) for r in versions], "gates": [dict(r) for r in gates], "events": [dict(r) for r in events], "sources": [dict(r) for r in sources],
            "audits": [dict(r) for r in audits], "detectors": [dict(r) for r in detectors]}


def audit_text(content: str, start: int, end: int) -> dict:
    findings: list[dict] = []
    def add(level: str, code: str, message: str) -> None: findings.append({"level": level, "code": code, "message": message})
    episodes = [int(x) for x in re.findall(r"^\s*第\s*(\d+)\s*集\s*$", content, re.M)]
    missing = [x for x in range(start, end + 1) if x not in episodes]
    outside = sorted(set(x for x in episodes if x < start or x > end))
    if missing: add("error", "missing_episode", "缺少集标题：第" + "、".join(map(str, missing)) + "集")
    if outside: add("error", "range_leak", "正文混入提交范围外集数：第" + "、".join(map(str, outside)) + "集")
    if len(set(episodes)) != len(episodes): add("error", "duplicate_episode", "存在重复集标题")
    scenes = len(re.findall(r"^\s*\d+\s*[-－—]\s*\d+\s+", content, re.M))
    if not scenes: add("error", "scene_header", "未识别到规范场次标题")
    if re.search(r"&#x?[0-9a-f]+;", content, re.I): add("error", "html_entity", "正文含HTML实体乱码")
    if "\\n" in content: add("error", "literal_newline", "正文含字面量\\n")
    if re.search(r"【\s*黑幕\s*】", content): add("warning", "black_screen", "正文含【黑幕】字样，请确认交付格式是否允许")
    if re.search(r"（\s*(本次提交|检测范围)[^）]*）", content): add("warning", "delivery_marker", "正文含检测或提交范围说明")
    for left, right in (("（", "）"), ("【", "】"), ("《", "》")):
        if content.count(left) != content.count(right): add("error", "bracket_balance", f"{left}{right}数量不平衡：{content.count(left)}/{content.count(right)}")
    counts: dict[str, int] = {}
    for line in (x.strip() for x in content.splitlines()):
        if len(line) >= 8: counts[line] = counts.get(line, 0) + 1
    duplicates = [x for x, count in counts.items() if count >= 3]
    if duplicates: add("warning", "repeated_lines", f"发现{len(duplicates)}条重复三次以上的长句")
    if len(content.strip()) < 800: add("warning", "short_content", "正文过短，无法完成有效结构审计")
    errors = sum(1 for x in findings if x["level"] == "error"); warnings = len(findings) - errors; score = max(0, 100 - errors * 12 - warnings * 4)
    return {"score": score, "status": "通过" if score >= 90 and errors == 0 else "需修复", "summary": f"识别{len(episodes)}个集标题、{scenes}个场次；{errors}项错误、{warnings}项提醒。", "findings": findings}


def model_endpoint(base: str, wire: str) -> str:
    root = base.rstrip("/")
    if not re.match(r"^https?://", root, re.I): raise ValueError("Base URL必须以http://或https://开头")
    suffix = "/chat/completions" if wire == "chat" else "/responses"
    return root if root.endswith(suffix) else root + suffix


def call_model(config: dict, prompt: str) -> str:
    base_url = str(config.get("baseUrl", "")).strip(); api_key = str(config.get("apiKey", "")).strip(); model = str(config.get("model", "")).strip(); wire = "chat" if config.get("wireApi") == "chat" else "responses"
    if not base_url or not api_key or not model: raise ValueError("请先填写Base URL、API Key和模型名")
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0.7} if wire == "chat" else {"model": model, "input": prompt, "reasoning": {"effort": str(config.get("reasoning", "high"))}}
    req = Request(model_endpoint(base_url, wire), data=json.dumps(payload, ensure_ascii=False).encode(), method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key})
    try:
        raw = urlopen(req, timeout=180).read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        msg = exc.read().decode("utf-8", errors="replace")[:300]; raise ValueError(f"模型接口HTTP {exc.code}：{msg}") from exc
    except URLError as exc: raise ValueError(f"模型接口连接失败：{exc.reason}") from exc
    data = json.loads(raw)
    if wire == "chat": output = (((data.get("choices") or [{}])[0].get("message") or {}).get("content"))
    else:
        output = data.get("output_text")
        if not output:
            output = "\n".join(c.get("text", "") for item in data.get("output", []) for c in item.get("content", []) if c.get("type") == "output_text")
    if not output: raise ValueError("接口返回成功，但没有读取到文本内容")
    return str(output)


def model_prompt(data: dict, task_type: str, instruction: str) -> str:
    a = data.get("assets", {}); p = data.get("profile") or {}; sources = "、".join(f"{x['name']}（{x['extraction_status']}）" for x in data.get("sources", [])) or "无"
    source_text = "\n\n".join(f"【{x['name']}】\n{x['extracted_text']}" for x in data.get("sourceTexts", []) if x.get("extracted_text"))[:120000] or "无可用文本素材"
    return f"""你是短剧生产工作台的内容引擎。当前任务类型：{task_type}。
项目：{data['project']['name']}
路线：{data['project']['route']}
参数：{p.get('region','')} / {p.get('medium','')} / 总{p.get('total_episodes',60)}集 / 提交{p.get('submission_start',1)}-{p.get('submission_end',10)}集 / {p.get('opening_template','')}
题材：{p.get('genre','')}
素材清单：{sources}
可用素材正文：
{source_text}
现有梗概：{a.get('synopsis',{}).get('content','无')}
现有人物：{a.get('characters',{}).get('content','无')}
现有世界观：{a.get('world',{}).get('content','无')}
现有卡点：{a.get('beat_matrix',{}).get('content','无')}

用户指令：{instruction}

必须尊重提交范围，不得把范围外分集写进剧情梗概；生成完成不等于人工审校通过。"""


def export_text(data: dict, version: sqlite3.Row | None) -> str:
    a = data.get("assets", {}); p = data["project"]; profile = data.get("profile") or {}; value = lambda key: a.get(key, {}).get("content", "")
    return f"《{p['name']}》\n\n生产路线：{p['route']}\n地区：{profile.get('region','')}\n形式：{profile.get('medium','')}\n总集数：{profile.get('total_episodes','')}\n开头模板：{profile.get('opening_template','')}\n\n一、剧情梗概\n{value('synopsis')}\n\n二、人物小传\n{value('characters')}\n\n三、世界观设定\n{value('world')}\n\n四、卡点矩阵\n{value('beat_matrix')}\n\n五、剧本正文\n{version['content'] if version else '尚未选择正文版本'}\n\n正文SHA-256：{version['sha256'] if version else '无'}\n"


def extract_source_text(path: Path) -> tuple[str, str]:
    ext = path.suffix.lower()
    if ext in {".txt", ".md", ".markdown", ".json", ".csv", ".tsv"}:
        return path.read_text(encoding="utf-8", errors="replace"), "已提取"
    if ext == ".docx":
        try:
            from docx import Document
            doc = Document(path)
            text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
            for table in doc.tables:
                text += "\n" + "\n".join("\t".join(cell.text for cell in row.cells) for row in table.rows)
            return text.strip(), "已提取"
        except Exception:
            return "", "待解析"
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
            return "\n".join((p.extract_text() or "") for p in PdfReader(path).pages).strip(), "已提取"
        except Exception:
            return "", "待解析"
    return "", "待解析"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        return

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def send_download(self, body: bytes, content_type: str, filename: str) -> None:
        self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(filename)); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 15_000_000: raise ValueError("请求内容过大")
        return json.loads(self.rfile.read(length).decode("utf-8") if length else "{}")

    @staticmethod
    def parts(path: str) -> list[str]:
        return [unquote(x) for x in path.split("/") if x]

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/") or "/"; parts = self.parts(path)
        if path == "/api/health": self.send_json({"ok": True, "service": "剧本创作总控台", "storage": "sqlite", "version": "0.4.0"}); return
        if path == "/api/projects":
            with db() as conn: rows = conn.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
            self.send_json({"projects": [project_summary(r) for r in rows]}); return
        if len(parts) == 3 and parts[:2] == ["api", "projects"]:
            with db() as conn: detail = get_detail(conn, parts[2])
            self.send_json({"detail": detail} if detail else {"error": "项目不存在"}, 200 if detail else 404); return
        if len(parts) == 4 and parts[:2] == ["api", "versions"] and parts[3] == "content":
            with db() as conn: row = conn.execute("SELECT * FROM draft_versions WHERE id=?", (parts[2],)).fetchone()
            self.send_json({"version": dict(row)} if row else {"error": "版本不存在"}, 200 if row else 404); return
        if len(parts) == 4 and parts[:2] == ["api", "sources"] and parts[3] == "content":
            with db() as conn: row = conn.execute("SELECT id,name,mime,byte_size,sha256,extracted_text,extraction_status,created_at FROM source_documents WHERE id=?", (parts[2],)).fetchone()
            self.send_json({"source": dict(row)} if row else {"error": "素材不存在"}, 200 if row else 404); return
        if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "export":
            query = urlparse(self.path).query; params = dict(x.split("=", 1) if "=" in x else (x, "") for x in query.split("&") if x); version_id = unquote(params.get("versionId", "")); fmt = params.get("format", "txt")
            with db() as conn:
                detail = get_detail(conn, parts[2]); version = conn.execute("SELECT * FROM draft_versions WHERE id=? AND project_id=?", (version_id, parts[2])).fetchone() if version_id else conn.execute("SELECT * FROM draft_versions WHERE project_id=? ORDER BY created_at DESC LIMIT 1", (parts[2],)).fetchone()
            if not detail: self.send_json({"error": "项目不存在"}, 404); return
            safe = re.sub(r'[\\/:*?"<>|]', "_", detail["project"]["name"])
            if fmt == "json": self.send_download(json.dumps({"detail": detail, "selectedVersion": dict(version) if version else None}, ensure_ascii=False, indent=2).encode(), "application/json; charset=utf-8", safe + ".json"); return
            self.send_download(export_text(detail, version).encode(), "text/plain; charset=utf-8", safe + ".txt"); return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/"); parts = self.parts(path)
        try:
            if path == "/api/model/test":
                data = self.read_json()
                try: output = call_model(data, "仅回复“连接成功”，不要补充其他内容。")
                except ValueError as exc: self.send_json({"error": str(exc)}, 502); return
                self.send_json({"ok": True, "output": output}); return
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
            if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "audits":
                data = self.read_json(); project_id = parts[2]; version_id = str(data.get("versionId", ""))
                with db() as conn: version = conn.execute("SELECT * FROM draft_versions WHERE id=? AND project_id=?", (version_id, project_id)).fetchone()
                if not version: self.send_json({"error": "请选择当前项目的正文版本"}, 400); return
                report = audit_text(version["content"], version["range_start"], version["range_end"]); report_id = "a-" + uuid.uuid4().hex[:12]; stamp = now_iso()
                with db() as conn:
                    conn.execute("INSERT INTO audit_reports(id,project_id,version_id,score,status,summary,findings_json,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)", (report_id, project_id, version_id, report["score"], report["status"], report["summary"], json.dumps(report["findings"], ensure_ascii=False), version["sha256"], stamp))
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "audit", f"结构审计：{report['score']}分，{report['status']}", stamp))
                self.send_json({"report": {"id": report_id, "version_id": version_id, "sha256": version["sha256"], "created_at": stamp, **report}}, 201); return
            if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "detectors":
                data = self.read_json(); project_id = parts[2]; version_id = str(data.get("versionId", "")); human = float(data.get("humanScore", -1)); suspected = float(data.get("suspectedScore", 0)); ai = float(data.get("aiScore", 0)); name = str(data.get("reportName", "")).strip(); encoded = str(data.get("dataBase64", ""))
                if any(x < 0 or x > 100 for x in (human, suspected, ai)): self.send_json({"error": "检测指标必须在0—100之间"}, 400); return
                if not name or not encoded: self.send_json({"error": "必须上传朱雀报告截图"}, 400); return
                try: raw = base64.b64decode(encoded, validate=True)
                except Exception: self.send_json({"error": "报告截图编码无效"}, 400); return
                if len(raw) > 5 * 1024 * 1024: self.send_json({"error": "报告截图不能超过5MB"}, 413); return
                with db() as conn: version = conn.execute("SELECT * FROM draft_versions WHERE id=? AND project_id=?", (version_id, project_id)).fetchone()
                if not version: self.send_json({"error": "请选择当前项目的正文版本"}, 400); return
                report_id = "z-" + uuid.uuid4().hex[:12]; stamp = now_iso(); safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in name); folder = STORAGE_ROOT / project_id / "detectors" / report_id; folder.mkdir(parents=True, exist_ok=True); path = folder / safe_name; path.write_bytes(raw); object_key = str(path.relative_to(ROOT)).replace("\\", "/"); status = "通过" if human >= 85 else "未通过"
                with db() as conn:
                    conn.execute("INSERT INTO detector_reports(id,project_id,version_id,human_score,suspected_score,ai_score,report_object_key,report_name,sha256,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (report_id, project_id, version_id, human, suspected, ai, object_key, name, version["sha256"], status, stamp))
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "detector", f"朱雀报告：人工特征{human}%，{status}", stamp))
                self.send_json({"report": {"id": report_id, "version_id": version_id, "human_score": human, "suspected_score": suspected, "ai_score": ai, "report_name": name, "sha256": version["sha256"], "status": status, "created_at": stamp}}, 201); return
            if len(parts) == 5 and parts[:2] == ["api", "projects"] and parts[3:] == ["model", "run"]:
                data = self.read_json(); project_id = parts[2]; task_type = str(data.get("taskType", "reply")); instruction = str(data.get("instruction", "")).strip()
                if not instruction: self.send_json({"error": "任务内容不能为空"}, 400); return
                with db() as conn:
                    detail = get_detail(conn, project_id)
                    if detail: detail["sourceTexts"] = [dict(x) for x in conn.execute("SELECT name,extracted_text FROM source_documents WHERE project_id=? AND extraction_status=? ORDER BY created_at", (project_id, "已提取")).fetchall()]
                if not detail: self.send_json({"error": "项目不存在"}, 404); return
                try: output = call_model(data.get("config") or {}, model_prompt(detail, task_type, instruction))
                except ValueError as exc: self.send_json({"error": str(exc)}, 502); return
                stamp = now_iso()
                with db() as conn:
                    if task_type in ASSET_TYPES:
                        conn.execute("""INSERT INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(project_id,asset_type) DO UPDATE SET content=excluded.content,version=story_assets.version+1,updated_at=excluded.updated_at""", (project_id, task_type, output, stamp))
                    elif task_type == "draft":
                        vid = "v-" + uuid.uuid4().hex[:12]; digest = hashlib.sha256(output.encode()).hexdigest(); start = int(data.get("rangeStart", detail.get("profile", {}).get("submission_start", 1))); end = int(data.get("rangeEnd", detail.get("profile", {}).get("submission_end", 10)))
                        conn.execute("INSERT INTO draft_versions(id,project_id,label,range_start,range_end,content,sha256,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (vid, project_id, str(data.get("label", f"模型稿 {stamp[:16]}")), start, end, output, digest, "模型生成", "待人工审校", stamp))
                    message = f"模型任务完成：{task_type}" + (("\n" + output[:3500]) if task_type == "reply" else "")
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "model", message, stamp)); conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (stamp, project_id))
                self.send_json({"ok": True, "output": output, "taskType": task_type}); return
            if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "sources":
                data = self.read_json(); name = str(data.get("name", "")).strip(); mime = str(data.get("mime", "application/octet-stream"))[:120]; encoded = str(data.get("dataBase64", ""))
                if not name or len(name) > 180 or not encoded: self.send_json({"error": "文件名和文件内容不能为空"}, 400); return
                try: raw = base64.b64decode(encoded, validate=True)
                except Exception: self.send_json({"error": "文件编码无效"}, 400); return
                if len(raw) > 10 * 1024 * 1024: self.send_json({"error": "单个素材不能超过10MB"}, 413); return
                project_id = parts[2]; source_id = "s-" + uuid.uuid4().hex[:12]; stamp = now_iso(); safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)
                folder = STORAGE_ROOT / project_id / "sources" / source_id; folder.mkdir(parents=True, exist_ok=True); path = folder / safe_name; path.write_bytes(raw)
                digest = hashlib.sha256(raw).hexdigest(); extracted, status = extract_source_text(path); object_key = str(path.relative_to(ROOT)).replace("\\", "/")
                with db() as conn:
                    if not conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone(): self.send_json({"error": "项目不存在"}, 404); return
                    conn.execute("INSERT INTO source_documents(id,project_id,name,mime,object_key,byte_size,sha256,extracted_text,extraction_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (source_id, project_id, name, mime, object_key, len(raw), digest, extracted, status, stamp))
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "source", f"导入素材：{name}（{status}）", stamp)); conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (stamp, project_id))
                self.send_json({"source": {"id": source_id, "name": name, "mime": mime, "byte_size": len(raw), "sha256": digest, "extraction_status": status, "created_at": stamp}}, 201); return
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

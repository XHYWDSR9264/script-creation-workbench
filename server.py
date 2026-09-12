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
        (project_id,region,medium,genre,total_episodes,submission_start,submission_end,opening_template,current_stage,progress,status,updated_at,duration_min_seconds,duration_max_seconds,calibration_threshold,quality_threshold,zhuque_threshold,one_scene_each,zhuque_required)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (project_id, p.get("region", "国内"), p.get("medium", "AI漫剧"), p.get("genre", "待设定"),
         int(p.get("totalEpisodes", 60)), int(p.get("submissionStart", 1)), int(p.get("submissionEnd", 10)),
         p.get("openingTemplate", "老王模板"), "G0 立项与参数", 10, "待立项", stamp,
         int(p.get("durationMin", 120)), int(p.get("durationMax", 180)), int(p.get("calibrationThreshold", 85)),
         int(p.get("qualityThreshold", 90)), float(p.get("zhuqueThreshold", 85)), 0 if p.get("oneSceneEach") is False else 1,
         0 if p.get("zhuqueRequired") is False else 1))
    for index, (code, title) in enumerate(GATES):
        conn.execute("INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at) VALUES(?,?,?,?,?,?)",
                     (project_id, code, title, "current" if index == 0 else "pending", "等待参数确认" if index == 0 else "未开始", stamp))
    for asset_type in ASSET_TYPES:
        conn.execute("INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?)", (project_id, asset_type, "", stamp))


def init_db() -> None:
    with db() as conn:
        conn.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
        def ensure_column(table: str, column: str, definition: str) -> None:
            names = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            if column not in names: conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        for column, definition in (
            ("duration_min_seconds", "INTEGER NOT NULL DEFAULT 120"), ("duration_max_seconds", "INTEGER NOT NULL DEFAULT 180"),
            ("calibration_threshold", "INTEGER NOT NULL DEFAULT 85"), ("quality_threshold", "INTEGER NOT NULL DEFAULT 90"),
            ("zhuque_threshold", "REAL NOT NULL DEFAULT 85"), ("one_scene_each", "INTEGER NOT NULL DEFAULT 1"),
            ("zhuque_required", "INTEGER NOT NULL DEFAULT 1")):
            ensure_column("project_profiles", column, definition)
        for column, definition in (
            ("audit_type", "TEXT NOT NULL DEFAULT 'structural'"), ("dimensions_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("reverse_checks_json", "TEXT NOT NULL DEFAULT '{}'"), ("hard_errors_json", "TEXT NOT NULL DEFAULT '[]'"),
            ("core_floor_pass", "INTEGER NOT NULL DEFAULT 0")):
            ensure_column("audit_reports", column, definition)
        ensure_column("task_runs", "retry_of", "TEXT")
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
    audits = conn.execute("SELECT id,version_id,score,status,summary,findings_json,sha256,created_at,audit_type,dimensions_json,reverse_checks_json,hard_errors_json,core_floor_pass FROM audit_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20", (project_id,)).fetchall()
    detectors = conn.execute("SELECT id,version_id,human_score,suspected_score,ai_score,report_name,sha256,status,created_at FROM detector_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20", (project_id,)).fetchall()
    runs = conn.execute("SELECT id,task_type,instruction,status,stage,progress,output_preview,error,version_id,retry_of,created_at,updated_at FROM task_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 30", (project_id,)).fetchall()
    approvals = conn.execute("SELECT id,gate_code,decision,note,version_id,sha256,actor,created_at FROM approval_records WHERE project_id=? ORDER BY created_at DESC LIMIT 30", (project_id,)).fetchall()
    continuity = conn.execute("SELECT id,category,subject,state,first_episode,last_episode,source_version_id,status,notes,created_at,updated_at FROM continuity_entries WHERE project_id=? ORDER BY category,subject", (project_id,)).fetchall()
    latest_version_id = versions[0]["id"] if versions else None
    return {"project": project_summary(project), "profile": dict(profile) if profile else None,
            "assets": {r["asset_type"]: {"content": r["content"], "version": r["version"], "updatedAt": r["updated_at"]} for r in assets},
            "versions": [dict(r) for r in versions], "gates": [dict(r) for r in gates], "events": [dict(r) for r in events], "sources": [dict(r) for r in sources],
            "audits": [{**dict(r), "is_current": r["version_id"] == latest_version_id} for r in audits],
            "detectors": [{**dict(r), "is_current": r["version_id"] == latest_version_id} for r in detectors],
            "runs": [dict(r) for r in runs], "approvals": [dict(r) for r in approvals],
            "continuity": [{**dict(r), "is_current": not r["source_version_id"] or r["source_version_id"] == latest_version_id} for r in continuity],
            "latestVersionId": latest_version_id}


def parse_episode_number(token: str) -> int:
    if token.isdigit(): return int(token)
    nums = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    if token == "十": return 10
    if "百" in token:
        left, right = (token.split("百", 1) + [""])[:2]
        return nums.get(left, 1) * 100 + parse_episode_number(right or "0")
    if "十" in token:
        left, right = (token.split("十", 1) + [""])[:2]
        return (nums.get(left, 1) if left else 1) * 10 + (nums.get(right, 0) if right else 0)
    value = 0
    for char in token: value = value * 10 + nums.get(char, 0)
    return value


def audit_text(content: str, start: int, end: int) -> dict:
    findings: list[dict] = []
    def add(level: str, code: str, message: str) -> None: findings.append({"level": level, "code": code, "message": message})
    episodes = [parse_episode_number(x) for x in re.findall(r"^\s*第\s*([0-9一二三四五六七八九十百〇零两]+)\s*集\s*$", content, re.M)]
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


DIMENSIONS = {"premise": 15, "causality": 15, "characters": 20, "dialogue": 15,
              "pacing": 10, "emotion": 10, "performance": 10, "continuity": 5}


def parse_json_object(text: str) -> dict:
    clean = re.sub(r"^```(?:json)?\s*", "", str(text or "").strip(), flags=re.I)
    clean = re.sub(r"```\s*$", "", clean).strip()
    start, end = clean.find("{"), clean.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("深审模型未返回JSON对象")
    return json.loads(clean[start:end + 1])


def normalize_deep_audit(raw: dict, threshold: float) -> dict:
    dimensions, total = {}, 0.0
    for key, maximum in DIMENSIONS.items():
        source = (raw.get("dimensions") or {}).get(key) or {}
        try: score = float(source.get("score", 0))
        except (TypeError, ValueError): score = 0
        score = max(0, min(maximum, score)); total += score
        dimensions[key] = {"score": score, "max": maximum,
                           "evidence": list(source.get("evidence") or [])[:6],
                           "deduction": str(source.get("deduction") or "")}
    total = round(total, 1)
    hard_errors = list(raw.get("hard_errors") or [])[:50]
    reverse_source = raw.get("reverse_checks") if isinstance(raw.get("reverse_checks"), dict) else {}
    reverse_checks = {}
    for key in ("prop_chain", "permission_license", "adjacent_transition", "presence_speaker", "packaging_identity"):
        source = reverse_source.get(key) or {}; state = source.get("status") if source.get("status") in {"pass", "fail", "not_applicable"} else "fail"
        reverse_checks[key] = {"status": state, "evidence": list(source.get("evidence") or [])[:8],
                               "problem": str(source.get("problem") or ("模型漏交该反查表" if key not in reverse_source else ""))}
    core_floor = dimensions["causality"]["score"] >= 12 and dimensions["characters"]["score"] >= 16 and dimensions["dialogue"]["score"] >= 12
    reverse_pass = all(x["status"] in {"pass", "not_applicable"} for x in reverse_checks.values())
    status = "通过" if total >= threshold and core_floor and reverse_pass and not hard_errors else "需修复"
    findings = [{"level": "error", "code": str(x.get("type") or "hard_error"),
                 "message": f"{x.get('episode','')}{('/' + str(x.get('scene'))) if x.get('scene') else ''} {x.get('evidence') or x.get('problem') or '硬错误'}".strip()}
                for x in hard_errors if isinstance(x, dict)]
    findings.extend({"level": "error", "code": f"reverse_{key}", "message": value["problem"] or f"{key}反查未通过"}
                    for key, value in reverse_checks.items() if value["status"] == "fail")
    return {"score": total, "status": status,
            "summary": str(raw.get("summary") or f"AI内部八维深审{total}分；硬错误{len(hard_errors)}项。"),
            "findings": findings, "dimensions": dimensions, "reverseChecks": reverse_checks,
            "hardErrors": hard_errors, "coreFloorPass": core_floor}


def deep_audit_prompt(data: dict, version: sqlite3.Row) -> str:
    return f'''你是严格的中文短剧SOP内部审读员。只审读给定版本，不改稿，不因目标分倒填。必须输出单个JSON对象，不要Markdown。
项目：{data['project']['name']}
路线：{data['project']['route']}
总集数：{data.get('profile', {}).get('total_episodes', 60)}
本次正文：第{version['range_start']}—{version['range_end']}集
门槛：{data.get('profile', {}).get('quality_threshold', 90)}

按八维评分：premise满15；causality满15且底线12；characters满20且底线16；dialogue满15且底线12；pacing满10；emotion满10；performance满10；continuity满5。每维返回score、evidence数组（必须含集号/场次/短原文锚点）、deduction。
按五张反查表返回reverse_checks：prop_chain、permission_license、adjacent_transition、presence_speaker、packaging_identity；每项返回status(pass/fail/not_applicable)、evidence数组、problem。另查人物所知、时间空间、伤势、金额期限、重生/异能边界、反派利益、专业常识。
硬错误放hard_errors数组，每项含episode、scene、type、evidence、minimal_fix、affected_later。summary必须说明最大优点和首要缺陷。
JSON结构：{{"dimensions":{{"premise":{{"score":0,"evidence":[],"deduction":""}}}},"reverse_checks":{{}},"hard_errors":[],"summary":""}}

项目资料：
梗概：{data.get('assets', {}).get('synopsis', {}).get('content', '无')}
人物：{data.get('assets', {}).get('characters', {}).get('content', '无')}
世界观：{data.get('assets', {}).get('world', {}).get('content', '无')}
卡点：{data.get('assets', {}).get('beat_matrix', {}).get('content', '无')}

正文：
{version['content']}'''


def analyze_script(content: str) -> dict:
    episodes, characters, locations = [], {}, {}
    current_episode = current_scene = None
    for index, raw_line in enumerate(content.splitlines(), 1):
        line = raw_line.strip()
        ep = re.match(r"^第\s*([0-9一二三四五六七八九十百〇零两]+)\s*集$", line)
        if ep:
            current_episode = {"number": parse_episode_number(ep.group(1)), "line": index, "scenes": []}
            episodes.append(current_episode); current_scene = None; continue
        scene = re.match(r"^(\d+)\s*[-－—]\s*(\d+)\s+(.+)$", line)
        if scene:
            current_scene = {"episode": current_episode["number"] if current_episode else int(scene.group(1)),
                             "number": int(scene.group(2)), "heading": line, "line": index, "characters": []}
            if current_episode is None:
                current_episode = {"number": int(scene.group(1)), "line": index, "scenes": []}; episodes.append(current_episode)
            current_episode["scenes"].append(current_scene)
            bits = scene.group(3).split(); location = " ".join(bits[2:]) if len(bits) > 2 else scene.group(3)
            locations[location] = locations.get(location, 0) + 1; continue
        cast = re.match(r"^人物[：:]\s*(.+)$", line)
        if cast and current_scene:
            names = [x.strip() for x in re.split(r"[、，,/／]", cast.group(1)) if x.strip()]
            current_scene["characters"] = names
            for name in names: characters[name] = characters.get(name, 0) + 1
    return {"episodes": episodes, "episodeCount": len(episodes),
            "sceneCount": sum(len(x["scenes"]) for x in episodes),
            "characters": [{"name": k, "scenes": v} for k, v in sorted(characters.items(), key=lambda x: -x[1])],
            "locations": [{"name": k, "scenes": v} for k, v in sorted(locations.items(), key=lambda x: -x[1])]}


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
        if path == "/api/health": self.send_json({"ok": True, "service": "剧本创作总控台", "storage": "sqlite", "version": "0.6.0"}); return
        if path == "/api/projects":
            with db() as conn: rows = conn.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
            self.send_json({"projects": [project_summary(r) for r in rows]}); return
        if len(parts) == 3 and parts[:2] == ["api", "projects"]:
            with db() as conn: detail = get_detail(conn, parts[2])
            self.send_json({"detail": detail} if detail else {"error": "项目不存在"}, 200 if detail else 404); return
        if len(parts) == 4 and parts[:2] == ["api", "versions"] and parts[3] == "content":
            with db() as conn: row = conn.execute("SELECT * FROM draft_versions WHERE id=?", (parts[2],)).fetchone()
            self.send_json({"version": dict(row)} if row else {"error": "版本不存在"}, 200 if row else 404); return
        if len(parts) == 4 and parts[:2] == ["api", "versions"] and parts[3] == "analysis":
            with db() as conn: row = conn.execute("SELECT id,label,content,sha256 FROM draft_versions WHERE id=?", (parts[2],)).fetchone()
            self.send_json({"version": {"id": row["id"], "label": row["label"], "sha256": row["sha256"]}, "analysis": analyze_script(row["content"])} if row else {"error": "版本不存在"}, 200 if row else 404); return
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
                min_duration, max_duration = int(data.get("durationMin", 120)), int(data.get("durationMax", 180)); quality, zhuque = float(data.get("qualityThreshold", 90)), float(data.get("zhuqueThreshold", 85))
                if min_duration < 30 or max_duration < min_duration or max_duration > 600: self.send_json({"error": "单集时长范围无效"}, 400); return
                if not (0 <= quality <= 100 and 0 <= zhuque <= 100): self.send_json({"error": "质量和朱雀门槛必须在0—100之间"}, 400); return
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
                    conn.execute("INSERT INTO audit_reports(id,project_id,version_id,score,status,summary,findings_json,sha256,created_at,audit_type,dimensions_json,reverse_checks_json,hard_errors_json,core_floor_pass) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (report_id, project_id, version_id, report["score"], report["status"], report["summary"], json.dumps(report["findings"], ensure_ascii=False), version["sha256"], stamp, "structural", "{}", "{}", "[]", 1 if report["status"] == "通过" else 0))
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "audit", f"结构审计：{report['score']}分，{report['status']}", stamp))
                self.send_json({"report": {"id": report_id, "version_id": version_id, "sha256": version["sha256"], "created_at": stamp, **report}}, 201); return
            if len(parts) == 5 and parts[:2] == ["api", "projects"] and parts[3:] == ["audits", "deep"]:
                data = self.read_json(); project_id = parts[2]; version_id = str(data.get("versionId", ""))
                with db() as conn:
                    version = conn.execute("SELECT * FROM draft_versions WHERE id=? AND project_id=?", (version_id, project_id)).fetchone(); detail = get_detail(conn, project_id)
                if not version or not detail: self.send_json({"error": "请选择当前项目的正文版本"}, 400); return
                run_id = "r-" + uuid.uuid4().hex[:12]; stamp = now_iso()
                with db() as conn: conn.execute("INSERT INTO task_runs(id,project_id,task_type,instruction,status,stage,progress,version_id,retry_of,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (run_id, project_id, "deep_audit", f"深审版本 {version['label']}", "running", "八维评分与五表反查", 35, version_id, str(data.get("retryOf") or "") or None, stamp, stamp))
                try: output = call_model(data.get("config") or {}, deep_audit_prompt(detail, version))
                except ValueError as exc:
                    with db() as conn: conn.execute("UPDATE task_runs SET status=?,stage=?,progress=?,error=?,updated_at=? WHERE id=?", ("failed", "模型调用失败", 100, str(exc), now_iso(), run_id))
                    self.send_json({"error": str(exc), "runId": run_id}, 502); return
                try: report = normalize_deep_audit(parse_json_object(output), float((detail.get("profile") or {}).get("quality_threshold", 90)))
                except (ValueError, json.JSONDecodeError) as exc:
                    with db() as conn: conn.execute("UPDATE task_runs SET status=?,stage=?,progress=?,error=?,output_preview=?,updated_at=? WHERE id=?", ("failed", "结果解析失败", 100, str(exc), output[:3500], now_iso(), run_id))
                    self.send_json({"error": str(exc), "runId": run_id}, 422); return
                report_id = "a-" + uuid.uuid4().hex[:12]; done = now_iso()
                with db() as conn:
                    conn.execute("INSERT INTO audit_reports(id,project_id,version_id,score,status,summary,findings_json,sha256,created_at,audit_type,dimensions_json,reverse_checks_json,hard_errors_json,core_floor_pass) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (report_id, project_id, version_id, report["score"], report["status"], report["summary"], json.dumps(report["findings"], ensure_ascii=False), version["sha256"], done, "deep_ai", json.dumps(report["dimensions"], ensure_ascii=False), json.dumps(report["reverseChecks"], ensure_ascii=False), json.dumps(report["hardErrors"], ensure_ascii=False), 1 if report["coreFloorPass"] else 0))
                    conn.execute("UPDATE task_runs SET status=?,stage=?,progress=?,output_preview=?,updated_at=? WHERE id=?", ("succeeded", "等待人工确认", 100, report["summary"][:3500], done, run_id))
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "audit", f"AI内部深审：{report['score']}分，{report['status']}；硬错误{len(report['hardErrors'])}项", done))
                self.send_json({"report": {"id": report_id, "version_id": version_id, "sha256": version["sha256"], "created_at": done, "audit_type": "deep_ai", **report}, "runId": run_id}, 201); return
            if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "detectors":
                data = self.read_json(); project_id = parts[2]; version_id = str(data.get("versionId", "")); human = float(data.get("humanScore", -1)); suspected = float(data.get("suspectedScore", 0)); ai = float(data.get("aiScore", 0)); name = str(data.get("reportName", "")).strip(); encoded = str(data.get("dataBase64", ""))
                if any(x < 0 or x > 100 for x in (human, suspected, ai)): self.send_json({"error": "检测指标必须在0—100之间"}, 400); return
                if not name or not encoded: self.send_json({"error": "必须上传朱雀报告截图"}, 400); return
                try: raw = base64.b64decode(encoded, validate=True)
                except Exception: self.send_json({"error": "报告截图编码无效"}, 400); return
                if len(raw) > 5 * 1024 * 1024: self.send_json({"error": "报告截图不能超过5MB"}, 413); return
                if not (raw.startswith(b"\x89PNG\r\n\x1a\n") or raw.startswith(b"\xff\xd8\xff")): self.send_json({"error": "报告文件必须是真实PNG或JPEG图片"}, 400); return
                with db() as conn:
                    version = conn.execute("SELECT * FROM draft_versions WHERE id=? AND project_id=?", (version_id, project_id)).fetchone()
                    profile = conn.execute("SELECT zhuque_threshold FROM project_profiles WHERE project_id=?", (project_id,)).fetchone()
                if not version: self.send_json({"error": "请选择当前项目的正文版本"}, 400); return
                threshold = float(profile["zhuque_threshold"] if profile else 85)
                report_id = "z-" + uuid.uuid4().hex[:12]; stamp = now_iso(); safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in name); folder = STORAGE_ROOT / project_id / "detectors" / report_id; folder.mkdir(parents=True, exist_ok=True); path = folder / safe_name; path.write_bytes(raw); object_key = str(path.relative_to(ROOT)).replace("\\", "/"); status = "通过" if human >= threshold else "未通过"
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
                run_id = "r-" + uuid.uuid4().hex[:12]; started = now_iso()
                with db() as conn: conn.execute("INSERT INTO task_runs(id,project_id,task_type,instruction,status,stage,progress,retry_of,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (run_id, project_id, task_type, instruction, "running", "模型生成", 35, str(data.get("retryOf") or "") or None, started, started))
                try: output = call_model(data.get("config") or {}, model_prompt(detail, task_type, instruction))
                except ValueError as exc:
                    with db() as conn: conn.execute("UPDATE task_runs SET status=?,stage=?,progress=?,error=?,updated_at=? WHERE id=?", ("failed", "模型调用失败", 100, str(exc), now_iso(), run_id))
                    self.send_json({"error": str(exc), "runId": run_id}, 502); return
                stamp = now_iso()
                version_id = None
                with db() as conn:
                    if task_type in ASSET_TYPES:
                        conn.execute("""INSERT INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(project_id,asset_type) DO UPDATE SET content=excluded.content,version=story_assets.version+1,updated_at=excluded.updated_at""", (project_id, task_type, output, stamp))
                    elif task_type == "draft":
                        version_id = "v-" + uuid.uuid4().hex[:12]; digest = hashlib.sha256(output.encode()).hexdigest(); start = int(data.get("rangeStart", detail.get("profile", {}).get("submission_start", 1))); end = int(data.get("rangeEnd", detail.get("profile", {}).get("submission_end", 10)))
                        conn.execute("INSERT INTO draft_versions(id,project_id,label,range_start,range_end,content,sha256,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (version_id, project_id, str(data.get("label", f"模型稿 {stamp[:16]}")), start, end, output, digest, "模型生成", "待人工审校", stamp))
                    conn.execute("UPDATE task_runs SET status=?,stage=?,progress=?,output_preview=?,version_id=?,updated_at=? WHERE id=?", ("succeeded", "等待人工审校" if task_type == "draft" else "已保存", 100, output[:3500], version_id, stamp, run_id))
                    message = f"模型任务完成：{task_type}" + (("\n" + output[:3500]) if task_type == "reply" else "")
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "model", message, stamp)); conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (stamp, project_id))
                self.send_json({"ok": True, "output": output, "taskType": task_type, "runId": run_id, "versionId": version_id}); return
            if len(parts) == 5 and parts[:2] == ["api", "projects"] and parts[3] == "gates":
                data = self.read_json(); project_id, gate_code = parts[2], parts[4]; decision = str(data.get("decision", "")); note = str(data.get("note", "")).strip(); version_id = str(data.get("versionId", ""))
                if gate_code not in {x[0] for x in GATES} or decision not in {"approve", "reject"}: self.send_json({"error": "闸门或决定无效"}, 400); return
                with db() as conn:
                    detail = get_detail(conn, project_id); version = conn.execute("SELECT id,sha256 FROM draft_versions WHERE id=? AND project_id=?", (version_id, project_id)).fetchone() if version_id else None
                if not detail: self.send_json({"error": "项目不存在"}, 404); return
                if decision == "approve" and gate_code in {"G2", "G3", "G4", "G5", "G6"} and not version: self.send_json({"error": "该阶段批准必须绑定正文版本"}, 400); return
                if decision == "approve" and version and version["id"] != detail.get("latestVersionId"): self.send_json({"error": "只能批准当前最新正文版本"}, 409); return
                if decision == "approve" and gate_code == "G4":
                    ok = any(x["audit_type"] == "deep_ai" and x["version_id"] == version_id and x["status"] == "通过" and int(x["core_floor_pass"]) == 1 for x in detail["audits"])
                    if not ok: self.send_json({"error": "G4需要当前版本AI内部深审达到项目门槛、核心底线通过且硬错误为0"}, 409); return
                if decision == "approve" and gate_code == "G5" and int((detail.get("profile") or {}).get("zhuque_required", 1)) != 0:
                    threshold = float((detail.get("profile") or {}).get("zhuque_threshold", 85)); ok = any(x["version_id"] == version_id and x["status"] == "通过" and float(x["human_score"]) >= threshold for x in detail["detectors"])
                    if not ok: self.send_json({"error": f"G5需要当前版本朱雀人工特征达到{threshold:g}%并保存真实报告"}, 409); return
                if decision == "approve" and gate_code == "G6":
                    passed = {x["gate_code"] for x in detail["gates"] if x["status"] == "passed"}
                    if "G4" not in passed or (int((detail.get("profile") or {}).get("zhuque_required", 1)) != 0 and "G5" not in passed): self.send_json({"error": "G6需要先通过内容终审和适用的朱雀门禁"}, 409); return
                approval_id = "ap-" + uuid.uuid4().hex[:12]; stamp = now_iso(); status = "passed" if decision == "approve" else "blocked"; sha = version["sha256"] if version else ""
                with db() as conn:
                    conn.execute("INSERT INTO approval_records(id,project_id,gate_code,decision,note,version_id,sha256,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)", (approval_id, project_id, gate_code, decision, note, version_id or None, sha, "operator", stamp))
                    conn.execute("UPDATE gates SET status=?,note=?,updated_at=? WHERE project_id=? AND gate_code=?", (status, note or status, stamp, project_id, gate_code))
                    if decision == "approve":
                        idx = next(i for i, x in enumerate(GATES) if x[0] == gate_code)
                        if idx < len(GATES) - 1: conn.execute("UPDATE gates SET status=?,note=?,updated_at=? WHERE project_id=? AND gate_code=? AND status<>?", ("current", "等待处理", stamp, project_id, GATES[idx + 1][0], "passed"))
                        next_gate = GATES[min(idx + 1, len(GATES) - 1)]
                        conn.execute("UPDATE project_profiles SET current_stage=?,progress=?,status=?,updated_at=? WHERE project_id=?", (f"{next_gate[0]} {next_gate[1]}", 100 if gate_code == "G6" else round(((idx + 1) / 6) * 100), "已归档" if gate_code == "G6" else "等待人工处理", stamp, project_id))
                    else:
                        idx = next(i for i, x in enumerate(GATES) if x[0] == gate_code)
                        conn.execute("UPDATE project_profiles SET current_stage=?,status=?,updated_at=? WHERE project_id=?", (f"{gate_code} {GATES[idx][1]}", "已阻塞", stamp, project_id))
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "approval", f"{gate_code}{'批准' if decision == 'approve' else '驳回'}：{note or '无备注'}", stamp))
                self.send_json({"approval": {"id": approval_id, "gate_code": gate_code, "decision": decision, "note": note, "version_id": version_id or None, "sha256": sha, "created_at": stamp}}, 201); return
            if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "continuity":
                data = self.read_json(); project_id = parts[2]; category = str(data.get("category", "")).strip(); subject = str(data.get("subject", "")).strip(); state = str(data.get("state", "")).strip(); notes = str(data.get("notes", "")).strip()
                if category not in {"character", "prop", "timeline", "permission", "location"} or not subject: self.send_json({"error": "连续性类别或主体无效"}, 400); return
                try:
                    first = int(data["firstEpisode"]) if str(data.get("firstEpisode", "")).strip() else None; last = int(data["lastEpisode"]) if str(data.get("lastEpisode", "")).strip() else None
                except (TypeError, ValueError): self.send_json({"error": "集数必须是整数"}, 400); return
                if first is not None and last is not None and last < first: self.send_json({"error": "结束集不能早于起始集"}, 400); return
                entry_id = "c-" + uuid.uuid4().hex[:12]; stamp = now_iso()
                with db() as conn:
                    if not conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone(): self.send_json({"error": "项目不存在"}, 404); return
                    conn.execute("INSERT INTO continuity_entries(id,project_id,category,subject,state,first_episode,last_episode,source_version_id,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (entry_id, project_id, category, subject, state, first, last, None, "active", notes, stamp, stamp))
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "continuity", f"新增连续性条目：{subject}", stamp))
                self.send_json({"entry": {"id": entry_id, "category": category, "subject": subject, "state": state, "first_episode": first, "last_episode": last, "source_version_id": None, "status": "active", "notes": notes, "created_at": stamp, "updated_at": stamp}}, 201); return
            if len(parts) == 5 and parts[:2] == ["api", "projects"] and parts[3:] == ["continuity", "extract"]:
                data = self.read_json(); project_id = parts[2]; version_id = str(data.get("versionId", ""))
                with db() as conn: version = conn.execute("SELECT * FROM draft_versions WHERE id=? AND project_id=?", (version_id, project_id)).fetchone()
                if not version: self.send_json({"error": "请选择当前项目的正文版本"}, 400); return
                analysis = analyze_script(version["content"]); char_eps, location_eps = {}, {}
                for episode in analysis["episodes"]:
                    for scene in episode["scenes"]:
                        for name in scene["characters"]: char_eps.setdefault(name, set()).add(episode["number"])
                        location_match = re.match(r"^\d+\s*[-－—]\s*\d+\s+\S+\s+\S+\s+(.+)$", scene["heading"]); location = location_match.group(1) if location_match else scene["heading"]
                        location_eps.setdefault(location, set()).add(episode["number"])
                stamp = now_iso(); entries = []
                with db() as conn:
                    conn.execute("DELETE FROM continuity_entries WHERE project_id=? AND source_version_id=? AND category IN ('character','location')", (project_id, version_id))
                    for category, mapping in (("character", char_eps), ("location", location_eps)):
                        for subject, eps in mapping.items():
                            entry_id = "c-" + uuid.uuid4().hex[:12]; first, last = min(eps), max(eps); state = f"正文识别：出现于{len(eps)}集"
                            conn.execute("INSERT INTO continuity_entries(id,project_id,category,subject,state,first_episode,last_episode,source_version_id,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (entry_id, project_id, category, subject, state, first, last, version_id, "auto", "由场景标题与人物行自动提取，需人工补充状态变化", stamp, stamp)); entries.append(entry_id)
                    conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (project_id, "continuity", f"从{version['label']}提取连续性账本：{len(entries)}条", stamp))
                self.send_json({"ok": True, "count": len(entries), "versionId": version_id}, 201); return
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

    def do_DELETE(self):
        path = urlparse(self.path).path.rstrip("/"); parts = self.parts(path)
        if len(parts) == 3 and parts[:2] == ["api", "continuity"]:
            with db() as conn:
                row = conn.execute("SELECT project_id,subject FROM continuity_entries WHERE id=?", (parts[2],)).fetchone()
                if not row: self.send_json({"error": "连续性条目不存在"}, 404); return
                conn.execute("DELETE FROM continuity_entries WHERE id=?", (parts[2],)); conn.execute("INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)", (row["project_id"], "continuity", f"删除连续性条目：{row['subject']}", now_iso()))
            self.send_json({"ok": True}); return
        self.send_json({"error": "接口不存在"}, 404)


if __name__ == "__main__":
    init_db(); server = ThreadingHTTPServer(("127.0.0.1", 8786), Handler)
    print("剧本创作总控台：http://127.0.0.1:8786"); print(f"本地数据：{DB_PATH}"); server.serve_forever()

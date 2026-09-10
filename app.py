# -*- coding: utf-8 -*-
"""约束分组排演台 —— Flask 本地服务。

无第三方账号 / 在线 API，所有数据保存在本地 data/ 目录。
"""
import json
import os
import re
import time
import uuid

from flask import Flask, abort, jsonify, render_template, request

import solver

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
SAVES_DIR = os.path.join(DATA_DIR, "saves")
PRINTS_DIR = os.path.join(DATA_DIR, "prints")
for d in (SAVES_DIR, PRINTS_DIR):
    os.makedirs(d, exist_ok=True)


# ---------------------------------------------------------------- 工具

def _clamp(value, lo, hi, default):
    try:
        v = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def normalize_settings(raw, n_students):
    """清洗分组设置，保证求解器拿到合法数值。"""
    num_groups = _clamp(raw.get("numGroups"), 1, 26, 3)
    min_size = _clamp(raw.get("minSize"), 0, 99, 3)
    max_size = _clamp(raw.get("maxSize"), 1, 99, max(6, min_size))
    if max_size < min_size:
        max_size = min_size
    tags = []
    for t in raw.get("balanceTags", []) or []:
        t = str(t).strip()
        if t and t not in tags:
            tags.append(t)
    return {
        "numGroups": num_groups,
        "minSize": min_size,
        "maxSize": max_size,
        "balanceTags": tags[:12],
        "numSolutions": _clamp(raw.get("numSolutions"), 1, 6, 3),
    }


def normalize_students(raw):
    students = []
    seen = set()
    for s in raw or []:
        sid = str(s.get("id", "")).strip()
        name = str(s.get("name", "")).strip()
        if not sid or not name or sid in seen:
            continue
        seen.add(sid)
        tags = []
        for t in s.get("tags", []) or []:
            t = str(t).strip()
            if t and t not in tags:
                tags.append(t)
        students.append({"id": sid, "name": name, "tags": tags})
    return students


def normalize_relations(raw, valid_ids):
    relations = []
    for r in raw or []:
        a, b = str(r.get("a", "")), str(r.get("b", ""))
        rtype = r.get("type")
        if rtype in ("must", "cannot") and a in valid_ids and b in valid_ids and a != b:
            relations.append({"type": rtype, "a": a, "b": b})
    return relations


def _read_payload():
    data = request.get_json(force=True, silent=True) or {}
    students = normalize_students(data.get("students"))
    valid = {s["id"] for s in students}
    relations = normalize_relations(data.get("relations"), valid)
    settings = normalize_settings(data.get("settings") or {}, len(students))
    return students, relations, settings, data


def _safe_id(name):
    return re.sub(r"[^0-9A-Za-z_-]", "", name or "")


# ---------------------------------------------------------------- 页面

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/print/<pid>")
def print_page(pid):
    pid = _safe_id(pid)
    path = os.path.join(PRINTS_DIR, pid + ".json")
    if not pid or not os.path.isfile(path):
        abort(404)
    with open(path, "r", encoding="utf-8") as f:
        entry = json.load(f)
    names = {s["id"]: s["name"] for s in entry["students"]}
    # 匿名编号：按名单顺序编号（与排演台「编号」列一致），如 成员03
    labels = {s["id"]: "成员%02d" % (i + 1) for i, s in enumerate(entry["students"])}
    anon = request.args.get("anon") is not None
    return render_template("print.html", entry=entry, names=names,
                           labels=labels, anon=anon)


# ---------------------------------------------------------------- 求解 API

@app.post("/api/generate")
def api_generate():
    students, relations, settings, _ = _read_payload()
    if not students:
        return jsonify({"conflicts": [{
            "kind": "empty", "people": [], "chain": [],
            "message": "请先录入学员。",
        }], "solutions": []})
    conflicts, solutions = solver.generate_solutions(
        students, relations, settings, settings["numSolutions"])
    return jsonify({"conflicts": conflicts, "solutions": solutions,
                    "settings": settings})


@app.post("/api/resolve")
def api_resolve():
    """锁定成员/整组后的局部重排。"""
    students, relations, settings, data = _read_payload()
    groups = data.get("groups") or []
    locks = data.get("locks") or {}
    # 只保留合法学员 id
    valid = {s["id"] for s in students}
    groups = [[sid for sid in grp if sid in valid] for grp in groups]
    while len(groups) < settings["numGroups"]:
        groups.append([])
    groups = groups[:settings["numGroups"]]
    locks = {
        "members": [s for s in locks.get("members", []) if s in valid],
        "groups": [g for g in locks.get("groups", [])
                   if isinstance(g, int) and 0 <= g < len(groups)],
    }
    conflicts, solution = solver.resolve_partial(
        students, relations, settings, groups, locks)
    return jsonify({"conflicts": conflicts, "solution": solution})


# ---------------------------------------------------------------- 存档 API

def _save_path(sid):
    sid = _safe_id(sid)
    return os.path.join(SAVES_DIR, sid + ".json") if sid else None


@app.get("/api/saves")
def api_saves_list():
    items = []
    for fn in os.listdir(SAVES_DIR):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(SAVES_DIR, fn)
        try:
            with open(path, "r", encoding="utf-8") as f:
                entry = json.load(f)
            items.append({
                "id": entry.get("id"),
                "name": entry.get("name"),
                "createdAt": entry.get("createdAt"),
                "studentCount": len(entry.get("students", [])),
                "solutionCount": len(entry.get("solutions", [])),
            })
        except (OSError, ValueError):
            continue
    items.sort(key=lambda x: x.get("createdAt") or 0, reverse=True)
    return jsonify({"saves": items})


@app.post("/api/saves")
def api_saves_create():
    data = request.get_json(force=True, silent=True) or {}
    students = normalize_students(data.get("students"))
    valid = {s["id"] for s in students}
    sid = uuid.uuid4().hex[:12]
    entry = {
        "id": sid,
        "name": str(data.get("name") or "未命名方案").strip()[:60] or "未命名方案",
        "createdAt": int(time.time()),
        "students": students,
        "relations": normalize_relations(data.get("relations"), valid),
        "settings": normalize_settings(data.get("settings") or {}, len(students)),
        "solutions": data.get("solutions") or [],
        "working": data.get("working"),
        "locks": data.get("locks") or {"members": [], "groups": []},
    }
    with open(_save_path(sid), "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False, indent=1)
    return jsonify({"id": sid, "name": entry["name"]})


@app.get("/api/saves/<sid>")
def api_saves_get(sid):
    path = _save_path(sid)
    if not path or not os.path.isfile(path):
        abort(404)
    with open(path, "r", encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.delete("/api/saves/<sid>")
def api_saves_delete(sid):
    path = _save_path(sid)
    if path and os.path.isfile(path):
        os.remove(path)
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 打印页 API

@app.post("/api/prints")
def api_prints_create():
    data = request.get_json(force=True, silent=True) or {}
    students = normalize_students(data.get("students"))
    valid = {s["id"] for s in students}
    groups = [[sid for sid in grp if sid in valid] for grp in (data.get("groups") or [])]
    pid = uuid.uuid4().hex[:12]
    entry = {
        "id": pid,
        "title": str(data.get("title") or "分组结果").strip()[:60] or "分组结果",
        "createdAt": int(time.time()),
        "students": students,          # 顺序即匿名编号顺序
        "groups": groups,
    }
    with open(os.path.join(PRINTS_DIR, pid + ".json"), "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False, indent=1)
    return jsonify({"id": pid})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)

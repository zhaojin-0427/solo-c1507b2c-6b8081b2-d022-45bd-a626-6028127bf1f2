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
import rotation

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


def normalize_rotation(raw, n_students):
    """清洗多轮轮换设置：2～8 轮，每轮独立组数与人数范围。"""
    raw_rounds = raw.get("rounds") if isinstance(raw, dict) else None
    n_rounds = _clamp(len(raw_rounds) if isinstance(raw_rounds, list) else 0,
                      2, 8, 2)
    rounds = []
    for i in range(n_rounds):
        rr = raw_rounds[i] if isinstance(raw_rounds[i], dict) else {}
        ng = _clamp(rr.get("numGroups"), 1, 26, 3)
        mn = _clamp(rr.get("minSize"), 0, 99, 3)
        mx = _clamp(rr.get("maxSize"), 1, 99, max(6, mn))
        if mx < mn:
            mx = mn
        rounds.append({"numGroups": ng, "minSize": mn, "maxSize": mx})
    tags = []
    for t in (raw.get("balanceTags", []) if isinstance(raw, dict) else []) or []:
        t = str(t).strip()
        if t and t not in tags:
            tags.append(t)
    return {
        "rounds": rounds,
        "balanceTags": tags[:12],
        "cap": _clamp(raw.get("cap"), 1, n_rounds, n_rounds),
        "maxCoverage": bool(raw.get("maxCoverage", True)),
        "numPlans": _clamp(raw.get("numPlans"), 1, 6,
                           _clamp(raw.get("numSolutions"), 1, 6, 3)),
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


def normalize_relations(raw, valid_ids, n_rounds=1):
    """清洗关系。scope: "all"（全程生效）或 {"rounds": [0 基轮次…]}。"""
    relations = []
    seen = set()
    for r in raw or []:
        a, b = str(r.get("a", "")), str(r.get("b", ""))
        rtype = r.get("type")
        if rtype in ("must", "cannot") and a in valid_ids and b in valid_ids and a != b:
            key = (rtype, frozenset((a, b)))
            if key in seen:
                continue
            seen.add(key)
            scope = "all"
            raw_scope = r.get("scope", "all")
            if isinstance(raw_scope, dict):
                rounds = []
                for x in raw_scope.get("rounds", []) or []:
                    try:
                        x = int(x)
                    except (TypeError, ValueError):
                        continue
                    if 0 <= x < n_rounds and x not in rounds:
                        rounds.append(x)
                if rounds:
                    scope = {"rounds": sorted(rounds)}
                else:
                    scope = "all"
            relations.append({"type": rtype, "a": a, "b": b, "scope": scope})
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
    # 兼容旧格式（单轮、直接挂 groups）
    pages = entry.get("pages")
    if pages is None:
        pages = [{"title": entry.get("title", "分组结果"),
                  "groups": entry.get("groups", [])}]
        entry = dict(entry, pages=pages, mode="single")
    return render_template("print.html", entry=entry, pages=pages,
                           names=names, labels=labels, anon=anon)


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


# ---------------------------------------------------------------- 多轮轮换 API

@app.post("/api/rotation/generate")
def api_rotation_generate():
    data = request.get_json(force=True, silent=True) or {}
    students = normalize_students(data.get("students"))
    rot_raw = normalize_rotation(data.get("rotation") or {}, len(students))
    relations = normalize_relations(data.get("relations"),
                                    {s["id"] for s in students},
                                    len(rot_raw["rounds"]))
    if not students:
        return jsonify({"conflicts": [{
            "kind": "empty", "round": -1, "cross": False, "people": [], "chain": [],
            "message": "请先录入学员。",
        }], "plans": []})
    conflicts, plans = rotation.generate_rotation(
        students, relations, rot_raw, rot_raw["numPlans"])
    return jsonify({"conflicts": conflicts, "plans": plans, "rotation": rot_raw})


@app.post("/api/rotation/resolve")
def api_rotation_resolve():
    """从某轮起只重排后续轮次；之前的轮冻结，该轮的成员/整组锁保持。"""
    data = request.get_json(force=True, silent=True) or {}
    students = normalize_students(data.get("students"))
    valid = {s["id"] for s in students}
    rot_raw = normalize_rotation(data.get("rotation") or {}, len(students))
    relations = normalize_relations(data.get("relations"), valid,
                                    len(rot_raw["rounds"]))
    raw_rounds = data.get("currentRounds") or []
    current_rounds = []
    for ri, rr in enumerate(rot_raw["rounds"]):
        groups = raw_rounds[ri] if ri < len(raw_rounds) and isinstance(raw_rounds[ri], list) else []
        groups = [[sid for sid in grp if sid in valid] for grp in groups]
        while len(groups) < rr["numGroups"]:
            groups.append([])
        current_rounds.append(groups[:rr["numGroups"]])
    from_round = _clamp(data.get("fromRound"), 0, len(rot_raw["rounds"]) - 1, 0)
    locks_in = data.get("locks") or {}
    locks_by_round = {}
    for key, lk in locks_in.items():
        try:
            ri = int(key)
        except (TypeError, ValueError):
            continue
        if ri < from_round or ri >= len(rot_raw["rounds"]):
            continue
        if not isinstance(lk, dict):
            continue
        locks_by_round[ri] = {
            "members": [s for s in lk.get("members", []) if s in valid],
            "groups": [g for g in lk.get("groups", [])
                       if isinstance(g, int) and 0 <= g < len(current_rounds[ri])],
        }
    conflicts, payload = rotation.resolve_rotation(
        students, relations, rot_raw, current_rounds, from_round, locks_by_round)
    return jsonify({"conflicts": conflicts, "payload": payload})


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
                "mode": entry.get("mode", "single"),
                "roundCount": len((entry.get("rotation") or {}).get("rounds", [])),
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
    mode = "rotation" if data.get("mode") == "rotation" else "single"
    rot_raw = normalize_rotation(data.get("rotation") or {}, len(students)) \
        if mode == "rotation" else None
    n_rounds = len(rot_raw["rounds"]) if rot_raw else 1
    sid = uuid.uuid4().hex[:12]
    entry = {
        "id": sid,
        "name": str(data.get("name") or "未命名方案").strip()[:60] or "未命名方案",
        "createdAt": int(time.time()),
        "mode": mode,
        "students": students,
        "relations": normalize_relations(data.get("relations"), valid, n_rounds),
        "settings": normalize_settings(data.get("settings") or {}, len(students)),
        "solutions": data.get("solutions") or [],
        "working": data.get("working"),
        "locks": data.get("locks") or {"members": [], "groups": []},
    }
    if mode == "rotation":
        entry["rotation"] = rot_raw
        entry["plans"] = data.get("plans") or []
        entry["roundsWorking"] = data.get("roundsWorking")
        entry["roundLocks"] = data.get("roundLocks") or {}
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
    pid = uuid.uuid4().hex[:12]
    entry = {
        "id": pid,
        "title": str(data.get("title") or "分组结果").strip()[:60] or "分组结果",
        "createdAt": int(time.time()),
        "students": students,          # 顺序即匿名编号顺序
    }
    if data.get("mode") == "rotation":
        pages = []
        round_names = data.get("roundNames") or []
        for i, grps in enumerate(data.get("rounds") or []):
            groups = [[sid for sid in grp if sid in valid] for grp in grps]
            title = round_names[i] if i < len(round_names) and round_names[i] \
                else ("第 %d 轮" % (i + 1))
            pages.append({"title": title, "groups": groups})
        entry["mode"] = "rotation"
        entry["pages"] = pages
    else:
        groups = [[sid for sid in grp if sid in valid] for grp in (data.get("groups") or [])]
        entry["mode"] = "single"
        entry["pages"] = [{"title": entry["title"], "groups": groups}]
    with open(os.path.join(PRINTS_DIR, pid + ".json"), "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False, indent=1)
    return jsonify({"id": pid})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)

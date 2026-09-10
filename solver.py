# -*- coding: utf-8 -*-
"""约束分组求解器。

硬约束：必须同组 / 不可同组 / 每组人数范围 / 组数。
软约束：各组人数均衡、指定技能标签在各组间均衡分布。

流程：
1. detect_conflicts —— 在求解前定位硬约束冲突（含冲突链路、相关人员）。
2. generate_solutions —— 多种子模拟退火，生成若干可行方案并评估软约束。
3. resolve_partial —— 锁定部分成员/整组后，仅对未锁定成员重新编排。
"""
import math
import random
from collections import defaultdict, deque

HARD = 1000.0  # 硬约束罚分权重


# ---------------------------------------------------------------- 基础图结构

def build_blocks(students, relations):
    """按“必须同组”关系用并查集构建连通块。块是最小调度单元。"""
    parent = {s["id"]: s["id"] for s in students}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for r in relations:
        if r.get("type") == "must" and r.get("a") in parent and r.get("b") in parent:
            ra, rb = find(r["a"]), find(r["b"])
            if ra != rb:
                parent[rb] = ra

    blocks = defaultdict(list)
    for s in students:
        blocks[find(s["id"])].append(s["id"])
    return list(blocks.values())


def _must_path(a, b, relations):
    """在“必须同组”图中找 a 到 b 的一条路径（BFS），用于展示冲突链路。"""
    adj = defaultdict(list)
    for r in relations:
        if r.get("type") == "must":
            adj[r["a"]].append(r["b"])
            adj[r["b"]].append(r["a"])
    prev = {a: None}
    dq = deque([a])
    while dq:
        u = dq.popleft()
        if u == b:
            break
        for v in adj[u]:
            if v not in prev:
                prev[v] = u
                dq.append(v)
    if b not in prev:
        return None
    path, cur = [], b
    while cur is not None:
        path.append(cur)
        cur = prev[cur]
    return path[::-1]


def _find_clique(adj, limit):
    """Bron–Kerbosch（带枢轴）找团，找到大小 >= limit 即提前返回。"""
    best = []

    def bk(r, p, x):
        nonlocal best
        if len(best) >= limit:
            return
        if len(r) + len(p) <= len(best):
            return
        if not p and not x:
            if len(r) > len(best):
                best = list(r)
            return
        union = p | x
        u = max(union, key=lambda n: len(adj[n] & p)) if union else None
        candidates = p - (adj[u] if u is not None else set())
        for v in list(candidates):
            bk(r + [v], p & adj[v], x & adj[v])
            p = p - {v}
            x = x | {v}
            if len(best) >= limit:
                return

    bk([], set(adj.keys()), set())
    return best


# ---------------------------------------------------------------- 冲突检测

def detect_conflicts(students, relations, settings):
    """返回硬约束冲突列表，每项含 kind/message/people(相关人员)/chain(关系链)。"""
    conflicts = []
    names = {s["id"]: s["name"] for s in students}
    blocks = build_blocks(students, relations)
    block_of = {}
    for i, blk in enumerate(blocks):
        for sid in blk:
            block_of[sid] = i

    num_groups = settings["numGroups"]
    min_size = settings["minSize"]
    max_size = settings["maxSize"]

    # 1) “必须同组”链与“不可同组”互相矛盾
    seen = set()
    for r in relations:
        if r.get("type") != "cannot":
            continue
        a, b = r.get("a"), r.get("b")
        if a not in block_of or b not in block_of:
            continue
        if block_of[a] == block_of[b]:
            key = tuple(sorted((a, b)))
            if key in seen:
                continue
            seen.add(key)
            path = _must_path(a, b, relations) or [a, b]
            chain = [{"a": path[i], "b": path[i + 1], "type": "must"}
                     for i in range(len(path) - 1)]
            chain.append({"a": a, "b": b, "type": "cannot"})
            conflicts.append({
                "kind": "must_cannot",
                "people": path,
                "chain": chain,
                "message": "「%s」与「%s」被标记为不可同组，但“必须同组”关系链将两人绑在了一起。"
                           % (names.get(a, a), names.get(b, b)),
            })

    # 2) “必须同组”绑定块超过每组人数上限
    for blk in blocks:
        if len(blk) > max_size:
            conflicts.append({
                "kind": "block_too_large",
                "people": list(blk),
                "chain": [],
                "message": "%d 人因“必须同组”绑定在同一组（%s），超过每组人数上限 %d。"
                           % (len(blk), "、".join(names.get(s, s) for s in blk), max_size),
            })

    # 3) 总人数与组数 × 人数范围不匹配
    n = len(students)
    if num_groups < 1:
        conflicts.append({
            "kind": "bad_settings", "people": [], "chain": [],
            "message": "组数必须至少为 1。",
        })
    elif min_size > max_size:
        conflicts.append({
            "kind": "bad_settings", "people": [], "chain": [],
            "message": "每组人数下限(%d)不能大于上限(%d)。" % (min_size, max_size),
        })
    else:
        if n < num_groups * min_size:
            conflicts.append({
                "kind": "too_few", "people": [], "chain": [],
                "message": "共 %d 名学员，不足以填满 %d 组 × 每组至少 %d 人（需要 %d 人）。"
                           "请减少组数或降低人数下限。" % (n, num_groups, min_size, num_groups * min_size),
            })
        if n > num_groups * max_size:
            conflicts.append({
                "kind": "too_many", "people": [], "chain": [],
                "message": "共 %d 名学员，超出 %d 组 × 每组最多 %d 人的容量（%d 人）。"
                           "请增加组数或提高人数上限。" % (n, num_groups, max_size, num_groups * max_size),
            })

    # 4) “不可同组”团大于组数：两两不能同组的分组单元超过可用组数
    adj = {i: set() for i in range(len(blocks))}
    for r in relations:
        if r.get("type") == "cannot":
            a, b = block_of.get(r.get("a")), block_of.get(r.get("b"))
            if a is not None and b is not None and a != b:
                adj[a].add(b)
                adj[b].add(a)
    clique = _find_clique(adj, num_groups + 1)
    if len(clique) > num_groups:
        people = []
        chain = []
        reps = [blocks[bi][0] for bi in clique]
        for bi in clique:
            people.extend(blocks[bi])
        for i in range(len(reps)):
            for j in range(i + 1, len(reps)):
                chain.append({"a": reps[i], "b": reps[j], "type": "cannot"})
        conflicts.append({
            "kind": "cannot_clique",
            "people": people,
            "chain": chain,
            "message": "%d 个分组单元两两“不可同组”（涉及 %s），超过组数 %d，无法全部分开。"
                       % (len(clique), "、".join(names.get(s, s) for s in reps), num_groups),
        })

    return conflicts


# ---------------------------------------------------------------- 评分

def _tag_index(students):
    return {s["id"]: set(s.get("tags", [])) for s in students}


def _hard_penalty(assign, blocks, settings, block_cannot, locked_block_group, locked_groups):
    g = settings["numGroups"]
    sizes = [0] * g
    for bi, gi in enumerate(assign):
        sizes[gi] += len(blocks[bi])
    pen = 0.0
    for gi in range(g):
        if sizes[gi] < settings["minSize"]:
            pen += (settings["minSize"] - sizes[gi]) * HARD
        elif sizes[gi] > settings["maxSize"]:
            pen += (sizes[gi] - settings["maxSize"]) * HARD
    for bi, others in enumerate(block_cannot):
        for bj in others:
            if bj > bi and assign[bi] == assign[bj]:
                pen += HARD
    for bi, gi in locked_block_group.items():
        if assign[bi] != gi:
            pen += HARD
    for bi, gi in enumerate(assign):
        # 整组锁定：不属于该组的块不得进入
        if gi in locked_groups and locked_block_group.get(bi) != gi:
            pen += HARD
    return pen


def _soft_score(assign, blocks, settings, tags_of):
    g = settings["numGroups"]
    sizes = [0] * g
    for bi, gi in enumerate(assign):
        sizes[gi] += len(blocks[bi])
    total = sum(sizes) or 1
    ideal = total / g
    score = 0.0
    for s in sizes:
        score += (s - ideal) ** 2 * 2.0  # 人数均衡
    for tag in settings.get("balanceTags", []):
        counts = [0] * g
        for bi, gi in enumerate(assign):
            for sid in blocks[bi]:
                if tag in tags_of.get(sid, ()):
                    counts[gi] += 1
        mean = sum(counts) / g
        for c in counts:
            score += (c - mean) ** 2 * 5.0  # 标签均衡（权重更高）
    return score


# ---------------------------------------------------------------- 求解

def _prepare(students, relations):
    blocks = build_blocks(students, relations)
    block_of = {}
    for i, blk in enumerate(blocks):
        for sid in blk:
            block_of[sid] = i
    block_cannot = [set() for _ in range(len(blocks))]
    for r in relations:
        if r.get("type") == "cannot":
            a, b = block_of.get(r.get("a")), block_of.get(r.get("b"))
            if a is not None and b is not None and a != b:
                block_cannot[a].add(b)
                block_cannot[b].add(a)
    return blocks, block_of, block_cannot


def _solve_once(students, relations, settings, seed,
                locked_block_group=None, locked_groups=None, iters=6000):
    """单次模拟退火求解，返回 (assign, 总罚分, blocks)。"""
    locked_block_group = locked_block_group or {}
    locked_groups = locked_groups or set()
    rng = random.Random(seed)
    blocks, _, block_cannot = _prepare(students, relations)
    n_blocks = len(blocks)
    g = settings["numGroups"]
    tags_of = _tag_index(students)

    # 初始解：先放锁定块，再按“约束度 + 块大小”贪心放置
    order = sorted(range(n_blocks),
                   key=lambda bi: (-(len(block_cannot[bi]) * 10 + len(blocks[bi])), rng.random()))
    assign = [-1] * n_blocks
    sizes = [0] * g
    for bi, gi in locked_block_group.items():
        assign[bi] = gi
        sizes[gi] += len(blocks[bi])
    for bi in order:
        if assign[bi] != -1:
            continue
        best_g, best_cost = None, None
        for gi in range(g):
            if gi in locked_groups:
                continue
            cost = sizes[gi]  # 偏好较空的组
            overflow = sizes[gi] + len(blocks[bi]) - settings["maxSize"]
            if overflow > 0:
                cost += HARD * overflow
            for bj in block_cannot[bi]:
                if assign[bj] == gi:
                    cost += HARD
            if best_cost is None or cost < best_cost:
                best_cost, best_g = cost, gi
        if best_g is None:
            best_g = rng.randrange(g)
        assign[bi] = best_g
        sizes[best_g] += len(blocks[bi])

    def total(a):
        return (_hard_penalty(a, blocks, settings, block_cannot,
                              locked_block_group, locked_groups)
                + _soft_score(a, blocks, settings, tags_of))

    cur = total(assign)
    best_assign, best_val = list(assign), cur
    movable = [bi for bi in range(n_blocks) if bi not in locked_block_group]
    t0, t1 = 5.0, 0.05
    for it in range(iters):
        if not movable:
            break
        temp = t0 * (t1 / t0) ** (it / max(1, iters - 1))
        bi = rng.choice(movable)
        old_g = assign[bi]
        cand = [x for x in range(g) if x != old_g and x not in locked_groups]
        if not cand:
            continue
        new_g = rng.choice(cand)
        assign[bi] = new_g
        val = total(assign)
        delta = val - cur
        if delta <= 0 or rng.random() < math.exp(-delta / max(temp, 1e-9)):
            cur = val
            if val < best_val:
                best_val, best_assign = val, list(assign)
        else:
            assign[bi] = old_g
    return best_assign, best_val, blocks


def _assign_to_groups(assign, blocks, num_groups):
    groups = [[] for _ in range(num_groups)]
    for bi, gi in enumerate(assign):
        groups[gi].extend(blocks[bi])
    for g in groups:
        g.sort()
    return groups


# ---------------------------------------------------------------- 评估与报告

def evaluate_solution(groups, students, settings):
    """评估一个方案：返回未满足的软约束说明与对比指标。"""
    tags_of = _tag_index(students)
    g = len(groups)
    total = sum(len(x) for x in groups)
    ideal = total / g if g else 0
    soft = []

    # 人数均衡（理想值取整区间之外的视为未满足）
    lo, hi = math.floor(ideal), math.ceil(ideal)
    for gi, grp in enumerate(groups):
        if len(grp) < lo or len(grp) > hi:
            soft.append({
                "type": "size_balance",
                "group": gi,
                "message": "第 %d 组 %d 人，偏离均衡值 %.1f 人。" % (gi + 1, len(grp), ideal),
            })

    # 标签均衡
    tag_stats = {}
    for tag in settings.get("balanceTags", []):
        counts = [sum(1 for sid in grp if tag in tags_of.get(sid, ())) for grp in groups]
        tot = sum(counts)
        mean = tot / g if g else 0
        tlo, thi = math.floor(mean), math.ceil(mean)
        tag_stats[tag] = {
            "counts": counts,
            "total": tot,
            "covered": sum(1 for c in counts if c > 0),
        }
        for gi, c in enumerate(counts):
            if c < tlo or c > thi:
                soft.append({
                    "type": "tag_balance",
                    "group": gi,
                    "tag": tag,
                    "message": "第 %d 组标签「%s」为 %d 人，偏离均衡值 %.1f 人。"
                               % (gi + 1, tag, c, mean),
                })

    sizes = [len(x) for x in groups]
    metrics = {
        "sizes": sizes,
        "spread": (max(sizes) - min(sizes)) if sizes else 0,
        "tags": tag_stats,
        "softCount": len(soft),
    }
    return {"soft": soft, "metrics": metrics}


def _solution_dict(groups, students, settings, hard_ok):
    ev = evaluate_solution(groups, students, settings)
    return {
        "groups": groups,
        "hardOk": hard_ok,
        "soft": ev["soft"],
        "metrics": ev["metrics"],
    }


# ---------------------------------------------------------------- 对外接口

def generate_solutions(students, relations, settings, num_solutions=3):
    """生成多个可行方案。返回 (conflicts, solutions)。"""
    conflicts = detect_conflicts(students, relations, settings)
    if conflicts:
        return conflicts, []

    g = settings["numGroups"]
    results = []
    seen = set()
    seed = 20240
    attempts = num_solutions * 6
    for _ in range(attempts):
        seed += 1
        assign, val, blocks = _solve_once(students, relations, settings, seed)
        groups = _assign_to_groups(assign, blocks, g)
        sig = tuple(tuple(x) for x in groups)
        if sig in seen:
            continue
        seen.add(sig)
        hard_ok = _hard_penalty(assign, blocks, settings,
                                _prepare(students, relations)[2], {}, set()) == 0
        results.append((val, _solution_dict(groups, students, settings, hard_ok)))
        if len(results) >= num_solutions:
            break

    results.sort(key=lambda t: t[0])
    return [], [s for _, s in results]


def _check_lock_conflicts(students, relations, settings, groups, locks):
    """锁定状态自身导致的硬冲突（在求解前先报告）。"""
    conflicts = []
    names = {s["id"]: s["name"] for s in students}
    gid_of = {}
    for gi, grp in enumerate(groups):
        for sid in grp:
            gid_of[sid] = gi
    locked_members = set(locks.get("members", []))
    locked_groups = set(locks.get("groups", []))
    for gi in locked_groups:
        if 0 <= gi < len(groups):
            locked_members.update(groups[gi])

    # 锁定成员之间的“不可同组”
    for r in relations:
        if r.get("type") == "cannot":
            a, b = r.get("a"), r.get("b")
            if a in locked_members and b in locked_members \
                    and gid_of.get(a) is not None and gid_of.get(a) == gid_of.get(b):
                conflicts.append({
                    "kind": "lock_cannot",
                    "people": [a, b],
                    "chain": [{"a": a, "b": b, "type": "cannot"}],
                    "message": "「%s」与「%s」均被锁定在第 %d 组，但两人不可同组。"
                               % (names.get(a, a), names.get(b, b), gid_of[a] + 1),
                })
    # 锁定组人数越界
    for gi in sorted(locked_groups):
        if 0 <= gi < len(groups):
            size = len(groups[gi])
            if size < settings["minSize"] or size > settings["maxSize"]:
                conflicts.append({
                    "kind": "lock_size",
                    "people": list(groups[gi]),
                    "chain": [],
                    "message": "第 %d 组已整组锁定，人数 %d 不在范围 [%d, %d] 内。"
                               % (gi + 1, size, settings["minSize"], settings["maxSize"]),
                })
    return conflicts


def resolve_partial(students, relations, settings, groups, locks):
    """锁定成员/整组后，仅对未锁定成员局部重排。返回 (conflicts, solution)。"""
    conflicts = detect_conflicts(students, relations, settings)
    if conflicts:
        return conflicts, None
    conflicts = _check_lock_conflicts(students, relations, settings, groups, locks)
    if conflicts:
        return conflicts, None

    blocks, block_of, _ = _prepare(students, relations)
    gid_of = {}
    for gi, grp in enumerate(groups):
        for sid in grp:
            gid_of[sid] = gi

    locked_block_group = {}
    for sid in locks.get("members", []):
        if sid in block_of and sid in gid_of:
            locked_block_group[block_of[sid]] = gid_of[sid]
    locked_groups = set()
    for gi in locks.get("groups", []):
        if 0 <= gi < len(groups):
            locked_groups.add(gi)
            for sid in groups[gi]:
                if sid in block_of:
                    locked_block_group[block_of[sid]] = gi

    g = settings["numGroups"]
    best = None
    for seed in (777, 778, 779, 780, 781, 782):
        assign, val, blk = _solve_once(students, relations, settings, seed,
                                       locked_block_group, locked_groups)
        if best is None or val < best[0]:
            best = (val, assign, blk)
    val, assign, blk = best
    new_groups = _assign_to_groups(assign, blk, g)
    _, _, block_cannot = _prepare(students, relations)
    hard_ok = _hard_penalty(assign, blk, settings, block_cannot,
                            locked_block_group, locked_groups) == 0
    return [], _solution_dict(new_groups, students, settings, hard_ok)

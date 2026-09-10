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


class _BudgetExceeded(Exception):
    """精确搜索超出节点预算。"""


def _find_odd_cycle(adj):
    """在无向图中找一个奇环（二部图判定失败的证据）。返回节点列表或 None。"""
    color = {}
    parent = {}
    for s in adj:
        if s in color:
            continue
        color[s] = 0
        parent[s] = None
        dq = deque([s])
        while dq:
            u = dq.popleft()
            for v in adj[u]:
                if v not in color:
                    color[v] = 1 - color[u]
                    parent[v] = u
                    dq.append(v)
                elif color[v] == color[u]:
                    # u、v 同色 → 经最近公共祖先拼出奇环
                    anc = set()
                    x = u
                    while x is not None:
                        anc.add(x)
                        x = parent[x]
                    y = v
                    while y not in anc:
                        y = parent[y]
                    path_u, x = [], u
                    while x != y:
                        path_u.append(x)
                        x = parent[x]
                    path_u.append(y)
                    path_v, x = [], v
                    while x != y:
                        path_v.append(x)
                        x = parent[x]
                    return path_u + path_v[::-1]  # 长度为奇数，首尾由边 u-v 闭合
    return None


def _is_k_colorable(adj, k, max_nodes=100000):
    """DSATUR 回溯判定图是否可 k 着色。预算内无法判定时按可着色处理（不误报）。"""
    nodes = [0]
    colors = {}

    def dfs():
        nodes[0] += 1
        if nodes[0] > max_nodes:
            raise _BudgetExceeded()
        if len(colors) == len(adj):
            return True
        # 选饱和度最高（平局取度数最大）的未着色点
        best, best_key = None, None
        for v in adj:
            if v in colors:
                continue
            sat = len({colors[u] for u in adj[v] if u in colors})
            key = (sat, len(adj[v]))
            if best_key is None or key > best_key:
                best, best_key = v, key
        used = {colors[u] for u in adj[best] if u in colors}
        for c in range(k):
            if c in used:
                continue
            colors[best] = c
            if dfs():
                return True
            del colors[best]
        return False

    try:
        return dfs()
    except _BudgetExceeded:
        return True


def _minimize_uncolorable(adj, k):
    """贪心剔除顶点，得到一个（顶点意义下）极小的不可 k 着色子图，用于展示冲突核心。"""
    core = [v for v in adj if adj[v]]
    i = 0
    while i < len(core):
        cand = core[:i] + core[i + 1:]
        keep = set(cand)
        sub = {v: (adj[v] & keep) for v in cand}
        if not _is_k_colorable(sub, k):
            core = cand
        else:
            i += 1
    return core


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
    elif not _is_k_colorable(adj, num_groups):
        # 不可 k 着色：2 组时给出奇环链路，更多组时给出极小不可着色核心
        if num_groups == 2:
            cyc = _find_odd_cycle(adj)
            if cyc:
                reps = [blocks[bi][0] for bi in cyc]
                people = []
                for bi in cyc:
                    people.extend(blocks[bi])
                chain = [{"a": reps[i], "b": reps[(i + 1) % len(reps)], "type": "cannot"}
                         for i in range(len(reps))]
                conflicts.append({
                    "kind": "cannot_odd_cycle",
                    "people": people,
                    "chain": chain,
                    "message": "%d 个分组单元构成“不可同组”奇环（%s），只有 2 个组时"
                               "无法将环上成员全部错开，问题无解。"
                               % (len(cyc),
                                  " → ".join(names.get(r, r) for r in reps + reps[:1])),
                })
        if not any(c["kind"] == "cannot_odd_cycle" for c in conflicts):
            core = _minimize_uncolorable(adj, num_groups)
            core_set = set(core)
            people = []
            for bi in core:
                people.extend(blocks[bi])
            reps = {bi: blocks[bi][0] for bi in core}
            chain = [{"a": reps[bi], "b": reps[bj], "type": "cannot"}
                     for bi in core for bj in adj[bi] if bj in core_set and bj > bi]
            conflicts.append({
                "kind": "cannot_uncolorable",
                "people": people,
                "chain": chain,
                "message": "%d 个分组单元之间的“不可同组”关系无法嵌入 %d 个组"
                           "（涉及 %s），问题无解。"
                           % (len(core), num_groups,
                              "、".join(names.get(reps[bi], "") for bi in core[:8])),
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


def _exact_assignment(blocks, block_cannot, settings,
                      locked_block_group=None, locked_groups=None,
                      max_nodes=500000):
    """精确回溯：在“不可同组”与人数范围约束下求一个可行分配。

    返回 assign 列表；确认无解返回 None；超出搜索预算返回 "unknown"。
    """
    locked_block_group = locked_block_group or {}
    locked_groups = locked_groups or set()
    g = settings["numGroups"]
    min_s, max_s = settings["minSize"], settings["maxSize"]
    sizes = [len(b) for b in blocks]
    assign = [-1] * len(blocks)
    gsize = [0] * g

    # 预放锁定块，并校验锁定自身的一致性
    for bi, gi in locked_block_group.items():
        if gi < 0 or gi >= g:
            return None
        assign[bi] = gi
        gsize[gi] += sizes[bi]
    if any(gsize[gi] > max_s for gi in range(g)):
        return None
    locked_items = list(locked_block_group.items())
    for i in range(len(locked_items)):
        for j in range(i + 1, len(locked_items)):
            bi, gi = locked_items[i]
            bj, gj = locked_items[j]
            if gi == gj and bj in block_cannot[bi]:
                return None

    order = sorted((bi for bi in range(len(blocks)) if bi not in locked_block_group),
                   key=lambda b: (-len(block_cannot[b]), -sizes[b]))
    suffix = [0] * (len(order) + 1)
    for i in range(len(order) - 1, -1, -1):
        suffix[i] = suffix[i + 1] + sizes[order[i]]
    nodes = [0]

    def dfs(idx):
        nodes[0] += 1
        if nodes[0] > max_nodes:
            raise _BudgetExceeded()
        remaining = suffix[idx]
        # 容量 / 人数缺口剪枝
        cap, deficit = 0, 0
        for gi in range(g):
            if gi in locked_groups:
                if gsize[gi] < min_s:
                    return False  # 锁定组不能再进人，缺口无法弥补
            else:
                cap += max_s - gsize[gi]
                if gsize[gi] < min_s:
                    deficit += min_s - gsize[gi]
        if remaining > cap or deficit > remaining:
            return False
        if idx == len(order):
            return True
        bi = order[idx]
        sz = sizes[bi]
        tried_empty = False
        for gi in range(g):
            if gi in locked_groups or gsize[gi] + sz > max_s:
                continue
            if gsize[gi] == 0:
                if tried_empty:
                    continue  # 空组彼此对称，只试一个
                tried_empty = True
            if any(assign[bj] == gi for bj in block_cannot[bi] if assign[bj] != -1):
                continue
            assign[bi] = gi
            gsize[gi] += sz
            if dfs(idx + 1):
                return True
            assign[bi] = -1
            gsize[gi] -= sz
        return False

    try:
        return assign if dfs(0) else None
    except _BudgetExceeded:
        return "unknown"


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
    """生成多个可行方案。返回 (conflicts, solutions)。

    只返回满足全部硬约束的方案；确认无解时返回冲突说明，不输出不可行方案。
    """
    conflicts = detect_conflicts(students, relations, settings)
    if conflicts:
        return conflicts, []

    g = settings["numGroups"]
    blocks, _, block_cannot = _prepare(students, relations)
    results = []
    seen = set()
    seed = 20240
    for _ in range(num_solutions * 6):
        seed += 1
        assign, val, blk = _solve_once(students, relations, settings, seed)
        if _hard_penalty(assign, blk, settings, block_cannot, {}, set()) != 0:
            continue  # 丢弃不可行解
        groups = _assign_to_groups(assign, blk, g)
        sig = tuple(tuple(x) for x in groups)
        if sig in seen:
            continue
        seen.add(sig)
        results.append((val, _solution_dict(groups, students, settings, True)))
        if len(results) >= num_solutions:
            break
    if results:
        results.sort(key=lambda t: t[0])
        return [], [s for _, s in results]

    # 启发式未找到可行解 → 精确判定：确认无解，还是仅未搜到
    exact = _exact_assignment(blocks, block_cannot, settings)
    if exact == "unknown":
        return [{
            "kind": "solver_unknown", "people": [], "chain": [],
            "message": "约束组合过于复杂，未能在限定时间内判定是否存在可行方案，"
                       "请简化同组关系或调整分组设置后重试。",
        }], []
    if exact is not None:
        groups = _assign_to_groups(exact, blocks, g)
        return [], [_solution_dict(groups, students, settings, True)]

    # 精确搜索确认无解：汇总相关人员与“不可同组”链路
    people = {sid for blk in blocks if len(blk) > 1 for sid in blk}
    chain = []
    for r in relations:
        if r.get("type") == "cannot":
            people.add(r["a"])
            people.add(r["b"])
            chain.append({"a": r["a"], "b": r["b"], "type": "cannot"})
    return [{
        "kind": "no_feasible_assignment",
        "people": sorted(people),
        "chain": chain,
        "message": "在当前“必须同组”绑定、每组人数范围 [%d, %d] 与 %d 个组的组合下，"
                   "不存在满足全部硬约束的分组方案。"
                   % (settings["minSize"], settings["maxSize"], g),
    }], []


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

    # 1) 同一“必须同组”连通块被（成员锁 / 整组锁）锁定到多个不同的组
    blocks = build_blocks(students, relations)
    block_of = {}
    for i, blk in enumerate(blocks):
        for sid in blk:
            block_of[sid] = i
    block_lock_groups = defaultdict(set)   # 块 -> 被锁定的组集合
    for sid in locked_members:
        if sid in block_of and sid in gid_of:
            block_lock_groups[block_of[sid]].add(gid_of[sid])
    for bi, gset in block_lock_groups.items():
        if len(gset) <= 1:
            continue
        # 找两个被锁到不同组的成员，展示连接他们的“必须同组”链
        blk = blocks[bi]
        rep = {}
        for sid in blk:
            gi = gid_of.get(sid)
            if gi in gset and gi not in rep:
                rep[gi] = sid
        gs = sorted(rep)
        a, b = rep[gs[0]], rep[gs[1]]
        path = _must_path(a, b, relations) or [a, b]
        chain = [{"a": path[i], "b": path[i + 1], "type": "must"}
                 for i in range(len(path) - 1)]
        conflicts.append({
            "kind": "lock_must_split",
            "people": path,
            "chain": chain,
            "message": "「%s」被锁定在第 %d 组、「%s」被锁定在第 %d 组，但两人被"
                       "“必须同组”关系绑定，锁定状态互相矛盾，无法重排。"
                       % (names.get(a, a), gs[0] + 1, names.get(b, b), gs[1] + 1),
        })

    # 2) 锁定成员之间的“不可同组”
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
    # 3) 锁定组人数越界
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
    _, _, block_cannot = _prepare(students, relations)
    best = None
    for seed in (777, 778, 779, 780, 781, 782):
        assign, val, blk = _solve_once(students, relations, settings, seed,
                                       locked_block_group, locked_groups)
        if best is None or val < best[0]:
            best = (val, assign, blk)
    val, assign, blk = best
    if _hard_penalty(assign, blk, settings, block_cannot,
                     locked_block_group, locked_groups) != 0:
        # 启发式未满足全部硬约束 → 精确判定可行性
        exact = _exact_assignment(blk, block_cannot, settings,
                                  locked_block_group, locked_groups)
        if exact == "unknown":
            return [{
                "kind": "solver_unknown", "people": [], "chain": [],
                "message": "约束组合过于复杂，未能在限定时间内判定是否存在可行方案，"
                           "请放宽部分锁定或简化关系后重试。",
            }], None
        if exact is None:
            locked_people = sorted(set(locks.get("members", [])) | {
                sid for gi in locks.get("groups", [])
                if 0 <= gi < len(groups) for sid in groups[gi]})
            return [{
                "kind": "lock_infeasible",
                "people": locked_people,
                "chain": [],
                "message": "在当前锁定状态下不存在满足全部硬约束的分组方案，"
                           "请解除部分锁定后重试。",
            }], None
        assign = exact
    new_groups = _assign_to_groups(assign, blk, g)
    return [], _solution_dict(new_groups, students, settings, True)

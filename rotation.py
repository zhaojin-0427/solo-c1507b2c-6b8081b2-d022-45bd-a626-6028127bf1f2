# -*- coding: utf-8 -*-
"""多轮轮换求解器。

硬约束：
- 每轮各自的组数 / 每组人数范围；
- 「必须同组」「不可同组」关系，可全程生效或只作用于指定轮次；
- 跨轮：任意两人同组次数上限（cap）。

软目标（模拟退火优化）：
- 尽量让每人接触更多不同同伴（同伴覆盖率）；
- 技能标签在各轮各组保持均衡；
- 各组人数均衡。

对外接口：
1. detect_rotation_conflicts —— 求轮前静态冲突（容量、关系、锁定、跨轮强制重复）。
2. generate_rotation —— 多种子模拟退火，一次生成若干完整轮换方案。
3. resolve_rotation —— 锁定前若干轮（或某轮部分成员）后只重排后续轮次，
   并返回改动影响人数与重复搭档变化预览。
"""
import math
import random
from collections import defaultdict

import solver

HARD = solver.HARD
COVERAGE_W = 10.0     # 同伴覆盖软权重（每覆盖一对）
SIZE_W = 2.0
TAG_W = 5.0
CAP_W = 3000.0        # 跨轮同组次数上限罚分


# ---------------------------------------------------------------- 工具

def round_settings(rotation, idx):
    r = rotation["rounds"][idx]
    return {
        "numGroups": int(r["numGroups"]),
        "minSize": int(r["minSize"]),
        "maxSize": int(r["maxSize"]),
        "balanceTags": list(rotation.get("balanceTags", [])),
    }


def relations_for_round(relations, idx):
    """取在第 idx 轮（0 基）生效的关系。"""
    out = []
    for r in relations:
        scope = r.get("scope", "all")
        if scope == "all" or idx in scope.get("rounds", []):
            out.append(r)
    return out


def _tag_index(students):
    return {s["id"]: set(s.get("tags", [])) for s in students}


def pair_matrix(rounds_groups, student_ids):
    """同伴矩阵：matrix[i][j] = 两人在多少轮同组；对角线为 -1。"""
    pos = {sid: i for i, sid in enumerate(student_ids)}
    n = len(student_ids)
    m = [[0] * n for _ in range(n)]
    for i in range(n):
        m[i][i] = -1
    for groups in rounds_groups:
        for grp in groups:
            for x in range(len(grp)):
                for y in range(x + 1, len(grp)):
                    a, b = pos[grp[x]], pos[grp[y]]
                    m[a][b] += 1
                    m[b][a] += 1
    return m


def pair_counts(rounds_groups):
    """{(a,b) 有序键: 同组轮数}，只含同组过的对。"""
    counts = defaultdict(int)
    for groups in rounds_groups:
        for grp in groups:
            for x in range(len(grp)):
                for y in range(x + 1, len(grp)):
                    key = (grp[x], grp[y]) if grp[x] < grp[y] else (grp[y], grp[x])
                    counts[key] += 1
    return counts


def rotation_metrics(plans, students, rotation):
    """计算各方案的跨轮指标：同伴覆盖率、最高重复次数、每轮标签偏差。"""
    ids = [s["id"] for s in students]
    n = len(ids)
    tags_of = _tag_index(students)
    total_pairs = n * (n - 1) // 2
    tag_list = list(rotation.get("balanceTags", []))
    cap = int(rotation.get("cap", len(rotation["rounds"])))
    per_plan = []
    for groups_per_round in plans:
        counts = pair_counts(groups_per_round)
        covered_pairs = len(counts)
        max_repeat = max(counts.values()) if counts else 0
        cap_hits = sorted(
            ({"a": a, "b": b, "count": c} for (a, b), c in counts.items() if c > cap),
            key=lambda x: -x["count"])
        deg = {sid: 0 for sid in ids}
        for (a, b) in counts:
            deg[a] += 1
            deg[b] += 1
        coverage_each = {sid: (deg[sid] / (n - 1) if n > 1 else 1.0) for sid in ids}
        coverage = covered_pairs / total_pairs if total_pairs else 1.0

        tag_dev = []
        for ri, groups in enumerate(groups_per_round):
            g = len(groups)
            row = {"round": ri, "tags": {}}
            for tag in tag_list:
                tcounts = [sum(1 for sid in grp if tag in tags_of.get(sid, ()))
                           for grp in groups]
                mean = sum(tcounts) / g if g else 0.0
                dev = sum(abs(c - mean) for c in tcounts) / 2.0  # 单侧偏差总量
                row["tags"][tag] = {
                    "counts": tcounts, "mean": round(mean, 2),
                    "deviation": round(dev, 2),
                }
            tag_dev.append(row)

        per_plan.append({
            "coverage": round(coverage, 4),
            "coverageEach": {sid: round(v, 3) for sid, v in coverage_each.items()},
            "coveredPairs": covered_pairs,
            "totalPairs": total_pairs,
            "maxRepeat": max_repeat,
            "capHits": cap_hits,
            "tagDeviation": tag_dev,
        })
    return per_plan


# ---------------------------------------------------------------- 静态冲突

def detect_rotation_conflicts(students, relations, rotation,
                              frozen_groups=None, locked=None):
    """返回静态冲突列表（每项带 round / cross 字段）。

    frozen_groups: {round_idx: groups} 完全冻结的轮；
    locked:        {round_idx: {"groups": 当前编排, "locks": {"members": [...],
                                                              "groups": [...]}}}
    """
    conflicts = []
    names = {s["id"]: s["name"] for s in students}
    rounds = rotation["rounds"]
    R = len(rounds)
    cap = int(rotation.get("cap", R))
    frozen_groups = frozen_groups or {}
    locked = locked or {}

    # 1) 逐轮：关系/容量/图可着色 冲突（补上 round 字段）
    for ri in range(R):
        rs = relations_for_round(relations, ri)
        rset = round_settings(rotation, ri)
        for c in solver.detect_conflicts(students, rs, rset):
            c = dict(c)
            c["round"] = ri
            c.setdefault("cross", False)
            conflicts.append(c)

    # 2) 冻结轮的实际编排违规
    for ri, groups in frozen_groups.items():
        rset = round_settings(rotation, ri)
        rs = relations_for_round(relations, ri)
        gid_of = {sid: gi for gi, grp in enumerate(groups) for sid in grp}
        for gi, grp in enumerate(groups):
            if gi >= rset["numGroups"]:
                conflicts.append({
                    "kind": "frozen_extra_group", "round": ri, "cross": False,
                    "people": list(grp), "chain": [],
                    "message": "第 %d 轮已有编排有 %d 个组，超过该轮设置的 %d 个组。"
                               % (ri + 1, gi + 1, rset["numGroups"]),
                })
            elif len(grp) < rset["minSize"] or len(grp) > rset["maxSize"]:
                conflicts.append({
                    "kind": "frozen_size", "round": ri, "cross": False,
                    "people": list(grp), "chain": [],
                    "message": "第 %d 轮第 %d 组 %d 人，不在范围 [%d, %d] 内，"
                               "该轮已锁定不能重排。"
                               % (ri + 1, gi + 1, len(grp),
                                  rset["minSize"], rset["maxSize"]),
                })
        for r in rs:
            a, b = r.get("a"), r.get("b")
            ga, gb = gid_of.get(a), gid_of.get(b)
            if ga is None or gb is None:
                continue
            if r["type"] == "cannot" and ga == gb:
                conflicts.append({
                    "kind": "frozen_cannot", "round": ri, "cross": False,
                    "people": [a, b],
                    "chain": [{"a": a, "b": b, "type": "cannot"}],
                    "message": "第 %d 轮已锁定，但「%s」与「%s」在该轮同组，"
                               "违反“不可同组”。"
                               % (ri + 1, names.get(a, a), names.get(b, b)),
                })
            if r["type"] == "must" and ga != gb:
                conflicts.append({
                    "kind": "frozen_must", "round": ri, "cross": False,
                    "people": [a, b],
                    "chain": [{"a": a, "b": b, "type": "must"}],
                    "message": "第 %d 轮已锁定，但「%s」（第 %d 组）与「%s」"
                               "（第 %d 组）在该轮被要求必须同组。"
                               % (ri + 1, names.get(a, a), ga + 1,
                                  names.get(b, b), gb + 1),
                })

    # 3) 部分锁定轮：锁定状态自身矛盾（复用单轮检测）
    for ri, info in locked.items():
        if ri in frozen_groups or ri >= R:
            continue
        rset = round_settings(rotation, ri)
        rs = relations_for_round(relations, ri)
        for c in solver._check_lock_conflicts(
                students, rs, rset, info["groups"], info.get("locks", {})):
            c = dict(c)
            c["round"] = ri
            c["cross"] = False
            conflicts.append(c)

    # 4) 跨轮静态冲突：每轮都被“必须同组”绑定的两人，被迫重复次数 > cap
    for ri in range(R):
        rs = relations_for_round(relations, ri)
        block_per_round.append([set(b) for b in solver.build_blocks(students, rs)])

    ids = [s["id"] for s in students]
    forced = []
    for ai in range(len(ids)):
        for bi in range(ai + 1, len(ids)):
            a, b = ids[ai], ids[bi]
            together = 0
            chain_round = None
            for ri, blist in enumerate(block_per_round):
                if any(a in blk and b in blk for blk in blist):
                    together += 1
                    if chain_round is None:
                        chain_round = ri
            if together > cap:
                chain = []
                path = solver._must_path(a, b, relations_for_round(relations, chain_round))
                if path:
                    chain = [{"a": path[i], "b": path[i + 1], "type": "must"}
                             for i in range(len(path) - 1)]
                forced.append({"a": a, "b": b, "count": together, "chain": chain})
    if forced:
        forced.sort(key=lambda x: -x["count"])
        shown = forced[:8]
        people, chain = [], []
        for f in shown:
            people.extend([f["a"], f["b"]])
            chain.extend(f["chain"])
        detail = "；".join("「%s–%s」被迫同组 %d 轮"
                          % (names.get(f["a"], f["a"]),
                             names.get(f["b"], f["b"]), f["count"])
                          for f in shown)
        conflicts.append({
            "kind": "rotation_cap_forced", "round": -1, "cross": True,
            "people": sorted(set(people)), "chain": chain,
            "message": "跨轮限制要求任意两人同组不超过 %d 轮，但“必须同组”关系使：%s%s。"
                       "请放宽跨轮上限或调整必须同组关系的生效轮次。"
                       % (cap, detail, " 等" if len(forced) > len(shown) else ""),
        })
    return conflicts


# ---------------------------------------------------------------- 退火状态

class _RoundState:
    """一轮的可变状态：块 -> 组 的分配。"""

    def __init__(self, blocks, g):
        self.blocks = blocks
        self.g = g
        self.assign = [-1] * len(blocks)
        self.sizes = [0] * g
        self.members = [set() for _ in range(g)]  # group -> member ids

    def place(self, bi, gi):
        old = self.assign[bi]
        if old >= 0:
            self.sizes[old] -= len(self.blocks[bi])
            self.members[old] -= set(self.blocks[bi])
        self.assign[bi] = gi
        if gi >= 0:
            self.sizes[gi] += len(self.blocks[bi])
            self.members[gi].update(self.blocks[bi])

    def to_groups(self):
        out = [[] for _ in range(self.g)]
        for bi, gi in enumerate(self.assign):
            out[gi].extend(self.blocks[bi])
        for grp in out:
            grp.sort()
        return out


def _initial_round(students, rels, settings, seed,
                   locked_block_group, locked_groups, base_groups):
    """构造一轮初始分配：锁定块强制落位，其余尽量沿用 base_groups，贪心补齐。"""
    locked_block_group = locked_block_group or {}
    locked_groups = locked_groups or set()
    blocks, _, block_cannot = solver._prepare(students, rels)
    st = _RoundState(blocks, settings["numGroups"])
    rng = random.Random(seed)

    gid_of_base = {}
    if base_groups:
        for gi, grp in enumerate(base_groups):
            if gi < st.g:
                for sid in grp:
                    gid_of_base[sid] = gi
    for bi, blk in enumerate(blocks):
        if bi in locked_block_group:
            st.place(bi, locked_block_group[bi])
            continue
        gids = {gid_of_base.get(sid) for sid in blk}
        gids.discard(None)
        if len(gids) == 1:
            gi = next(iter(gids))
            if gi not in locked_groups:
                st.place(bi, gi)

    order = sorted(
        [bi for bi in range(len(blocks)) if st.assign[bi] == -1],
        key=lambda bi: (-(len(block_cannot[bi]) * 10 + len(blocks[bi])), rng.random()))
    for bi in order:
        best_g, best_cost = None, None
        for gi in range(st.g):
            if gi in locked_groups:
                continue
            cost = st.sizes[gi]
            over = st.sizes[gi] + len(blocks[bi]) - settings["maxSize"]
            if over > 0:
                cost += HARD * over
            for bj in block_cannot[bi]:
                if st.assign[bj] == gi:
                    cost += HARD
            if best_cost is None or cost < best_cost:
                best_cost, best_g = cost, gi
        if best_g is None:
            best_g = rng.randrange(st.g)
        st.place(bi, best_g)
    return st, blocks, block_cannot


def _round_energy_from_members(members, rset, tag_total, tags_of, n_students):
    size = len(members)
    e = 0.0
    if size < rset["minSize"]:
        e += (rset["minSize"] - size) * HARD
    elif size > rset["maxSize"]:
        e += (size - rset["maxSize"]) * HARD
    ideal = n_students / rset["numGroups"]
    e += (size - ideal) ** 2 * SIZE_W
    for tag, total in tag_total.items():
        c = sum(1 for sid in members if tag in tags_of.get(sid, ()))
        mean = total / rset["numGroups"]
        e += (c - mean) ** 2 * TAG_W
    return e


def _cross_delta(st, bi, old_gi, new_gi, paircnt, cap, cov_w):
    """块 bi 从 old_gi 移到 new_gi 的跨轮能量增量（调用时状态尚未改变）。"""
    if old_gi == new_gi:
        return 0.0
    members = st.blocks[bi]
    delta = 0.0
    if old_gi >= 0:
        for sid in members:
            for other in st.members[old_gi]:
                if other == sid or other in members:
                    continue
                key = (sid, other) if sid < other else (other, sid)
                c = paircnt[key]
                delta += (max(0, c - 1 - cap) ** 2 - max(0, c - cap) ** 2) * CAP_W
                if c == 1:
                    delta -= cov_w  # 该对不再同组，失去覆盖
    if new_gi >= 0:
        for sid in members:
            for other in st.members[new_gi]:
                if other == sid or other in members:
                    continue
                key = (sid, other) if sid < other else (other, sid)
                c = paircnt[key]
                delta += (max(0, c + 1 - cap) ** 2 - max(0, c - cap) ** 2) * CAP_W
                if c == 0:
                    delta += cov_w  # 新覆盖一对
    return delta


def _apply_cross(st, bi, old_gi, new_gi, paircnt):
    """接受移动后更新跨轮计数（在 st.place 之前调用）。"""
    members = st.blocks[bi]
    if old_gi >= 0:
        for sid in members:
            for other in st.members[old_gi]:
                if other == sid or other in members:
                    continue
                key = (sid, other) if sid < other else (other, sid)
                paircnt[key] -= 1
    if new_gi >= 0:
        for sid in members:
            for other in st.members[new_gi]:
                if other == sid or other in members:
                    continue
                key = (sid, other) if sid < other else (other, sid)
                paircnt[key] += 1


def _snapshot(states):
    return [None if st is None else list(st.assign) for st in states]


def _restore(states, snap):
    for st, ass in zip(states, snap):
        if st is not None:
            for bi, gi in enumerate(ass):
                st.place(bi, gi)


def _cannot_penalty(st, block_cannot):
    pen = 0.0
    for bi, others in enumerate(block_cannot):
        for bj in others:
            if bj > bi and st.assign[bj] == st.assign[bi]:
                pen += HARD
    return pen


def run_rotation(students, relations, rotation, seed,
                 frozen=None, locks_by_round=None, start_groups=None, iters=None):
    """单次模拟退火。返回 (energy, rounds_groups)。

    frozen:         set(round_idx)，这些轮完全沿用 start_groups，不参与移动；
    locks_by_round: {ri: {"members": set, "groups": set}}；
    start_groups:   {ri: groups}，初始编排（热起点，同时提供锁定位置）。
    """
    rng = random.Random(seed)
    tags_of = _tag_index(students)
    n_students = len(students)
    rounds = rotation["rounds"]
    R = len(rounds)
    cap = int(rotation.get("cap", R))
    cov_w = COVERAGE_W if rotation.get("maxCoverage", True) else 0.0
    frozen = frozen or set()
    locks_by_round = locks_by_round or {}
    start_groups = start_groups or {}

    states = []          # None 表示冻结轮
    immovable = []
    block_cannots = []
    tag_totals = {}
    energy = 0.0
    paircnt = defaultdict(int)

    for ri in range(R):
        rset = round_settings(rotation, ri)
        tag_totals[ri] = {
            tag: sum(1 for s in students if tag in tags_of.get(s["id"], ()))
            for tag in rset.get("balanceTags", [])
        }
        rels = relations_for_round(relations, ri)
        if ri in frozen:
            groups = start_groups[ri]
            energy += sum(_round_energy_from_members(
                set(grp), rset, tag_totals[ri], tags_of, n_students)
                for grp in groups)
            gid_of = {sid: gi for gi, grp in enumerate(groups) for sid in grp}
            for r in rels:
                ga, gb = gid_of.get(r["a"]), gid_of.get(r["b"])
                if r["type"] == "cannot" and ga is not None and ga == gb:
                    energy += HARD
            states.append(None)
            immovable.append(frozenset())
            block_cannots.append(None)
            for grp in groups:
                for x in range(len(grp)):
                    for y in range(x + 1, len(grp)):
                        key = (grp[x], grp[y]) if grp[x] < grp[y] else (grp[y], grp[x])
                        paircnt[key] += 1
            continue

        lk = locks_by_round.get(ri, {"members": set(), "groups": set()})
        locked_members = set(lk.get("members", []))
        locked_groups = set(lk.get("groups", []))
        base = start_groups.get(ri)

        blocks, bof, bcannot = solver._prepare(students, rels)
        gid_of_base = {}
        if base:
            for gi, grp in enumerate(base):
                for sid in grp:
                    gid_of_base[sid] = gi
        locked_block_group = {}
        for sid in locked_members:
            if sid in bof and sid in gid_of_base:
                locked_block_group[bof[sid]] = gid_of_base[sid]
        for gi in locked_groups:
            if base and 0 <= gi < len(base):
                for sid in base[gi]:
                    if sid in bof:
                        locked_block_group[bof[sid]] = gi

        st, blocks, bcannot = _initial_round(
            students, rels, rset, seed * 100 + ri,
            locked_block_group, locked_groups, base)
        states.append(st)
        block_cannots.append(bcannot)
        immovable.append(frozenset(locked_block_group) | frozenset(
            bi for bi in range(len(blocks)) if st.assign[bi] in locked_groups))
        for gi in range(st.g):
            energy += _round_energy_from_members(
                st.members[gi], rset, tag_totals[ri], tags_of, n_students)
            mem = list(st.members[gi])
            for x in range(len(mem)):
                for y in range(x + 1, len(mem)):
                    key = (mem[x], mem[y]) if mem[x] < mem[y] else (mem[y], mem[x])
                    paircnt[key] += 1
        energy += _cannot_penalty(st, bcannot)

    # 跨轮能量：每覆盖一对 -cov_w；超过上限的对按平方计罚分
    for c in paircnt.values():
        if c > cap:
            energy += (c - cap) ** 2 * CAP_W
        energy -= cov_w

    movable = [(ri, bi) for ri, st in enumerate(states) if st is not None
               for bi in range(len(st.blocks)) if bi not in immovable[ri]]
    iters = iters or min(14000, max(2500, 420 * len(movable)))
    best_energy = energy
    best_snapshot = _snapshot(states)

    t0, t1 = 5.0, 0.05
    for it in range(iters):
        if not movable:
            break
        temp = t0 * (t1 / t0) ** (it / max(1, iters - 1))
        ri, bi = rng.choice(movable)
        st = states[ri]
        rset = round_settings(rotation, ri)
        old_gi = st.assign[bi]
        locked_groups = locks_by_round.get(ri, {}).get("groups", set())
        cand = [g for g in range(st.g) if g != old_gi and g not in locked_groups]
        if not cand:
            continue
        new_gi = rng.choice(cand)

        block_mem = set(st.blocks[bi])
        e_before = (
            _round_energy_from_members(
                st.members[old_gi], rset, tag_totals[ri], tags_of, n_students)
            + _round_energy_from_members(
                st.members[new_gi], rset, tag_totals[ri], tags_of, n_students))
        e_after = (
            _round_energy_from_members(
                st.members[old_gi] - block_mem, rset, tag_totals[ri],
                tags_of, n_students)
            + _round_energy_from_members(
                st.members[new_gi] | block_mem, rset, tag_totals[ri],
                tags_of, n_students))

        cannot_before = cannot_after = 0.0
        for bj in block_cannots[ri][bi]:
            if st.assign[bj] == old_gi:
                cannot_before += HARD
            if st.assign[bj] == new_gi:
                cannot_after += HARD

        delta = (e_after - e_before + cannot_after - cannot_before
                 + _cross_delta(st, bi, old_gi, new_gi, paircnt, cap, cov_w))

        if delta <= 0 or rng.random() < math.exp(-delta / max(temp, 1e-9)):
            _apply_cross(st, bi, old_gi, new_gi, paircnt)
            st.place(bi, new_gi)
            energy += delta
            if energy < best_energy:
                best_energy = energy
                best_snapshot = _snapshot(states)

    _restore(states, best_snapshot)
    rounds_groups = [start_groups[ri] if st is None else st.to_groups()
                     for ri, st in enumerate(states)]
    return best_energy, rounds_groups


# ---------------------------------------------------------------- 硬性校验

def hard_violations(students, relations, rotation, rounds_groups):
    """检查完整方案：返回 (每轮违规数列表, 超上限对列表[(a,b,c)...])。"""
    gid_of_all = []
    per_round = []
    for ri, groups in enumerate(rounds_groups):
        rset = round_settings(rotation, ri)
        rels = relations_for_round(relations, ri)
        bad = 0
        gid_of = {}
        for gi, grp in enumerate(groups):
            for sid in grp:
                gid_of[sid] = gi
            if len(grp) < rset["minSize"] or len(grp) > rset["maxSize"]:
                bad += 1
        if len(groups) != rset["numGroups"]:
            bad += 1
        for r in rels:
            ga, gb = gid_of.get(r["a"]), gid_of.get(r["b"])
            if ga is None or gb is None:
                continue
            if (r["type"] == "cannot" and ga == gb) or \
               (r["type"] == "must" and ga != gb):
                bad += 1
        gid_of_all.append(gid_of)
        per_round.append(bad)
    cap = int(rotation.get("cap", len(rounds_groups)))
    cap_hits = sorted(((a, b, c) for (a, b), c in pair_counts(rounds_groups).items()
                       if c > cap), key=lambda x: -x[2])
    return per_round, cap_hits


# ---------------------------------------------------------------- 对外接口

def _plan_dict(rounds_groups, metrics):
    return {
        "rounds": rounds_groups,
        "hardOk": True,
        "coverage": metrics["coverage"],
        "coverageEach": metrics["coverageEach"],
        "coveredPairs": metrics["coveredPairs"],
        "totalPairs": metrics["totalPairs"],
        "maxRepeat": metrics["maxRepeat"],
        "capHits": metrics["capHits"],
        "tagDeviation": metrics["tagDeviation"],
    }


def generate_rotation(students, relations, rotation, num_plans=3):
    """生成多轮轮换方案。返回 (conflicts, plans)。"""
    conflicts = detect_rotation_conflicts(students, relations, rotation)
    if conflicts:
        return conflicts, []

    results = []
    seen_sig = set()
    for k in range(max(num_plans * 4, 10)):
        val, rounds_groups = run_rotation(
            students, relations, rotation, 51000 + k * 7)
        per_round_bad, cap_hits = hard_violations(
            students, relations, rotation, rounds_groups)
        if sum(per_round_bad) or cap_hits:
            continue
        sig = tuple(tuple(tuple(sorted(grp)) for grp in rg)
                    for rg in rounds_groups)
        if sig in seen_sig:
            continue
        seen_sig.add(sig)
        m = rotation_metrics([rounds_groups], students, rotation)[0]
        results.append((val, _plan_dict(rounds_groups, m)))
        if len(results) >= num_plans:
            break

    if results:
        results.sort(key=lambda t: t[0])
        return [], [p for _, p in results]

    # 启发式未能把上限压到 cap 以内：给出残留超限对（搜索失败提示，不声称数学无解）
    _, best_groups = run_rotation(students, relations, rotation, 99991)
    per_round_bad, cap_hits = hard_violations(
        students, relations, rotation, best_groups)
    names = {s["id"]: s["name"] for s in students}
    if sum(per_round_bad):
        return [{
            "kind": "rotation_round_infeasible", "round": -1, "cross": True,
            "people": [], "chain": [],
            "message": "存在轮次无法在人数范围与同组关系约束下完成分组，"
                       "请检查各轮组数与人数范围设置。",
        }], []
    shown = cap_hits[:8]
    cap = int(rotation.get("cap", len(rotation["rounds"])))
    detail = "；".join("「%s–%s」同组 %d 轮"
                      % (names.get(a, a), names.get(b, b), c) for a, b, c in shown)
    return [{
        "kind": "rotation_cap_unmet", "round": -1, "cross": True,
        "people": sorted({x for a, b, _ in shown for x in (a, b)}),
        "chain": [],
        "message": "多次搜索后仍无法把同组次数压到 %d 轮以内：%s%s。"
                   "可调高跨轮上限、减少轮数或增加每轮组数后重试。"
                   % (cap, detail, " 等" if len(cap_hits) > len(shown) else ""),
    }], []


def resolve_rotation(students, relations, rotation, current_rounds,
                     from_round, locks_by_round=None):
    """从 from_round 起重排（之前的轮冻结），返回 (conflicts, payload)。

    payload: rounds / fromRound / affectedCount / affected / repeatChanges / metrics。
    """
    R = len(rotation["rounds"])
    from_round = max(0, min(int(from_round), R - 1))
    frozen = set(range(from_round))
    start_groups = {ri: list(current_rounds[ri]) for ri in range(R)}

    locked_info = {}
    for ri in range(from_round, R):
        lk = (locks_by_round or {}).get(ri, {})
        locked_info[ri] = {
            "groups": current_rounds[ri],
            "locks": {"members": list(lk.get("members", [])),
                      "groups": list(lk.get("groups", []))},
        }
    conflicts = detect_rotation_conflicts(
        students, relations, rotation,
        frozen_groups={ri: current_rounds[ri] for ri in frozen},
        locked=locked_info)
    if conflicts:
        return conflicts, None

    locks_sets = {}
    for ri in range(from_round, R):
        lk = (locks_by_round or {}).get(ri, {})
        locks_sets[ri] = {
            "members": set(lk.get("members", [])),
            "groups": set(lk.get("groups", [])),
        }

    best = None
    for k in range(6):
        val, rounds_groups = run_rotation(
            students, relations, rotation, 81000 + k * 13,
            frozen=frozen, locks_by_round=locks_sets,
            start_groups=start_groups)
        per_round_bad, cap_hits = hard_violations(
            students, relations, rotation, rounds_groups)
        frozen_ok = all(
            [sorted(x) for x in rounds_groups[ri]] ==
            [sorted(x) for x in current_rounds[ri]] for ri in frozen)
        if (not sum(per_round_bad)) and (not cap_hits) and frozen_ok \
                and (best is None or val < best[0]):
            best = (val, rounds_groups)

    if best is None:
        return [{
            "kind": "rotation_resolve_infeasible",
            "round": from_round, "cross": False,
            "people": sorted(locks_sets.get(from_round, {}).get("members", set())),
            "chain": [],
            "message": "在第 %d 轮起的锁定状态下，后续轮次无法同时满足同组关系、"
                       "人数范围与跨轮同组上限，请解除部分锁定或放宽跨轮限制。"
                       % (from_round + 1),
        }], None

    _, new_rounds = best
    old_counts = pair_counts(current_rounds)
    new_counts = pair_counts(new_rounds)

    affected = set()
    for ri in range(from_round, R):
        old_map = {sid: gi for gi, grp in enumerate(current_rounds[ri])
                   for sid in grp}
        for gi, grp in enumerate(new_rounds[ri]):
            for sid in grp:
                if old_map.get(sid) != gi:
                    affected.add(sid)

    more, less = [], []
    for key in set(old_counts) | set(new_counts):
        d = new_counts.get(key, 0) - old_counts.get(key, 0)
        item = {"a": key[0], "b": key[1], "before": old_counts.get(key, 0),
                "after": new_counts.get(key, 0)}
        if d > 0:
            more.append(item)
        elif d < 0:
            less.append(item)
    more.sort(key=lambda x: -(x["after"] - x["before"]))
    less.sort(key=lambda x: x["after"] - x["before"])

    return [], {
        "rounds": new_rounds,
        "fromRound": from_round,
        "affectedCount": len(affected),
        "affected": sorted(affected),
        "repeatChanges": {
            "more": more[:20], "less": less[:20],
            "moreCount": len(more), "lessCount": len(less),
        },
        "metrics": rotation_metrics([new_rounds], students, rotation)[0],
    }

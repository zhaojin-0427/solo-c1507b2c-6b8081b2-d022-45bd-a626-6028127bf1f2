# -*- coding: utf-8 -*-
"""角色轮值求解器。

在既有分组方案（单轮或多轮）之上，为每轮、每组的角色槽位安排成员：
主持、记录、计时、汇报等职责由模板定义（每组名额 / 所需技能标签 /
个人禁任 / 不可兼任规则 / 同一人连续与累计上限）。

对外接口：
1. static_conflicts —— 返回 (阻断性冲突, 提示性警告)。
   阻断性冲突：无效锁定（成员不在组、禁任、锁定互斥、锁定超额等）；
   提示性警告：合格人手不足、槽位超过组人数、累计上限容量不足——
   不阻断求解，由候选指标体现。
2. fill_roles —— 保持锁定不动，多种子模拟退火补齐空缺，
   返回若干候选，每个候选带对比指标（空缺数 / 资格违规 / 同轮兼任 /
   连续累计超限 / 角色重复 / 负担差异）。
3. compute_metrics —— 计算一份安排的对比指标。
"""
import math
import random
from collections import defaultdict

W_VAC = 100.0    # 空缺一个槽位
W_BAN = 200.0    # 禁任成员担任该角色（比空缺更严重）
W_TAG = 80.0     # 缺少所需技能标签（比空缺略轻，允许先顶上再标注）
W_NC = 60.0      # 同轮兼任（每对冲突）
W_LIMIT = 45.0   # 连续 / 累计超限（每超一轮）
W_REP = 6.0      # 同人同角色重复（软目标：角色尽量轮换）
W_LOAD = 8.0     # 负担差异（担任最多与最少者的人次差，每单位）


def _int(v, d=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return d


def _role_limits(template, rid):
    lim = (template.get("limits") or {}).get(rid) or {}
    return (max(0, _int(lim.get("maxConsecutive"), 0)),
            max(0, _int(lim.get("maxTotal"), 0)))


def nc_pairs(template):
    """不可兼任角色对（frozenset({ridA, ridB}) 集合）。mode=all 时为全部角色对。"""
    roles = [r["id"] for r in template.get("roles", [])]
    if template.get("ncMode", "all") == "all":
        return {frozenset((a, b)) for i, a in enumerate(roles)
                for b in roles[i + 1:]}
    out = set()
    for p in template.get("ncPairs") or []:
        if isinstance(p, (list, tuple)) and len(p) == 2 and p[0] != p[1]:
            out.add(frozenset((str(p[0]), str(p[1]))))
    return out


# ---------------------------------------------------------------- 静态检查

def static_conflicts(students, template, rounds_groups, locks):
    """返回 (conflicts, warnings)。conflicts 阻断求解，warnings 仅提示。"""
    names = {s["id"]: s["name"] for s in students}
    tags_of = {s["id"]: set(s.get("tags") or []) for s in students}
    roles = template.get("roles", [])
    conflicts, warnings = [], []

    if not roles:
        conflicts.append({
            "kind": "role_empty", "people": [], "chain": [],
            "message": "请先在角色模板中定义至少一个角色（如：主持、记录、计时、汇报）。",
        })
        return conflicts, warnings
    if not rounds_groups or not any(any(g) for rnd in rounds_groups for g in rnd):
        conflicts.append({
            "kind": "role_no_groups", "people": [], "chain": [],
            "message": "分组为空，请先在排演台生成分组方案，再建立角色轮值草稿。",
        })
        return conflicts, warnings

    # 1) 提示性：每组合格人手 / 槽位总量
    nc_all = template.get("ncMode", "all") == "all"
    slots_per_group = sum(max(1, _int(r.get("perGroup"), 1)) for r in roles)
    for ri, groups in enumerate(rounds_groups):
        for gi, grp in enumerate(groups):
            if nc_all and slots_per_group > len(grp):
                warnings.append({
                    "kind": "role_overbook", "round": ri, "group": gi,
                    "people": list(grp), "chain": [],
                    "message": "第 %d 轮第 %d 组仅 %d 人，角色槽共 %d 个且规则为"
                               "“任意两角色不可同轮兼任”，必然出现空缺。"
                               % (ri + 1, gi + 1, len(grp), slots_per_group),
                })
            for role in roles:
                need = set(role.get("tags") or [])
                banned = set(role.get("ban") or [])
                per = max(1, _int(role.get("perGroup"), 1))
                pool = [m for m in grp
                        if m not in banned and need <= tags_of.get(m, set())]
                if len(pool) < per:
                    warnings.append({
                        "kind": "role_pool", "round": ri, "group": gi,
                        "people": list(pool), "chain": [],
                        "message": "第 %d 轮第 %d 组角色「%s」需 %d 人，组内合格成员"
                                   "仅 %d 人（所需标签：%s；组内被禁任 %d 人），"
                                   "将出现空缺或资格违规。"
                                   % (ri + 1, gi + 1, role["name"], per, len(pool),
                                      "、".join(role.get("tags") or []) or "无",
                                      len([m for m in grp if m in banned])),
                    })

    # 2) 提示性：累计上限总容量
    n_students = len(students)
    total_groups = sum(len(groups) for groups in rounds_groups)
    for role in roles:
        _, mt = _role_limits(template, role["id"])
        if mt > 0:
            need_total = max(1, _int(role.get("perGroup"), 1)) * total_groups
            if mt * n_students < need_total:
                warnings.append({
                    "kind": "role_limit_capacity", "round": -1,
                    "people": [], "chain": [],
                    "message": "角色「%s」累计上限 %d 轮 × %d 名学员 = %d 人次，"
                               "少于所需的 %d 人次，必然出现空缺或超限。"
                               % (role["name"], mt, n_students,
                                  mt * n_students, need_total),
                })

    # 3) 阻断性：锁定有效性
    rbyid = {r["id"]: r for r in roles}
    seen_lock = set()
    lock_slots = defaultdict(int)        # (ri,gi,rid) -> 锁定人数
    locked_roles_of = defaultdict(list)  # (ri, mid) -> [rid]
    for l in locks or []:
        ri, gi = l.get("round"), l.get("group")
        rid, mid = l.get("role"), l.get("member")
        role = rbyid.get(rid)
        nm = names.get(mid, mid)
        if role is None:
            conflicts.append({
                "kind": "role_lock_role", "people": [mid], "chain": [],
                "message": "「%s」被锁定的角色已不存在，请先解除该锁定。" % nm,
            })
            continue
        key = (ri, gi, rid, mid)
        if key in seen_lock:
            continue
        seen_lock.add(key)
        lock_slots[(ri, gi, rid)] += 1
        grp = None
        if isinstance(ri, int) and 0 <= ri < len(rounds_groups):
            groups = rounds_groups[ri]
            if isinstance(gi, int) and 0 <= gi < len(groups):
                grp = groups[gi]
        if grp is None or mid not in grp:
            conflicts.append({
                "kind": "role_lock_member", "people": [mid], "chain": [],
                "message": "「%s」被锁定为第 %d 轮第 %d 组的「%s」，但其不在该组，"
                           "锁定无效。" % (nm, (ri or 0) + 1, (gi or 0) + 1,
                                          role["name"]),
            })
        elif mid in set(role.get("ban") or []):
            conflicts.append({
                "kind": "role_lock_ban", "people": [mid], "chain": [],
                "message": "「%s」被锁定为「%s」，但该角色已将其列为禁任，"
                           "锁定与禁任规则冲突。" % (nm, role["name"]),
            })
        locked_roles_of[(ri, mid)].append(rid)
    for (ri, gi, rid), cnt in lock_slots.items():
        role = rbyid[rid]
        per = max(1, _int(role.get("perGroup"), 1))
        if cnt > per:
            conflicts.append({
                "kind": "role_lock_slot", "people": [], "chain": [],
                "message": "第 %d 轮第 %d 组「%s」被锁定 %d 人，超过每组名额 %d。"
                           % (ri + 1, gi + 1, role["name"], cnt, per),
            })
    pairs = nc_pairs(template)
    for (ri, mid), rids in locked_roles_of.items():
        for x in range(len(rids)):
            for y in range(x + 1, len(rids)):
                if frozenset((rids[x], rids[y])) in pairs:
                    conflicts.append({
                        "kind": "role_lock_concurrent", "people": [mid], "chain": [],
                        "message": "「%s」在第 %d 轮被同时锁定为「%s」与「%s」，"
                                   "违反不可兼任规则。"
                                   % (names.get(mid, mid), ri + 1,
                                      rbyid[rids[x]]["name"], rbyid[rids[y]]["name"]),
                    })
    return conflicts, warnings


# ---------------------------------------------------------------- 指标

def compute_metrics(students, template, rounds_groups, assign):
    """对比指标：空缺 / 资格违规 / 同轮兼任 / 超限 / 角色重复 / 负担差异。"""
    ids = [s["id"] for s in students]
    tags_of = {s["id"]: set(s.get("tags") or []) for s in students}
    roles = template.get("roles", [])
    R = len(rounds_groups)
    pairs = nc_pairs(template)
    nc_all = template.get("ncMode", "all") == "all"

    vacancies = tag_v = ban_v = 0
    held = defaultdict(list)                    # (ri, sid) -> [rid]
    pr = defaultdict(lambda: [0] * R)           # (rid, sid) -> 各轮 0/1
    load = {sid: 0 for sid in ids}
    for ri, groups in enumerate(rounds_groups):
        for gi, grp in enumerate(groups):
            gas = {}
            if ri < len(assign) and gi < len(assign[ri]) \
                    and isinstance(assign[ri][gi], dict):
                gas = assign[ri][gi]
            for role in roles:
                rid = role["id"]
                per = max(1, _int(role.get("perGroup"), 1))
                got = [m for m in (gas.get(rid) or []) if m in grp][:per]
                vacancies += max(0, per - len(got))
                need = set(role.get("tags") or [])
                banned = set(role.get("ban") or [])
                for m in got:
                    load[m] = load.get(m, 0) + 1
                    held[(ri, m)].append(rid)
                    pr[(rid, m)][ri] += 1
                    if m in banned:
                        ban_v += 1
                    elif not need <= tags_of.get(m, set()):
                        tag_v += 1
    nc_v = 0
    for (ri, m), rids in held.items():
        if nc_all:
            k = len(set(rids))
            nc_v += k * (k - 1) // 2
        else:
            s = set(rids)
            nc_v += sum(1 for p in pairs if p <= s)
    limit_v = 0
    repeats = 0
    for (rid, m), arr in pr.items():
        total = sum(arr)
        if total > 1:
            repeats += total - 1
        mc, mt = _role_limits(template, rid)
        if mt > 0 and total > mt:
            limit_v += total - mt
        if mc > 0:
            run = 0
            for x in arr:
                if x:
                    run += 1
                else:
                    if run > mc:
                        limit_v += run - mc
                    run = 0
            if run > mc:
                limit_v += run - mc
    loads = [load.get(sid, 0) for sid in ids]
    spread = (max(loads) - min(loads)) if loads else 0
    return {
        "vacancies": vacancies,
        "tagViolations": tag_v,
        "banViolations": ban_v,
        "qualViolations": tag_v + ban_v,
        "concurrentViolations": nc_v,
        "limitViolations": limit_v,
        "roleRepeats": repeats,
        "loadSpread": spread,
    }


# ---------------------------------------------------------------- 退火补齐

def fill_roles(students, template, rounds_groups, current_assign, locks,
               num_candidates=3):
    """保持锁定不动，补齐空缺槽位。返回候选列表 [{assign, metrics}]。"""
    ids = [s["id"] for s in students]
    pos = {sid: i for i, sid in enumerate(ids)}
    tags_of = {s["id"]: set(s.get("tags") or []) for s in students}
    roles = template.get("roles", [])
    n_roles = len(roles)
    R = len(rounds_groups)
    ridx = {r["id"]: i for i, r in enumerate(roles)}
    nc_all = template.get("ncMode", "all") == "all"
    pair_idx = set()
    for p in nc_pairs(template):
        a, b = sorted(p)
        if a in ridx and b in ridx:
            pair_idx.add(tuple(sorted((ridx[a], ridx[b]))))
    lims = [_role_limits(template, r["id"]) for r in roles]
    need = [set(r.get("tags") or []) for r in roles]
    ban = [set(r.get("ban") or []) for r in roles]
    per = [max(1, _int(r.get("perGroup"), 1)) for r in roles]

    # ---------- 槽位（锁定者固定在每个 (轮,组,角色) 的前若干槽） ----------
    lock_map = defaultdict(list)
    for l in locks or []:
        lock_map[(l["round"], l["group"], l["role"])].append(l["member"])
    slots = []                            # (ri, gi, rdx)
    slot_locked = []                      # None 或锁定成员
    slot_key_idx = defaultdict(list)      # (ri,gi,rdx) -> [槽位下标]
    for ri, groups in enumerate(rounds_groups):
        for gi, grp in enumerate(groups):
            for rdx, role in enumerate(roles):
                locked_here = lock_map.get((ri, gi, role["id"]), [])
                for k in range(per[rdx]):
                    slot_key_idx[(ri, gi, rdx)].append(len(slots))
                    slots.append((ri, gi, rdx))
                    slot_locked.append(locked_here[k] if k < len(locked_here)
                                       else None)
    n_slots = len(slots)
    if not n_slots:
        return []

    cur = current_assign or []

    def current_of(ri, gi, rdx):
        if ri < len(cur) and gi < len(cur[ri]) \
                and isinstance(cur[ri][gi], dict):
            return cur[ri][gi].get(roles[rdx]["id"]) or []
        return []

    def qualified(m, rdx):
        return m not in ban[rdx] and need[rdx] <= tags_of.get(m, set())

    def initial_val(rng):
        """初始解：锁定 → 沿用当前安排 → 贪心补空（合格 + 低负担优先）。"""
        val = list(slot_locked)
        used = defaultdict(set)
        for i, s in enumerate(val):
            if s is not None:
                used[slots[i]].add(s)
        for key, idxs in slot_key_idx.items():
            ri, gi, rdx = key
            grp = set(rounds_groups[ri][gi])
            free = iter([i for i in idxs if val[i] is None])
            for m in current_of(ri, gi, rdx):
                if m in grp and m not in used[key]:
                    try:
                        i = next(free)
                    except StopIteration:
                        break
                    val[i] = m
                    used[key].add(m)
        load_now = defaultdict(int)
        for s in val:
            if s is not None:
                load_now[s] += 1
        for i, (ri, gi, rdx) in enumerate(slots):
            if val[i] is not None:
                continue
            key = (ri, gi, rdx)
            cands = [m for m in rounds_groups[ri][gi] if m not in used[key]]
            if not cands:
                continue
            pool = sorted(cands, key=lambda m: (0 if qualified(m, rdx) else 1,
                                                load_now[m], rng.random()))
            pick = pool[0] if rng.random() < 0.9 else rng.choice(pool)
            val[i] = pick
            used[key].add(pick)
            load_now[pick] += 1
        return val

    # ---------- 增量计数器 ----------
    held = [defaultdict(lambda: defaultdict(int)) for _ in range(R)]
    prcnt = [[None] * len(ids) for _ in range(n_roles)]
    for rdx in range(n_roles):
        for si in range(len(ids)):
            prcnt[rdx][si] = [0] * R
    load = [0] * len(ids)
    load_hist = defaultdict(int)
    load_mm = [0, 0]                      # [min, max]
    used_g = defaultdict(set)

    def load_all(val):
        for ri in range(R):
            held[ri].clear()
        for rdx in range(n_roles):
            for si in range(len(ids)):
                arr = prcnt[rdx][si]
                for x in range(R):
                    arr[x] = 0
        for si in range(len(ids)):
            load[si] = 0
        load_hist.clear()
        used_g.clear()
        for i, m in enumerate(val):
            if m is not None:
                ri, gi, rdx = slots[i]
                si = pos[m]
                held[ri][si][rdx] += 1
                prcnt[rdx][si][ri] += 1
                load[si] += 1
                used_g[(ri, gi, rdx)].add(m)
        for v in load:
            load_hist[v] += 1
        load_mm[0] = min(load) if load else 0
        load_mm[1] = max(load) if load else 0

    def _bump(i, m, delta):
        ri, gi, rdx = slots[i]
        si = pos[m]
        held[ri][si][rdx] += delta
        prcnt[rdx][si][ri] += delta
        old = load[si]
        new = old + delta
        load[si] = new
        load_hist[old] -= 1
        load_hist[new] += 1
        if delta > 0:
            used_g[(ri, gi, rdx)].add(m)
            if new > load_mm[1]:
                load_mm[1] = new
            if load_hist[old] == 0 and old == load_mm[0]:
                load_mm[0] = new
        else:
            used_g[(ri, gi, rdx)].discard(m)
            if new < load_mm[0]:
                load_mm[0] = new
            if load_hist[old] == 0 and old == load_mm[1]:
                load_mm[1] = new

    # ---------- 能量项 ----------
    def slot_term(v, i):
        if v is None:
            return W_VAC
        rdx = slots[i][2]
        if v in ban[rdx]:
            return W_BAN
        if not need[rdx] <= tags_of.get(v, set()):
            return W_TAG
        return 0.0

    def nc_term(ri, si):
        h = held[ri].get(si)
        if not h:
            return 0.0
        if nc_all:
            k = sum(1 for c in h.values() if c > 0)
            return (k * (k - 1) // 2) * W_NC
        cnt = 0
        for (a, b) in pair_idx:
            if h.get(a, 0) > 0 and h.get(b, 0) > 0:
                cnt += 1
        return cnt * W_NC

    def role_term(rdx, si):
        arr = prcnt[rdx][si]
        total = sum(arr)
        e = 0.0
        if total > 1:
            e += (total - 1) * W_REP
        mc, mt = lims[rdx]
        if mt > 0 and total > mt:
            e += (total - mt) * W_LIMIT
        if mc > 0:
            run = 0
            for x in arr:
                if x:
                    run += 1
                else:
                    if run > mc:
                        e += (run - mc) * W_LIMIT
                    run = 0
            if run > mc:
                e += (run - mc) * W_LIMIT
        return e

    def load_term():
        return (load_mm[1] - load_mm[0]) * W_LOAD

    def energy_now(val):
        e = sum(slot_term(v, i) for i, v in enumerate(val))
        for ri in range(R):
            for si in list(held[ri].keys()):
                e += nc_term(ri, si)
        for rdx in range(n_roles):
            for si in range(len(ids)):
                e += role_term(rdx, si)
        return e + load_term()

    def move(val, i, nv, temp, rng):
        """尝试把槽位 i 改为 nv；返回 (delta, accepted)。拒绝时已还原。"""
        old = val[i]
        if old == nv:
            return 0.0, False
        ri, gi, rdx = slots[i]
        sis = set()
        if old is not None:
            sis.add(pos[old])
        if nv is not None:
            sis.add(pos[nv])
        before = slot_term(old, i) + load_term()
        for si in sis:
            before += nc_term(ri, si) + role_term(rdx, si)
        if old is not None:
            _bump(i, old, -1)
        val[i] = nv
        if nv is not None:
            _bump(i, nv, 1)
        after = slot_term(nv, i) + load_term()
        for si in sis:
            after += nc_term(ri, si) + role_term(rdx, si)
        delta = after - before
        if delta <= 0 or rng.random() < math.exp(-delta / max(temp, 1e-9)):
            return delta, True
        if nv is not None:
            _bump(i, nv, -1)
        val[i] = old
        if old is not None:
            _bump(i, old, 1)
        return 0.0, False

    def to_assign(val):
        out = []
        for ri, groups in enumerate(rounds_groups):
            rnd = []
            for gi, grp in enumerate(groups):
                d = {}
                for rdx, role in enumerate(roles):
                    members = [val[i] for i in slot_key_idx[(ri, gi, rdx)]
                               if val[i] is not None]
                    if members:
                        d[role["id"]] = members
                rnd.append(d)
            out.append(rnd)
        return out

    movable = [i for i in range(n_slots) if slot_locked[i] is None]
    iters = min(9000, max(2500, 350 * max(1, len(movable))))
    results = []
    seen = set()
    runs = max(5, num_candidates * 2)
    for run in range(runs):
        rng = random.Random(91000 + run * 17)
        val = initial_val(rng)
        load_all(val)
        cur_e = energy_now(val)
        best_val, best_e = list(val), cur_e
        t0, t1 = 40.0, 0.2
        for it in range(iters):
            if not movable:
                break
            temp = t0 * (t1 / t0) ** (it / max(1, iters - 1))
            i = rng.choice(movable)
            ri, gi, rdx = slots[i]
            used = used_g[(ri, gi, rdx)]
            opts = []
            for m in rounds_groups[ri][gi]:
                if m in used and m != val[i]:
                    continue
                w = 3 if qualified(m, rdx) else 1
                opts.extend([m] * w)
            opts.append(None)
            nv = rng.choice(opts)
            delta, ok = move(val, i, nv, temp, rng)
            if ok:
                cur_e += delta
                if cur_e < best_e:
                    best_e = cur_e
                    best_val = list(val)
        assign = to_assign(best_val)
        metrics = compute_metrics(students, template, rounds_groups, assign)
        key = (metrics["vacancies"], metrics["qualViolations"],
               metrics["concurrentViolations"], metrics["limitViolations"],
               metrics["roleRepeats"], metrics["loadSpread"])
        sig = repr(assign)
        if sig in seen:
            continue
        seen.add(sig)
        results.append((key, assign, metrics))
    results.sort(key=lambda t: t[0])
    return [{"assign": a, "metrics": m} for _, a, m in results[:num_candidates]]

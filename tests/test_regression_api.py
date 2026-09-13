# -*- coding: utf-8 -*-
"""缺陷回归测试（API 级）。

覆盖：
1. “不可同组”奇环 + 2 组 → 判定无解，不输出不可行方案，给出人员与冲突链路；
2. 同一“必须同组”块被分裂锁定 → 局部重排报告冲突，不移动锁定成员；
3. 既有功能回归：正常生成、成员锁/整组锁在重排后保持不动；
4. 角色轮值：补齐空缺、锁定保持、连续/累计上限、禁任、候选指标、
   锁定冲突阻断、存档往返（含旧存档兼容）与匿名打印页。

运行：python3 tests/test_regression_api.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app  # noqa: E402


def make_students(n, prefix="p"):
    return [{"id": "%s%d" % (prefix, i), "name": "学员%d" % i, "tags": []}
            for i in range(n)]


class OddCycleRegressionTest(unittest.TestCase):
    """缺陷1：5 人“不可同组”奇环 + 2 组，必须判定无解。"""

    def setUp(self):
        self.client = app.test_client()
        self.students = make_students(5)
        self.relations = [{"type": "cannot", "a": "p%d" % i, "b": "p%d" % ((i + 1) % 5)}
                          for i in range(5)]  # C5 奇环
        self.settings = {"numGroups": 2, "minSize": 2, "maxSize": 3,
                         "balanceTags": [], "numSolutions": 3}

    def generate(self):
        res = self.client.post("/api/generate", json={
            "students": self.students,
            "relations": self.relations,
            "settings": self.settings,
        })
        self.assertEqual(res.status_code, 200)
        return res.get_json()

    def test_no_infeasible_solutions_returned(self):
        data = self.generate()
        self.assertEqual(data["solutions"], [],
                         "无解场景不得输出任何方案（此前会返回 3 套 hardOk=False 方案）")

    def test_conflict_reports_people_and_chain(self):
        data = self.generate()
        conflicts = data["conflicts"]
        self.assertTrue(conflicts, "无解场景必须返回冲突说明")
        c = next((x for x in conflicts if x["kind"] == "cannot_odd_cycle"), None)
        self.assertIsNotNone(c, "应识别出“不可同组”奇环冲突，得到: %s"
                             % [x["kind"] for x in conflicts])
        # 涉及人员：5 人全部在环上
        self.assertEqual(sorted(c["people"]), ["p0", "p1", "p2", "p3", "p4"])
        # 冲突链路：5 条“不可同组”边构成闭环
        self.assertEqual(len(c["chain"]), 5)
        self.assertTrue(all(l["type"] == "cannot" for l in c["chain"]))
        self.assertEqual(c["chain"][0]["a"], c["chain"][-1]["b"], "链路应首尾闭合")
        self.assertIn("无解", c["message"])

    def test_even_cycle_still_solvable(self):
        """对照组：偶环 C4 可 2 着色，应正常出方案且全部可行。"""
        relations = [{"type": "cannot", "a": "p%d" % i, "b": "p%d" % ((i + 1) % 4)}
                     for i in range(4)]
        students = make_students(4)
        res = self.client.post("/api/generate", json={
            "students": students, "relations": relations,
            "settings": {"numGroups": 2, "minSize": 2, "maxSize": 2,
                         "balanceTags": [], "numSolutions": 2},
        })
        data = res.get_json()
        self.assertEqual(data["conflicts"], [])
        self.assertTrue(data["solutions"], "偶环应能生成可行方案")
        for sol in data["solutions"]:
            self.assertTrue(sol["hardOk"])
            gid = {s: g for g, grp in enumerate(sol["groups"]) for s in grp}
            for r in relations:
                self.assertNotEqual(gid[r["a"]], gid[r["b"]])


class LockConflictRegressionTest(unittest.TestCase):
    """缺陷2：同一“必须同组”块被分裂到不同组并分别锁定。"""

    def setUp(self):
        self.client = app.test_client()
        self.students = make_students(6, "q")
        self.relations = [{"type": "must", "a": "q0", "b": "q1"}]
        self.settings = {"numGroups": 2, "minSize": 2, "maxSize": 4,
                         "balanceTags": [], "numSolutions": 2}
        # q0、q1 被（手动拖拽）拆到两组，并分别锁定
        self.groups = [["q0", "q2", "q3"], ["q1", "q4", "q5"]]

    def resolve(self, locks):
        res = self.client.post("/api/resolve", json={
            "students": self.students,
            "relations": self.relations,
            "settings": self.settings,
            "groups": self.groups,
            "locks": locks,
        })
        self.assertEqual(res.status_code, 200)
        return res.get_json()

    def test_split_member_locks_reported_as_conflict(self):
        data = self.resolve({"members": ["q0", "q1"], "groups": []})
        self.assertIsNone(data["solution"], "矛盾锁定不得产出方案")
        kinds = [c["kind"] for c in data["conflicts"]]
        self.assertIn("lock_must_split", kinds)
        c = data["conflicts"][kinds.index("lock_must_split")]
        self.assertIn("q0", c["people"])
        self.assertIn("q1", c["people"])
        self.assertTrue(any(l["type"] == "must" for l in c["chain"]),
                        "冲突链路应包含连接两人的“必须同组”边")
        self.assertIn("矛盾", c["message"])

    def test_split_group_locks_reported_as_conflict(self):
        """整组锁造成的分裂同样要报冲突。"""
        data = self.resolve({"members": [], "groups": [0, 1]})
        self.assertIsNone(data["solution"])
        kinds = [c["kind"] for c in data["conflicts"]]
        self.assertIn("lock_must_split", kinds)

    def test_mixed_member_and_group_lock_conflict(self):
        """成员锁（q0→组1）与整组锁（组2 含 q1）互相矛盾。"""
        data = self.resolve({"members": ["q0"], "groups": [1]})
        self.assertIsNone(data["solution"])
        kinds = [c["kind"] for c in data["conflicts"]]
        self.assertIn("lock_must_split", kinds)


class LockPreservationRegressionTest(unittest.TestCase):
    """回归：合法锁定时，成员锁与整组锁在重排后必须保持不动。"""

    def setUp(self):
        self.client = app.test_client()
        self.students = [
            {"id": "s%d" % i, "name": "学员%d" % i,
             "tags": t} for i, t in enumerate([
                 ["前端"], ["后端"], ["设计"], ["前端"],
                 ["后端"], ["运维"], ["测试"], ["设计"],
             ])]
        self.relations = [{"type": "must", "a": "s0", "b": "s3"},
                          {"type": "cannot", "a": "s1", "b": "s4"}]
        self.settings = {"numGroups": 2, "minSize": 3, "maxSize": 5,
                         "balanceTags": ["前端"], "numSolutions": 2}
        res = self.client.post("/api/generate", json={
            "students": self.students, "relations": self.relations,
            "settings": self.settings})
        data = res.get_json()
        self.assertEqual(data["conflicts"], [])
        self.groups = data["solutions"][0]["groups"]

    def group_of(self, groups, sid):
        return next(g for g, grp in enumerate(groups) if sid in grp)

    def test_member_lock_and_group_lock_hold(self):
        locked_member = self.groups[0][0]
        locks = {"members": [locked_member], "groups": [1]}
        res = self.client.post("/api/resolve", json={
            "students": self.students, "relations": self.relations,
            "settings": self.settings, "groups": self.groups, "locks": locks})
        data = res.get_json()
        self.assertEqual(data["conflicts"], [])
        sol = data["solution"]
        self.assertIsNotNone(sol)
        self.assertTrue(sol["hardOk"])
        # 成员锁：仍在原组
        self.assertEqual(self.group_of(sol["groups"], locked_member), 0,
                         "成员锁被重排覆盖")
        # 整组锁：组成完全不变
        self.assertEqual(sorted(sol["groups"][1]), sorted(self.groups[1]),
                         "整组锁被重排覆盖")
        # 重排后硬约束仍满足
        gid = {s: g for g, grp in enumerate(sol["groups"]) for s in grp}
        self.assertEqual(gid["s0"], gid["s3"])
        self.assertNotEqual(gid["s1"], gid["s4"])

    def test_must_block_follows_single_lock(self):
        """只锁块中一人时，整块跟随到该组（语义正确，不算移动锁定成员）。"""
        locked_member = self.groups[0][0]
        partner = "s0" if locked_member != "s0" else "s3"
        if self.group_of(self.groups, partner) != 0:
            partner = None
        locks = {"members": [locked_member], "groups": []}
        res = self.client.post("/api/resolve", json={
            "students": self.students, "relations": self.relations,
            "settings": self.settings, "groups": self.groups, "locks": locks})
        data = res.get_json()
        self.assertEqual(data["conflicts"], [])
        sol = data["solution"]
        self.assertEqual(self.group_of(sol["groups"], locked_member), 0)
        if partner:
            self.assertEqual(self.group_of(sol["groups"], partner), 0,
                             "必须同组伙伴应跟随锁定成员留在同组")


class FeasibleGenerationRegressionTest(unittest.TestCase):
    """回归：正常场景仍生成多套可行方案。"""

    def test_normal_generation(self):
        client = app.test_client()
        students = [{"id": "s%d" % i, "name": "学员%d" % i, "tags": t}
                    for i, t in enumerate([["前端"], ["后端"], ["设计"],
                                           ["前端"], ["后端"], ["运维"],
                                           ["前端"], ["测试"], ["后端"]])]
        relations = [{"type": "must", "a": "s0", "b": "s6"},
                     {"type": "cannot", "a": "s1", "b": "s8"}]
        res = client.post("/api/generate", json={
            "students": students, "relations": relations,
            "settings": {"numGroups": 3, "minSize": 2, "maxSize": 4,
                         "balanceTags": ["前端"], "numSolutions": 3}})
        data = res.get_json()
        self.assertEqual(data["conflicts"], [])
        self.assertGreaterEqual(len(data["solutions"]), 2)
        for sol in data["solutions"]:
            self.assertTrue(sol["hardOk"])
            gid = {s: g for g, grp in enumerate(sol["groups"]) for s in grp}
            self.assertEqual(gid["s0"], gid["s6"])
            self.assertNotEqual(gid["s1"], gid["s8"])
            for grp in sol["groups"]:
                self.assertTrue(2 <= len(grp) <= 4)


class RotationGenerationTest(unittest.TestCase):
    """多轮轮换：完整方案生成（覆盖率/重复上限/关系作用域）。"""

    def setUp(self):
        self.client = app.test_client()
        self.students = [
            {"id": "s%d" % i, "name": "学员%d" % i, "tags": t}
            for i, t in enumerate([
                ["前端"], ["后端"], ["设计"], ["前端"], ["后端"], ["运维"],
                ["测试"], ["设计"], ["前端"], ["后端"], ["演讲"], ["测试"],
            ])]
        self.relations = [
            {"type": "must", "a": "s0", "b": "s3", "scope": {"rounds": [0, 1]}},
            {"type": "cannot", "a": "s1", "b": "s4", "scope": "all"},
        ]
        self.rotation = {
            "rounds": [
                {"numGroups": 3, "minSize": 3, "maxSize": 5},
                {"numGroups": 4, "minSize": 2, "maxSize": 4},
                {"numGroups": 3, "minSize": 3, "maxSize": 5},
            ],
            "balanceTags": ["前端", "后端"], "cap": 2,
            "maxCoverage": True, "numPlans": 3,
        }

    def generate(self, rotation=None, relations=None):
        res = self.client.post("/api/rotation/generate", json={
            "students": self.students,
            "relations": relations if relations is not None else self.relations,
            "rotation": rotation or self.rotation,
        })
        self.assertEqual(res.status_code, 200)
        return res.get_json()

    def test_generates_feasible_rotation_plans(self):
        data = self.generate()
        self.assertEqual(data["conflicts"], [])
        self.assertGreaterEqual(len(data["plans"]), 2)
        for plan in data["plans"]:
            self.assertTrue(plan["hardOk"])
            self.assertEqual(len(plan["rounds"]), 3)
            for ri, groups in enumerate(plan["rounds"]):
                rc = self.rotation["rounds"][ri]
                self.assertEqual(len(groups), rc["numGroups"])
                for grp in groups:
                    self.assertTrue(rc["minSize"] <= len(grp) <= rc["maxSize"])
                gid = {s: g for g, gr in enumerate(groups) for s in gr}
                # “不可同组”全程生效
                self.assertNotEqual(gid["s1"], gid["s4"])
                # “必须同组”只在第 1、2 轮生效
                if ri in (0, 1):
                    self.assertEqual(gid["s0"], gid["s3"])
            # 全员每轮恰好出现一次
            for groups in plan["rounds"]:
                flat = sorted(s for g in groups for s in g)
                self.assertEqual(flat, sorted(s["id"] for s in self.students))
            # 跨轮上限
            self.assertLessEqual(plan["maxRepeat"], 2)
            self.assertEqual(plan["capHits"], [])
            self.assertTrue(0 < plan["coverage"] <= 1)
            # 指标含每轮标签偏差
            self.assertEqual(len(plan["tagDeviation"]), 3)

    def test_capacity_conflict_static_not_500(self):
        """两轮 5/5 大组 + cap=1 必须静态判冲突，而不是搜索后失败或 500。"""
        rotation = {
            "rounds": [
                {"numGroups": 2, "minSize": 4, "maxSize": 6},
                {"numGroups": 2, "minSize": 4, "maxSize": 6},
            ],
            "balanceTags": [], "cap": 1, "numPlans": 2,
        }
        data = self.generate(rotation, [])
        self.assertEqual(data["plans"], [])
        self.assertTrue(data["conflicts"])
        self.assertIn("rotation_cap_capacity",
                      [c["kind"] for c in data["conflicts"]])

    def test_cap2_large_and_whole_group_round_feasible(self):
        """下界不是同组次数：21 人，3×7 与 1×21 两轮，cap=2 必须正常求解。

        回归：鸽笼判定把 ceil(min_j / g_i) 当成一对学员的跨轮同组次数，
        在 cap>=2 时误报 rotation_cap_capacity。
        """
        students = [{"id": "s%02d" % i, "name": "学员%02d" % i, "tags": []}
                    for i in range(21)]
        rotation = {
            "rounds": [
                {"numGroups": 3, "minSize": 7, "maxSize": 7},
                {"numGroups": 1, "minSize": 21, "maxSize": 21},
            ],
            "balanceTags": [], "cap": 2, "numPlans": 2,
        }
        res = self.client.post("/api/rotation/generate", json={
            "students": students, "relations": [], "rotation": rotation})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["conflicts"], [])
        self.assertTrue(data["plans"])
        for plan in data["plans"]:
            self.assertEqual([len(g) for g in plan["rounds"][0]], [7, 7, 7])
            self.assertEqual([len(g) for g in plan["rounds"][1]], [21])
            self.assertLessEqual(plan["maxRepeat"], 2)
            self.assertEqual(plan["capHits"], [])
            for groups in plan["rounds"]:
                flat = sorted(s for g in groups for s in g)
                self.assertEqual(flat, [s["id"] for s in students])

    def test_cap1_whole_group_round_still_conflicts(self):
        """同一 21 人配置 cap=1 时确实无解（一对在两轮都同组，重复 2 次）。"""
        students = [{"id": "s%02d" % i, "name": "学员%02d" % i, "tags": []}
                    for i in range(21)]
        rotation = {
            "rounds": [
                {"numGroups": 3, "minSize": 7, "maxSize": 7},
                {"numGroups": 1, "minSize": 21, "maxSize": 21},
            ],
            "balanceTags": [], "cap": 1, "numPlans": 2,
        }
        res = self.client.post("/api/rotation/generate", json={
            "students": students, "relations": [], "rotation": rotation})
        data = res.get_json()
        self.assertEqual(data["plans"], [])
        self.assertIn("rotation_cap_capacity",
                      [c["kind"] for c in data["conflicts"]])

    def test_forced_must_conflict_cross_flag(self):
        """全程必须同组（2 轮）与 cap=1 冲突，标记为跨轮冲突。"""
        rotation = {
            "rounds": [
                {"numGroups": 3, "minSize": 3, "maxSize": 5},
                {"numGroups": 3, "minSize": 3, "maxSize": 5},
            ],
            "balanceTags": [], "cap": 1, "numPlans": 2,
        }
        rels = [{"type": "must", "a": "s0", "b": "s3", "scope": "all"}]
        data = self.generate(rotation, rels)
        self.assertEqual(data["plans"], [])
        kind = next((c for c in data["conflicts"]
                     if c["kind"] == "rotation_cap_forced"), None)
        self.assertIsNotNone(kind)
        self.assertTrue(kind["cross"])

    def test_round_specific_conflict_has_round(self):
        """某一轮不可同组奇环无解时，冲突带具体轮次。"""
        # 取 5 人在第 2 轮（idx1）构成 C5 奇环，2 组 2~3 人
        five = self.students[:5]
        rels = [{"type": "cannot", "a": "s%d" % i,
                 "b": "s%d" % ((i + 1) % 5), "scope": {"rounds": [1]}}
                for i in range(5)]
        rotation = {
            "rounds": [
                {"numGroups": 2, "minSize": 2, "maxSize": 3},
                {"numGroups": 2, "minSize": 2, "maxSize": 3},
            ],
            "balanceTags": [], "cap": 2, "numPlans": 2,
        }
        # 总人数 5 人
        res = self.client.post("/api/rotation/generate", json={
            "students": five, "relations": rels, "rotation": rotation})
        data = res.get_json()
        self.assertEqual(data["plans"], [])
        odd = [c for c in data["conflicts"]
               if c["kind"] in ("cannot_odd_cycle", "cannot_uncolorable")]
        self.assertTrue(odd, [c["kind"] for c in data["conflicts"]])
        self.assertEqual(odd[0]["round"], 1)


class RotationResolveTest(unittest.TestCase):
    """多轮轮换：锁定后只重排后续轮次 + 影响/搭档变化。"""

    def setUp(self):
        self.client = app.test_client()
        self.students = [
            {"id": "s%d" % i, "name": "学员%d" % i, "tags": t}
            for i, t in enumerate([
                ["前端"], ["后端"], ["设计"], ["前端"], ["后端"], ["运维"],
                ["测试"], ["设计"], ["前端"], ["后端"], ["演讲"], ["测试"],
            ])]
        self.relations = [{"type": "cannot", "a": "s1", "b": "s4", "scope": "all"}]
        self.rotation = {
            "rounds": [
                {"numGroups": 3, "minSize": 3, "maxSize": 5},
                {"numGroups": 4, "minSize": 2, "maxSize": 4},
                {"numGroups": 3, "minSize": 3, "maxSize": 5},
            ],
            "balanceTags": ["前端"], "cap": 2, "numPlans": 3,
        }
        gen = self.client.post("/api/rotation/generate", json={
            "students": self.students, "relations": self.relations,
            "rotation": self.rotation}).get_json()
        self.assertEqual(gen["conflicts"], [])
        self.current = gen["plans"][0]["rounds"]

    def resolve(self, from_round, locks):
        return self.client.post("/api/rotation/resolve", json={
            "students": self.students, "relations": self.relations,
            "rotation": self.rotation, "currentRounds": self.current,
            "fromRound": from_round, "locks": locks}).get_json()

    def test_frozen_rounds_unchanged_and_locks_held(self):
        locked_sid = self.current[1][0][0]
        data = self.resolve(1, {1: {"members": [locked_sid], "groups": []}})
        self.assertEqual(data["conflicts"], [])
        payload = data["payload"]
        self.assertIsNotNone(payload)
        # 第 1 轮冻结不变
        self.assertEqual([sorted(x) for x in payload["rounds"][0]],
                         [sorted(x) for x in self.current[0]])
        # 锁定成员在第 2 轮位置不变
        def gid_of(rounds, ri, sid):
            return next(g for g, grp in enumerate(rounds[ri]) if sid in grp)
        self.assertEqual(gid_of(payload["rounds"], 1, locked_sid),
                         gid_of(self.current, 1, locked_sid))
        # 所有轮仍可行
        for ri, groups in enumerate(payload["rounds"]):
            rc = self.rotation["rounds"][ri]
            for grp in groups:
                self.assertTrue(rc["minSize"] <= len(grp) <= rc["maxSize"])
            gm = {member: gi for gi, grp in enumerate(groups) for member in grp}
            self.assertNotEqual(gm["s1"], gm["s4"])
        self.assertLessEqual(payload["metrics"]["maxRepeat"], 2)
        # 影响与搭档变化字段齐全
        self.assertIn("affectedCount", payload)
        self.assertEqual(len(payload["affected"]), payload["affectedCount"])
        self.assertIn("more", payload["repeatChanges"])
        self.assertIn("less", payload["repeatChanges"])

    def test_resolve_no_500_on_missing_rounds(self):
        """currentRounds 缺轮/为空时后端补全，不得 500。"""
        res = self.client.post("/api/rotation/resolve", json={
            "students": self.students, "relations": self.relations,
            "rotation": self.rotation, "currentRounds": [],
            "fromRound": 0, "locks": {}})
        self.assertEqual(res.status_code, 200)

    def test_resolve_from_first_round_preview_fields(self):
        """从第 1 轮（fromRound=0）重排：无冻结轮，预览依据字段正确。

        前端文案据此显示“将重排第 1～N 轮”，而不是“保持第 1～0 轮不变”。
        """
        data = self.resolve(0, {})
        self.assertEqual(data["conflicts"], [])
        payload = data["payload"]
        self.assertIsNotNone(payload)
        self.assertEqual(payload["fromRound"], 0)
        self.assertEqual(len(payload["rounds"]), 3)
        self.assertIn("affectedCount", payload)
        self.assertIn("repeatChanges", payload)
        for ri, groups in enumerate(payload["rounds"]):
            rc = self.rotation["rounds"][ri]
            for grp in groups:
                self.assertTrue(rc["minSize"] <= len(grp) <= rc["maxSize"])
        self.assertLessEqual(payload["metrics"]["maxRepeat"], 2)


class RotationSaveAndPrintTest(unittest.TestCase):
    """多轮结果随存档保存 + 按轮分页打印。"""

    def setUp(self):
        self.client = app.test_client()
        self.students = [
            {"id": "s%d" % i, "name": "学员%d" % i, "tags": t}
            for i, t in enumerate([["前端"], ["后端"], ["设计"], ["前端"],
                                   ["后端"], ["运维"], ["测试"], ["设计"]])]
        self.rotation = {
            "rounds": [
                {"numGroups": 2, "minSize": 3, "maxSize": 5},
                {"numGroups": 4, "minSize": 2, "maxSize": 3},
                {"numGroups": 2, "minSize": 3, "maxSize": 5},
            ],
            "balanceTags": ["前端"], "cap": 2, "numPlans": 2,
        }
        gen = self.client.post("/api/rotation/generate", json={
            "students": self.students, "relations": [],
            "rotation": self.rotation}).get_json()
        self.assertEqual(gen["conflicts"], [])
        self.plans = gen["plans"]

    def test_save_roundtrip_rotation(self):
        body = {
            "name": "轮换存档测试", "mode": "rotation",
            "students": self.students, "relations": [
                {"type": "must", "a": "s0", "b": "s3",
                 "scope": {"rounds": [0, 2]}}],
            "rotation": self.rotation, "plans": self.plans,
            "roundsWorking": self.plans[0]["rounds"],
            "roundLocks": {0: {"members": ["s0"], "groups": []}},
        }
        res = self.client.post("/api/saves", json=body)
        sid = res.get_json()["id"]
        got = self.client.get("/api/saves/" + sid).get_json()
        self.assertEqual(got["mode"], "rotation")
        self.assertEqual(len(got["rotation"]["rounds"]), 3)
        self.assertEqual(len(got["plans"]), len(self.plans))
        self.assertEqual(len(got["roundsWorking"]), 3)
        rel = got["relations"][0]
        self.assertEqual(rel["scope"], {"rounds": [0, 2]})
        self.client.delete("/api/saves/" + sid)

    def test_rotation_print_paginated(self):
        res = self.client.post("/api/prints", json={
            "mode": "rotation", "title": "多轮打印",
            "students": self.students,
            "rounds": self.plans[0]["rounds"],
            "roundNames": ["第 1 轮分组", "第 2 轮分组", "第 3 轮分组"],
        })
        pid = res.get_json()["id"]
        # 数据页含 3 个分页
        import json as _json, os
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "data", "prints", pid + ".json")
        with open(path, encoding="utf-8") as f:
            entry = _json.load(f)
        self.assertEqual(entry["mode"], "rotation")
        self.assertEqual(len(entry["pages"]), 3)
        # 打印视图渲染成功且每轮一节
        html = self.client.get("/print/" + pid + "?anon=1").get_data(as_text=True)
        self.assertEqual(html.count('class="page"'), 3)
        self.assertIn("第 2 轮分组", html)
        self.assertIn("成员01", html)


class RoleFillTest(unittest.TestCase):
    """角色轮值：补齐空缺、锁定保持、连续/累计上限、禁任与候选指标。"""

    def setUp(self):
        self.client = app.test_client()
        self.students = [
            {"id": "s%d" % i, "name": "学员%d" % i, "tags": t}
            for i, t in enumerate([["演讲"], ["记录"], ["演讲"], ["演讲"],
                                   ["记录"], ["演讲"], ["演讲"], []])]
        self.template = {
            "roles": [
                {"id": "host", "name": "主持", "perGroup": 1,
                 "tags": ["演讲"], "ban": []},
                {"id": "note", "name": "记录", "perGroup": 1,
                 "tags": [], "ban": []},
            ],
            "ncMode": "all", "ncPairs": [], "limits": {},
        }
        self.groups = [
            [["s0", "s1", "s2", "s3"], ["s4", "s5", "s6", "s7"]],
            [["s0", "s1", "s6", "s7"], ["s2", "s3", "s4", "s5"]],
        ]

    def fill(self, **kw):
        body = {"students": self.students, "template": self.template,
                "groups": self.groups, "assign": [], "locks": [],
                "numCandidates": 3}
        body.update(kw)
        res = self.client.post("/api/roles/fill", json=body)
        self.assertEqual(res.status_code, 200)
        return res.get_json()

    def test_basic_fill_no_vacancy_no_concurrent(self):
        data = self.fill()
        self.assertEqual(data["conflicts"], [])
        self.assertTrue(data["candidates"])
        tags_of = {s["id"]: s["tags"] for s in self.students}
        for c in data["candidates"]:
            m = c["metrics"]
            self.assertEqual(m["vacancies"], 0)
            self.assertEqual(m["concurrentViolations"], 0)
            self.assertEqual(m["qualViolations"], 0)
            for ri in range(2):
                for gi in range(2):
                    a = c["assign"][ri][gi]
                    self.assertEqual(len(a["host"]), 1)
                    self.assertEqual(len(a["note"]), 1)
                    # 不可兼任：同一人同轮不得同时担任两角色
                    self.assertNotEqual(a["host"][0], a["note"][0])
                    # 主持必须具备「演讲」标签
                    self.assertIn("演讲", tags_of[a["host"][0]])

    def test_locks_are_held(self):
        data = self.fill(locks=[{"round": 0, "group": 0,
                                 "role": "host", "member": "s0"}])
        self.assertEqual(data["conflicts"], [])
        self.assertTrue(data["candidates"])
        for c in data["candidates"]:
            self.assertEqual(c["assign"][0][0]["host"], ["s0"],
                             "锁定的主持安排必须保持不动")

    def test_cumulative_limit_respected(self):
        """累计上限 1 轮：4 个主持槽必须由 4 个不同人担任。"""
        tpl = json.loads(json.dumps(self.template))
        tpl["limits"] = {"host": {"maxConsecutive": 0, "maxTotal": 1}}
        data = self.fill(template=tpl)
        self.assertEqual(data["conflicts"], [])
        best = data["candidates"][0]
        self.assertEqual(best["metrics"]["limitViolations"], 0)
        hosts = [best["assign"][ri][gi]["host"][0]
                 for ri in range(2) for gi in range(2)]
        self.assertEqual(len(set(hosts)), len(hosts),
                         "累计上限 1 轮：同一人不得两轮都主持")

    def test_consecutive_limit_respected(self):
        """连续上限 1 轮：同一人不得相邻两轮都主持。"""
        tpl = json.loads(json.dumps(self.template))
        tpl["limits"] = {"host": {"maxConsecutive": 1, "maxTotal": 0}}
        data = self.fill(template=tpl)
        self.assertEqual(data["conflicts"], [])
        best = data["candidates"][0]
        self.assertEqual(best["metrics"]["limitViolations"], 0)
        for gi in range(2):
            h0 = best["assign"][0][gi]["host"][0]
            # 同一人在第 2 轮任何组主持都算连续（轮次相邻）
            h1 = {best["assign"][1][g]["host"][0] for g in range(2)}
            self.assertNotIn(h0, h1, "连续上限 1 轮被违反")

    def test_ban_respected(self):
        tpl = json.loads(json.dumps(self.template))
        tpl["roles"][1]["ban"] = ["s1"]
        data = self.fill(template=tpl)
        self.assertEqual(data["conflicts"], [])
        for c in data["candidates"]:
            for ri in range(2):
                for gi in range(2):
                    self.assertNotIn("s1", c["assign"][ri][gi].get("note", []),
                                     "禁任成员不得担任该角色")

    def test_pool_shortage_warns_but_fills(self):
        """合格人手不足：给出警告但仍返回候选（指标体现空缺/资格违规）。"""
        tpl = {"roles": [{"id": "host", "name": "主持", "perGroup": 1,
                          "tags": ["不存在的标签"], "ban": []}],
               "ncMode": "all", "ncPairs": [], "limits": {}}
        data = self.fill(template=tpl)
        self.assertEqual(data["conflicts"], [])
        self.assertTrue(data["warnings"])
        self.assertTrue(data["candidates"])
        m = data["candidates"][0]["metrics"]
        self.assertTrue(m["vacancies"] > 0 or m["qualViolations"] > 0)

    def test_invalid_lock_blocks(self):
        """锁定成员不在该组 → 阻断性冲突，不产出候选。"""
        data = self.fill(locks=[{"round": 0, "group": 0,
                                 "role": "host", "member": "s4"}])
        self.assertTrue(data["conflicts"])
        self.assertEqual(data["candidates"], [])
        kinds = [c["kind"] for c in data["conflicts"]]
        self.assertIn("role_lock_member", kinds)

    def test_concurrent_lock_conflict(self):
        """同一人同轮被锁定为两个不可兼任角色 → 锁定冲突。"""
        locks = [{"round": 0, "group": 0, "role": "host", "member": "s0"},
                 {"round": 0, "group": 0, "role": "note", "member": "s0"}]
        data = self.fill(locks=locks)
        kinds = [c["kind"] for c in data["conflicts"]]
        self.assertIn("role_lock_concurrent", kinds)
        self.assertEqual(data["candidates"], [])

    def test_banned_lock_conflict(self):
        tpl = json.loads(json.dumps(self.template))
        tpl["roles"][0]["ban"] = ["s0"]
        data = self.fill(template=tpl, locks=[
            {"round": 0, "group": 0, "role": "host", "member": "s0"}])
        kinds = [c["kind"] for c in data["conflicts"]]
        self.assertIn("role_lock_ban", kinds)

    def test_candidates_carry_comparison_metrics(self):
        """候选必须带齐对比指标：空缺/资格违规/角色重复/负担差异。"""
        data = self.fill()
        self.assertTrue(data["candidates"])
        for c in data["candidates"]:
            m = c["metrics"]
            for key in ("vacancies", "qualViolations", "roleRepeats",
                        "loadSpread", "concurrentViolations", "limitViolations"):
                self.assertIn(key, m)


class RoleSavePrintTest(unittest.TestCase):
    """角色方案随存档保存（旧存档兼容）+ 逐轮角色卡匿名打印。"""

    def setUp(self):
        self.client = app.test_client()
        self.students = [{"id": "s%d" % i, "name": "学员%d" % i, "tags": []}
                         for i in range(4)]
        self.roles_payload = {
            "template": {
                "roles": [{"id": "host", "name": "主持", "perGroup": 1,
                           "tags": [], "ban": []}],
                "ncMode": "all", "ncPairs": [],
                "limits": {"host": {"maxConsecutive": 1, "maxTotal": 0}},
            },
            "draft": {
                "sourceMode": "rotation", "fingerprint": "fp",
                "groups": [[["s0", "s1"], ["s2", "s3"]],
                           [["s0", "s2"], ["s1", "s3"]]],
                "roundNames": ["第 1 轮", "第 2 轮"],
                "assign": [[{"host": ["s0"]}, {"host": ["s2"]}],
                           [{"host": ["s0"]}, {"host": ["s1"]}]],
                "locks": [{"round": 0, "group": 0, "role": "host",
                           "member": "s0"}],
            },
            "versions": [{
                "id": "v1", "name": "版本 1", "createdAt": 1700000000,
                "sourceMode": "rotation",
                "template": {"roles": [{"id": "host", "name": "主持",
                                        "perGroup": 1, "tags": [], "ban": []}],
                             "ncMode": "all", "ncPairs": [], "limits": {}},
                "groups": [[["s0", "s1"], ["s2", "s3"]]],
                "roundNames": ["第 1 轮"],
                "assign": [[{"host": ["s0"]}, {"host": ["s2"]}]],
                "students": self.students,
            }],
        }

    def test_save_roundtrip_roles(self):
        res = self.client.post("/api/saves", json={
            "name": "角色存档", "mode": "rotation",
            "students": self.students, "relations": [],
            "rotation": {"rounds": [{"numGroups": 2, "minSize": 2, "maxSize": 2},
                                    {"numGroups": 2, "minSize": 2, "maxSize": 2}],
                         "balanceTags": [], "cap": 2, "numPlans": 1},
            "plans": [], "roundsWorking": None,
            "roles": self.roles_payload})
        self.assertEqual(res.status_code, 200)
        sid = res.get_json()["id"]
        got = self.client.get("/api/saves/" + sid).get_json()
        self.assertIn("roles", got)
        self.assertEqual(got["roles"]["template"]["roles"][0]["name"], "主持")
        self.assertEqual(got["roles"]["template"]["limits"]["host"]["maxConsecutive"], 1)
        draft = got["roles"]["draft"]
        self.assertEqual(len(draft["groups"]), 2)
        self.assertEqual(draft["locks"][0]["member"], "s0")
        self.assertEqual(draft["assign"][1][1]["host"], ["s1"])
        self.assertEqual(len(got["roles"]["versions"]), 1)
        ver = got["roles"]["versions"][0]
        self.assertEqual(ver["assign"][0][1]["host"], ["s2"])
        self.assertEqual(len(ver["students"]), 4)
        self.client.delete("/api/saves/" + sid)

    def test_old_save_without_roles_loads(self):
        """旧存档（无 roles 字段）仍可正常保存与读取。"""
        res = self.client.post("/api/saves", json={
            "name": "旧存档", "mode": "single",
            "students": self.students, "relations": [],
            "settings": {"numGroups": 2, "minSize": 2, "maxSize": 2},
            "solutions": [], "working": None})
        self.assertEqual(res.status_code, 200)
        sid = res.get_json()["id"]
        got = self.client.get("/api/saves/" + sid).get_json()
        self.assertEqual(got["name"], "旧存档")
        self.assertNotIn("roles", got)
        self.assertEqual(len(got["students"]), 4)
        self.client.delete("/api/saves/" + sid)

    def test_roles_print_pages(self):
        """roles 模式打印页：逐轮分页、角色行、匿名编号、空缺标注。"""
        res = self.client.post("/api/prints", json={
            "mode": "roles", "title": "角色轮值 · 版本 1",
            "students": self.students,
            "pages": [
                {"title": "第 1 轮 · 角色安排",
                 "groups": [
                     {"members": ["s0", "s1"],
                      "roles": [{"name": "主持", "people": ["s0"]}]},
                     {"members": ["s2", "s3"],
                      "roles": [{"name": "主持", "people": []}]}]},
                {"title": "第 2 轮 · 角色安排",
                 "groups": [
                     {"members": ["s0", "s2"],
                      "roles": [{"name": "主持", "people": ["s2"]}]},
                     {"members": ["s1", "s3"],
                      "roles": [{"name": "主持", "people": ["s3"]}]}]},
            ]})
        self.assertEqual(res.status_code, 200)
        pid = res.get_json()["id"]
        html = self.client.get("/print/" + pid + "?anon=1").get_data(as_text=True)
        self.assertEqual(html.count('class="page"'), 2)
        self.assertIn("主持", html)
        self.assertIn("成员01", html)   # 匿名编号
        self.assertIn("空缺", html)      # 无人担任的槽位
        self.assertIn("第 2 轮 · 角色安排", html)
        # 实名模式显示姓名
        html2 = self.client.get("/print/" + pid).get_data(as_text=True)
        self.assertIn("学员0", html2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

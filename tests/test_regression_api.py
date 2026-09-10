# -*- coding: utf-8 -*-
"""缺陷回归测试（API 级）。

覆盖：
1. “不可同组”奇环 + 2 组 → 判定无解，不输出不可行方案，给出人员与冲突链路；
2. 同一“必须同组”块被分裂锁定 → 局部重排报告冲突，不移动锁定成员；
3. 既有功能回归：正常生成、成员锁/整组锁在重排后保持不动。

运行：python3 tests/test_regression_api.py
"""
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


if __name__ == "__main__":
    unittest.main(verbosity=2)

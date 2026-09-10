/* ============ 约束分组排演台 · 前端逻辑 ============ */
"use strict";

/* ---------------- 全局状态 ---------------- */
const state = {
  mode: "single",       // 'single' | 'rotation'
  students: [],          // {id, name, tags:[]}
  relations: [],         // {id, type:'must'|'cannot', a, b, scope:'all'|{rounds:[0基]}}
  settings: { numGroups: 3, minSize: 3, maxSize: 6, balanceTags: [], numSolutions: 3 },
  solutions: [],         // 后端生成的单轮方案 [{groups, soft, metrics, hardOk}]
  current: -1,           // 当前采用的方案下标
  working: null,         // 当前编排 [[sid...], ...]
  locks: { members: new Set(), groups: new Set() },
  history: [],           // 撤销栈 [{groups, locks}]
  // 多轮轮换
  rotation: { rounds: [], balanceTags: [], cap: 2, maxCoverage: true, numPlans: 3 },
  plans: [],             // 后端生成的轮换方案 [{rounds, coverage, maxRepeat, ...}]
  planCur: -1,
  roundsWorking: null,   // [[[sid...]...]...R]
  activeRound: 0,
  roundLocks: [],        // 每轮 {members:Set, groups:Set}
  historyRot: [],        // 多轮撤销栈
  matrixSort: -1,        // 同伴矩阵排序学员下标（-1 名单顺序）
  seq: 1,                // id 计数器
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function uid(prefix) { return prefix + (state.seq++) + "_" + Math.random().toString(36).slice(2, 7); }
function nameOf(sid) { const s = state.students.find(x => x.id === sid); return s ? s.name : "?"; }
function studentOf(sid) { return state.students.find(x => x.id === sid); }
function numOf(sid) { const i = state.students.findIndex(x => x.id === sid); return i >= 0 ? String(i + 1).padStart(2, "0") : "??"; }
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

let toastTimer = null;
function toast(msg, isErr) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

async function api(url, method, body) {
  const opt = { method: method || "GET", headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(url, opt);
  if (!res.ok) throw new Error("请求失败：" + res.status);
  return res.json();
}

/* ---------------- 标签页切换 ---------------- */
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  $$(".tab").forEach(t => t.classList.toggle("active", t === btn));
  $$(".tabpane").forEach(p => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
  if (btn.dataset.tab === "compare") {
    if (state.mode === "rotation") renderRotCompare();
    else renderCompare();
  }
  if (btn.dataset.tab === "saves") renderSaves();
});

/* ================= 学员管理 ================= */
function addStudent(name, tags) {
  name = (name || "").trim();
  if (!name) { toast("请输入姓名", true); return false; }
  if (state.students.some(s => s.name === name)) { toast("已存在同名学员：" + name, true); return false; }
  const clean = [];
  (tags || []).forEach(t => { t = t.trim(); if (t && !clean.includes(t)) clean.push(t); });
  state.students.push({ id: uid("s"), name, tags: clean });
  return true;
}

$("#btn-add-student").addEventListener("click", () => {
  const ok = addStudent($("#stu-name").value, $("#stu-tags").value.split(/[,，]/));
  if (ok) { $("#stu-name").value = ""; $("#stu-tags").value = ""; $("#stu-name").focus(); renderRoster(); }
});
$("#stu-tags").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-add-student").click(); });

$("#btn-bulk-import").addEventListener("click", () => {
  const lines = $("#bulk-text").value.split("\n");
  let n = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\S+)\s*[，,]?\s*(.*)$/);
    if (!m) continue;
    const tags = m[2] ? m[2].split(/[,，、\s]+/).filter(Boolean) : [];
    if (addStudent(m[1], tags)) n++;
  }
  $("#bulk-text").value = "";
  renderRoster();
  toast("成功导入 " + n + " 名学员");
});

$("#btn-clear-students").addEventListener("click", () => {
  if (!state.students.length) return;
  if (!confirm("确定清空全部学员及其关系？")) return;
  state.students = [];
  state.relations = [];
  resetSolutions();
  renderRoster();
});

$("#btn-demo").addEventListener("click", () => {
  const demo = [
    ["林晓", "前端,演讲"], ["赵启铭", "后端,数据库"], ["孙悦", "设计,演讲"],
    ["周正", "前端,测试"], ["吴倩", "后端,运维"], ["郑好", "设计,文案"],
    ["冯远", "前端,动画"], ["褚燕", "测试,文档"], ["卫岚", "后端,数据库"],
    ["蒋涛", "运维,演讲"], ["沈心", "文案,设计"], ["韩立", "前端,测试"],
    ["杨帆", "后端,前端"], ["朱颜", "演讲,文案"], ["秦朗", "测试,运维"],
    ["尤莉", "设计,动画"], ["许强", "数据库,运维"], ["何静", "文案,演讲"],
  ];
  let n = 0;
  for (const [nm, tg] of demo) if (addStudent(nm, tg.split(","))) n++;
  // 示例关系
  const byName = (nm) => { const s = state.students.find(x => x.name === nm); return s ? s.id : null; };
  const rel = (a, b, type) => {
    const ia = byName(a), ib = byName(b);
    if (ia && ib) state.relations.push({ id: uid("r"), type, a: ia, b: ib });
  };
  rel("林晓", "冯远", "must");
  rel("赵启铭", "卫岚", "must");
  rel("蒋涛", "许强", "cannot");
  rel("孙悦", "尤莉", "cannot");
  state.settings.balanceTags = ["前端", "后端", "设计", "演讲"];
  renderRoster();
  renderSettings();
  toast("已填充 " + n + " 名示例学员与关系");
});

function deleteStudent(sid) {
  state.students = state.students.filter(s => s.id !== sid);
  state.relations = state.relations.filter(r => r.a !== sid && r.b !== sid);
  resetSolutions();
  renderRoster();
}

function renderRoster() {
  // 名单表格
  const tbody = $("#student-table tbody");
  tbody.innerHTML = "";
  state.students.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + String(i + 1).padStart(2, "0") + "</td>" +
      "<td>" + esc(s.name) + "</td>" +
      "<td>" + s.tags.map(t => '<span class="tag-chip">' + esc(t) + "</span>").join("") + "</td>" +
      '<td><button class="icon-btn" title="删除">✕</button></td>';
    tr.querySelector("button").addEventListener("click", () => deleteStudent(s.id));
    tbody.appendChild(tr);
  });
  $("#roster-count").textContent = "共 " + state.students.length + " 名学员 · 编号即投影页匿名编号";

  // 关系下拉
  for (const sel of [$("#rel-a"), $("#rel-b")]) {
    const keep = sel.value;
    sel.innerHTML = state.students.map(s => '<option value="' + s.id + '">' + esc(s.name) + "</option>").join("");
    sel.value = keep;
  }
  renderRelations();
  renderTagOptions();
  renderRotTagOptions();
  renderRelScopePickers();
}

/* ================= 关系管理 ================= */
function relIsActive(r, roundIdx) {
  if (state.mode === "single") return true;
  if (!r.scope || r.scope === "all") return true;
  return (r.scope.rounds || []).includes(roundIdx);
}

function scopeSummary(r) {
  if (state.mode === "single" || !r.scope || r.scope === "all") return "";
  const rs = r.scope.rounds || [];
  const R = state.rotation.rounds.length;
  if (!rs.length || rs.length >= R) return "";
  return rs.map(x => x + 1).join("、") + " 轮";
}

$("#btn-add-relation").addEventListener("click", () => {
  const a = $("#rel-a").value, b = $("#rel-b").value, type = $("#rel-type").value;
  if (!a || !b || a === b) { toast("请选择两名不同的学员", true); return; }
  const dup = state.relations.some(r =>
    (r.a === a && r.b === b) || (r.a === b && r.b === a));
  if (dup) { toast("两人之间已存在关系，请先删除旧关系", true); return; }
  let scope = "all";
  if (state.mode === "rotation") {
    const mode = ($$('input[name="rel-scope"]:checked')[0] || {}).value;
    if (mode === "rounds") {
      const picked = $$("#rel-scope-pickers .scope-chip.checked")
        .map(c => parseInt(c.dataset.round, 10));
      if (!picked.length) { toast("请选择该关系生效的轮次（或改为全程生效）", true); return; }
      scope = { rounds: picked.sort((x, y) => x - y) };
    }
  }
  state.relations.push({ id: uid("r"), type, a, b, scope });
  renderRelations();
});

function renderRelScopePickers() {
  const row = $("#rel-scope-row");
  const box = $("#rel-scope-pickers");
  const hint = $("#rel-scope-hint");
  if (state.mode !== "rotation") {
    row.classList.add("hidden");
    hint.classList.remove("hidden");
    return;
  }
  row.classList.remove("hidden");
  hint.classList.add("hidden");
  const mode = ($$('input[name="rel-scope"]:checked')[0] || {}).value || "all";
  box.innerHTML = "";
  state.rotation.rounds.forEach((r, i) => {
    const chip = document.createElement("span");
    chip.className = "scope-chip" + (mode === "rounds" ? "" : " disabled");
    chip.dataset.round = i;
    chip.textContent = "第" + (i + 1) + "轮";
    chip.addEventListener("click", () => {
      if (mode !== "rounds") return;
      chip.classList.toggle("checked");
    });
    box.appendChild(chip);
  });
  box.classList.toggle("hidden", mode !== "rounds");
}

$$('input[name="rel-scope"]').forEach(radio => {
  radio.addEventListener("change", renderRelScopePickers);
});

function cycleRelScope(relId) {
  if (state.mode !== "rotation") return;
  const r = state.relations.find(x => x.id === relId);
  if (!r) return;
  const R = state.rotation.rounds.length;
  const cur = (!r.scope || r.scope === "all") ? [] : (r.scope.rounds || []).slice();
  // 循环：全程 → 第1轮 → 前2轮 → … → 全部轮次（回到全程）
  let next;
  if (cur.length === 0) next = [0];
  else if (cur.length >= R) next = [0];
  else next = Array.from({ length: Math.min(cur.length + 1, R) }, (_, i) => i);
  r.scope = next.length >= R ? "all" : { rounds: next };
  renderRelations();
}

function renderRelations() {
  const ul = $("#relation-list");
  ul.innerHTML = "";
  if (!state.relations.length) {
    ul.innerHTML = '<li class="hint">暂无关系约束</li>';
    return;
  }
  for (const r of state.relations) {
    const li = document.createElement("li");
    const txt = scopeSummary(r);
    const scopeCls = (!r.scope || r.scope === "all") ? "all" : "partial";
    const scopeLabel = txt ? txt : "全程";
    li.innerHTML =
      '<span class="rel-badge ' + r.type + '">' + (r.type === "must" ? "必须同组" : "不可同组") + "</span>" +
      '<span class="rel-names">' + esc(nameOf(r.a)) + " ↔ " + esc(nameOf(r.b)) + "</span>" +
      (state.mode === "rotation"
        ? '<button class="rel-scope ' + scopeCls + '" title="点击切换生效轮次">' + esc(scopeLabel) + "</button>"
        : "") +
      '<button class="icon-btn" title="删除">✕</button>';
    const scopeBtn = li.querySelector(".rel-scope");
    if (scopeBtn) scopeBtn.addEventListener("click", () => cycleRelScope(r.id));
    li.querySelector(".icon-btn").addEventListener("click", () => {
      state.relations = state.relations.filter(x => x.id !== r.id);
      renderRelations();
    });
    ul.appendChild(li);
  }
}

/* ================= 分组设置 ================= */
function allTags() {
  const set = [];
  for (const s of state.students) for (const t of s.tags) if (!set.includes(t)) set.push(t);
  return set;
}

function renderTagOptions() {
  const box = $("#tag-options");
  const tags = allTags();
  if (!tags.length) {
    box.innerHTML = '<span class="hint">学员还没有技能标签</span>';
    return;
  }
  box.innerHTML = "";
  for (const t of tags) {
    const label = document.createElement("label");
    label.className = "tag-option" + (state.settings.balanceTags.includes(t) ? " checked" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.settings.balanceTags.includes(t);
    cb.addEventListener("change", () => {
      if (cb.checked) state.settings.balanceTags.push(t);
      else state.settings.balanceTags = state.settings.balanceTags.filter(x => x !== t);
      label.classList.toggle("checked", cb.checked);
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(t));
    box.appendChild(label);
  }
}

function renderRotTagOptions() {
  const box = $("#rot-tag-options");
  if (!box) return;
  const tags = allTags();
  if (!tags.length) {
    box.innerHTML = '<span class="hint">学员还没有技能标签</span>';
    return;
  }
  box.innerHTML = "";
  for (const t of tags) {
    const label = document.createElement("label");
    label.className = "tag-option" + (state.rotation.balanceTags.includes(t) ? " checked" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.rotation.balanceTags.includes(t);
    cb.addEventListener("change", () => {
      if (cb.checked) state.rotation.balanceTags.push(t);
      else state.rotation.balanceTags = state.rotation.balanceTags.filter(x => x !== t);
      label.classList.toggle("checked", cb.checked);
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(t));
    box.appendChild(label);
  }
}

/* ================= 模式切换 ================= */
$("#mode-switch").addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-btn");
  if (!btn) return;
  setMode(btn.dataset.mode);
});

function setMode(mode) {
  state.mode = mode;
  $$("#mode-switch .mode-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === mode));
  $("#single-settings").classList.toggle("hidden", mode !== "single");
  $("#rotation-settings").classList.toggle("hidden", mode !== "rotation");
  renderRelations();
  renderRelScopePickers();
  renderWorkbenchVisibility();
}

/* ================= 多轮轮换设置 ================= */
function defaultRoundRow() {
  return { numGroups: state.settings.numGroups || 3,
           minSize: state.settings.minSize || 3,
           maxSize: state.settings.maxSize || 6 };
}

function ensureRotationRounds(n) {
  while (state.rotation.rounds.length < n) state.rotation.rounds.push(defaultRoundRow());
  state.rotation.rounds.length = n;
  state.rotation.cap = Math.min(state.rotation.cap || 2, n);
  while (state.roundLocks.length < n) {
    state.roundLocks.push({ members: new Set(), groups: new Set() });
  }
  state.roundLocks.length = n;
}

function renderRotRoundsTable() {
  const tbody = $("#rot-rounds-table tbody");
  tbody.innerHTML = "";
  state.rotation.rounds.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>第 " + (i + 1) + " 轮</td>" +
      '<td><input type="number" min="1" max="26" data-k="numGroups" value="' + r.numGroups + '"></td>' +
      '<td><input type="number" min="0" max="99" data-k="minSize" value="' + r.minSize + '"></td>' +
      '<td><input type="number" min="1" max="99" data-k="maxSize" value="' + r.maxSize + '"></td>';
    tr.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("change", () => {
        let v = parseInt(inp.value, 10);
        if (!Number.isFinite(v)) return;
        v = Math.max(inp.min ? parseInt(inp.min, 10) : 0,
                     Math.min(inp.max ? parseInt(inp.max, 10) : 99, v));
        inp.value = v;
        state.rotation.rounds[i][inp.dataset.k] = v;
      });
    });
    tbody.appendChild(tr);
  });
}

$("#rot-rounds").addEventListener("change", () => {
  let n = parseInt($("#rot-rounds").value, 10) || 2;
  n = Math.max(2, Math.min(8, n));
  $("#rot-rounds").value = n;
  ensureRotationRounds(n);
  $("#rot-cap").max = n;
  if (state.rotation.cap > n) { state.rotation.cap = n; $("#rot-cap").value = n; }
  renderRotRoundsTable();
  renderRelScopePickers();
});
$("#rot-cap").addEventListener("change", () => {
  let v = parseInt($("#rot-cap").value, 10) || 1;
  const R = state.rotation.rounds.length;
  v = Math.max(1, Math.min(R, v));
  $("#rot-cap").value = v;
  state.rotation.cap = v;
});
$("#rot-plans").addEventListener("change", () => {
  state.rotation.numPlans = Math.max(1, Math.min(6, parseInt($("#rot-plans").value, 10) || 3));
});
$("#rot-max-coverage").addEventListener("change", (e) => {
  state.rotation.maxCoverage = e.target.checked;
});

function collectRotationSettings() {
  const R = Math.max(2, Math.min(8, parseInt($("#rot-rounds").value, 10) || 2));
  ensureRotationRounds(R);
  state.rotation.cap = Math.max(1, Math.min(R, parseInt($("#rot-cap").value, 10) || 1));
  state.rotation.numPlans = Math.max(1, Math.min(6, parseInt($("#rot-plans").value, 10) || 3));
  state.rotation.maxCoverage = $("#rot-max-coverage").checked;
}

function collectSettings() {
  state.settings.numGroups = parseInt($("#set-groups").value, 10) || 3;
  state.settings.minSize = parseInt($("#set-min").value, 10) || 0;
  state.settings.maxSize = parseInt($("#set-max").value, 10) || 6;
  state.settings.numSolutions = parseInt($("#set-solutions").value, 10) || 3;
}

function renderSettings() {
  $("#set-groups").value = state.settings.numGroups;
  $("#set-min").value = state.settings.minSize;
  $("#set-max").value = state.settings.maxSize;
  $("#set-solutions").value = state.settings.numSolutions;
  renderTagOptions();
  // 多轮轮换设置
  if (!state.rotation.rounds.length) ensureRotationRounds(3);
  $("#rot-rounds").value = state.rotation.rounds.length;
  $("#rot-cap").value = state.rotation.cap;
  $("#rot-cap").max = state.rotation.rounds.length;
  $("#rot-plans").value = state.rotation.numPlans;
  $("#rot-max-coverage").checked = state.rotation.maxCoverage;
  renderRotRoundsTable();
  renderRotTagOptions();
}

/* ================= 生成方案 ================= */
$("#btn-generate").addEventListener("click", async () => {
  if (state.mode === "rotation") { $("#btn-rot-generate").click(); return; }
  collectSettings();
  if (!state.students.length) { toast("请先录入学员", true); return; }
  const btn = $("#btn-generate");
  btn.disabled = true;
  btn.textContent = "求解中…";
  try {
    const data = await api("/api/generate", "POST", {
      students: state.students,
      relations: state.relations,
      settings: state.settings,
    });
    if (data.settings) state.settings = Object.assign(state.settings, data.settings);
    if (data.conflicts && data.conflicts.length) {
      renderConflicts(data.conflicts);
      resetSolutions();
      toast("发现 " + data.conflicts.length + " 处硬约束冲突", true);
    } else {
      $("#conflict-card").classList.add("hidden");
      state.solutions = data.solutions || [];
      state.current = state.solutions.length ? 0 : -1;
      state.history = [];
      state.locks = { members: new Set(), groups: new Set() };
      state.working = state.solutions.length ? cloneGroups(state.solutions[0].groups) : null;
      renderWorkbench();
      toast("已生成 " + state.solutions.length + " 个方案，请到「③ 排演台」查看");
      document.querySelector('.tab[data-tab="workbench"]').click();
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "生成方案";
  }
});

function buildConflictItem(c) {
  const div = document.createElement("div");
  div.className = "conflict-item";
  let tag = "";
  if (c.cross) tag = '<span class="round-tag cross">跨轮限制</span>';
  else if (Number.isInteger(c.round) && c.round >= 0)
    tag = '<span class="round-tag">第 ' + (c.round + 1) + " 轮</span>";
  let html = "<p>" + tag + esc(c.message) + "</p>";
  if (c.chain && c.chain.length) {
    // 冲突链路：A —必须→ B —不可→ C
    html += '<div class="chain">';
    const first = c.chain[0];
    html += '<span class="node">' + esc(nameOf(first.a)) + "</span>";
    for (const link of c.chain) {
      const label = link.type === "must" ? "必须同组" : "✕ 不可同组";
      html += '<span class="link ' + link.type + '">' + label + "</span>";
      html += '<span class="node">' + esc(nameOf(link.b)) + "</span>";
    }
    html += "</div>";
  } else if (c.people && c.people.length) {
    html += '<div class="people-chips">' +
      c.people.map(p => '<span class="node">' + esc(nameOf(p)) + "</span>").join("") + "</div>";
  }
  div.innerHTML = html;
  return div;
}

function renderConflicts(conflicts) {
  const card = $("#conflict-card");
  card.classList.remove("hidden");
  const box = $("#conflict-list");
  box.innerHTML = "";
  for (const c of conflicts) box.appendChild(buildConflictItem(c));
}

function renderWbConflicts(conflicts) {
  const card = $("#wb-conflict-card");
  card.classList.remove("hidden");
  const box = $("#wb-conflict-list");
  box.innerHTML = "";
  for (const c of conflicts) box.appendChild(buildConflictItem(c));
}

function resetSolutions() {
  state.solutions = [];
  state.current = -1;
  state.working = null;
  state.history = [];
  state.locks = { members: new Set(), groups: new Set() };
  renderWorkbench();
}

/* ================= 排演台 ================= */
function cloneGroups(g) { return g.map(x => x.slice()); }
function cloneLocks(l) { return { members: new Set(l.members), groups: new Set(l.groups) }; }

function pushHistory() {
  state.history.push({ groups: cloneGroups(state.working), locks: cloneLocks(state.locks) });
  if (state.history.length > 60) state.history.shift();
}

$("#btn-undo").addEventListener("click", () => {
  const prev = state.history.pop();
  if (!prev) { toast("没有可撤销的操作"); return; }
  state.working = prev.groups;
  state.locks = prev.locks;
  renderWorkbench();
  toast("已撤销");
});

$("#btn-clear-locks").addEventListener("click", () => {
  if (!state.locks.members.size && !state.locks.groups.size) return;
  pushHistory();
  state.locks = { members: new Set(), groups: new Set() };
  renderWorkbench();
});

$("#btn-resolve").addEventListener("click", async () => {
  if (!state.working) return;
  collectSettings();
  if (state.working.length !== state.settings.numGroups) {
    toast("当前编排的组数与设置不一致，请重新「生成方案」", true);
    return;
  }
  if (!state.locks.members.size && !state.locks.groups.size) {
    toast("请先锁定至少一名成员或一个整组，再局部重排", true);
    return;
  }
  try {
    const data = await api("/api/resolve", "POST", {
      students: state.students,
      relations: state.relations,
      settings: state.settings,
      groups: state.working,
      locks: { members: [...state.locks.members], groups: [...state.locks.groups] },
    });
    if (data.conflicts && data.conflicts.length) {
      renderWbConflicts(data.conflicts);
      toast(data.conflicts[0].message, true);
      return;
    }
    $("#wb-conflict-card").classList.add("hidden");
    pushHistory();
    state.working = cloneGroups(data.solution.groups);
    renderWorkbench();
    toast(data.solution.hardOk ? "已完成局部重排" : "已重排，但仍有硬约束未满足，请检查");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#btn-print").addEventListener("click", async () => {
  if (!state.working) return;
  try {
    const data = await api("/api/prints", "POST", {
      mode: "single",
      title: "分组结果",
      students: state.students,
      groups: state.working,
    });
    window.open("/print/" + data.id + "?anon=1", "_blank");
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- 本地即时校验 ---------- */
function validateGroups(groups, minSize, maxSize, rels) {
  const v = [];
  groups.forEach((grp, gi) => {
    if (grp.length < minSize)
      v.push({ type: "size", group: gi, people: [], message: "第 " + (gi + 1) + " 组 " + grp.length + " 人，少于下限 " + minSize + " 人" });
    if (grp.length > maxSize)
      v.push({ type: "size", group: gi, people: [], message: "第 " + (gi + 1) + " 组 " + grp.length + " 人，超出上限 " + maxSize + " 人" });
  });
  const groupOf = {};
  groups.forEach((grp, gi) => grp.forEach(sid => { groupOf[sid] = gi; }));
  for (const r of rels) {
    const ga = groupOf[r.a], gb = groupOf[r.b];
    if (ga === undefined || gb === undefined) continue;
    if (r.type === "cannot" && ga === gb)
      v.push({ type: "cannot", group: ga, people: [r.a, r.b], message: "「" + nameOf(r.a) + "」与「" + nameOf(r.b) + "」不可同组，却都在第 " + (ga + 1) + " 组" });
    if (r.type === "must" && ga !== gb)
      v.push({ type: "must", group: -1, people: [r.a, r.b], message: "「" + nameOf(r.a) + "」（第 " + (ga + 1) + " 组）与「" + nameOf(r.b) + "」（第 " + (gb + 1) + " 组）必须同组" });
  }
  return v;
}

function validateWorking() {
  if (!state.working) return [];
  const { minSize, maxSize } = state.settings;
  return validateGroups(state.working, minSize, maxSize, state.relations);
}

/* 软约束报告（与后端 evaluate_solution 同规则） */
function softReportGroups(groups, tags, settingsNumGroups) {
  const g = groups.length;
  const total = groups.reduce((s, x) => s + x.length, 0);
  const ideal = total / g;
  const items = [];
  const lo = Math.floor(ideal), hi = Math.ceil(ideal);
  groups.forEach((grp, gi) => {
    if (grp.length < lo || grp.length > hi)
      items.push({ warn: true, message: "第 " + (gi + 1) + " 组 " + grp.length + " 人，偏离均衡值 " + ideal.toFixed(1) + " 人" });
  });
  const tagsOf = {};
  state.students.forEach(s => { tagsOf[s.id] = new Set(s.tags); });
  for (const tag of tags) {
    const counts = groups.map(grp => grp.filter(sid => (tagsOf[sid] || new Set()).has(tag)).length);
    const mean = counts.reduce((a, b) => a + b, 0) / g;
    const tlo = Math.floor(mean), thi = Math.ceil(mean);
    counts.forEach((c, gi) => {
      if (c < tlo || c > thi)
        items.push({ warn: true, message: "第 " + (gi + 1) + " 组标签「" + tag + "」为 " + c + " 人，偏离均衡值 " + mean.toFixed(1) + " 人" });
    });
  }
  return items;
}

function softReport() {
  if (!state.working) return [];
  return softReportGroups(state.working, state.settings.balanceTags);
}

/* ---------- 渲染排演台 ---------- */
function renderWorkbenchVisibility() {
  const rot = state.mode === "rotation" && state.roundsWorking;
  const single = state.mode === "single" && !!state.working;
  // 单轮：无方案时显示空提示；有方案显示排演台。轮换模式下单轮区整体隐藏。
  $("#wb-empty").classList.toggle("hidden", single || state.mode === "rotation");
  $("#wb-main").classList.toggle("hidden", !single);
  $("#rot-empty").classList.toggle("hidden", rot || state.mode === "single");
  $("#rot-main").classList.toggle("hidden", !rot);
}

function renderWorkbench() {
  const has = !!state.working;
  renderWorkbenchVisibility();
  $("#wb-conflict-card").classList.add("hidden");  // 编排/锁定已变化，旧的冲突报告失效
  if (state.mode === "rotation") { renderRotWorkbench(); return; }
  if (!has) return;

  // 方案页签
  const tabs = $("#sol-tabs");
  tabs.innerHTML = "";
  state.solutions.forEach((sol, i) => {
    const b = document.createElement("button");
    b.className = "sol-tab" + (i === state.current ? " active" : "");
    const n = sol.soft.length;
    b.innerHTML = "方案 " + (i + 1) +
      '<span class="badge ' + (n === 0 ? "ok" : "warn") + '">' + (n === 0 ? "软约束全满足" : n + " 项未满足") + "</span>";
    b.addEventListener("click", () => {
      state.current = i;
      state.working = cloneGroups(sol.groups);
      state.locks = { members: new Set(), groups: new Set() };
      state.history = [];
      renderWorkbench();
    });
    tabs.appendChild(b);
  });

  // 校验与状态
  const violations = validateWorking();
  const badGroups = new Set(), badPeople = new Set();
  violations.forEach(v => {
    if (v.group >= 0) {
      badGroups.add(v.group);
      // 人数越界时，该组全部成员芯片标红（与关系违规一致）
      if (v.type === "size" && state.working[v.group]) {
        state.working[v.group].forEach(p => badPeople.add(p));
      }
    }
    v.people.forEach(p => badPeople.add(p));
  });
  const vs = $("#violation-summary");
  if (violations.length) {
    vs.textContent = "⚠ " + violations.length + " 处硬约束违规";
    vs.className = "bad";
  } else {
    vs.textContent = "✓ 硬约束全部满足";
    vs.className = "ok";
  }
  const lk = [];
  if (state.locks.members.size) lk.push(state.locks.members.size + " 名成员已锁定");
  if (state.locks.groups.size) lk.push(state.locks.groups.size + " 个整组已锁定");
  $("#lock-summary").textContent = lk.length ? "🔒 " + lk.join("，") : "未锁定任何成员";

  // 组卡片
  const grid = $("#groups-grid");
  grid.innerHTML = "";
  const { minSize, maxSize } = state.settings;
  state.working.forEach((grp, gi) => {
    const card = document.createElement("div");
    card.className = "group-card";
    if (state.locks.groups.has(gi)) card.classList.add("locked");
    if (badGroups.has(gi)) card.classList.add("violating");
    card.dataset.group = gi;

    const sizeOk = grp.length >= minSize && grp.length <= maxSize;
    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML =
      "<h3>第 " + (gi + 1) + " 组</h3>" +
      '<span class="group-size' + (sizeOk ? "" : " over") + '">' + grp.length + " / " + minSize + "–" + maxSize + " 人</span>" +
      '<button class="group-lock" title="' + (state.locks.groups.has(gi) ? "解锁整组" : "锁定整组") + '">' +
      (state.locks.groups.has(gi) ? "🔒" : "🔓") + "</button>";
    head.querySelector(".group-lock").addEventListener("click", () => {
      pushHistory();
      if (state.locks.groups.has(gi)) state.locks.groups.delete(gi);
      else state.locks.groups.add(gi);
      renderWorkbench();
    });
    card.appendChild(head);

    const area = document.createElement("div");
    area.className = "member-area";
    if (!grp.length) area.innerHTML = '<span class="group-empty">拖拽成员到这里</span>';
    for (const sid of grp) {
      area.appendChild(renderMemberChip(sid, badPeople.has(sid)));
    }
    card.appendChild(area);

    // 拖放目标
    card.addEventListener("dragover", (e) => {
      if (state.locks.groups.has(gi)) return;
      e.preventDefault();
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      if (state.locks.groups.has(gi)) { toast("第 " + (gi + 1) + " 组已整组锁定", true); return; }
      const sid = e.dataTransfer.getData("text/plain");
      if (sid) moveMember(sid, gi);
    });

    grid.appendChild(card);
  });

  // 违规列表
  const vl = $("#violation-list");
  vl.innerHTML = violations.length
    ? violations.map(v => '<li class="bad">✕ ' + esc(v.message) + "</li>").join("")
    : '<li class="ok">✓ 人数范围与同组关系均满足</li>';

  // 软约束报告
  const soft = softReport();
  const sl = $("#soft-list");
  sl.innerHTML = soft.length
    ? soft.map(x => '<li class="warn">△ ' + esc(x.message) + "</li>").join("")
    : '<li class="ok">✓ 软约束全部满足（人数与标签均衡）</li>';
}

function renderMemberChip(sid, violating) {
  const s = studentOf(sid);
  if (!s) {  // 数据异常时占位，避免整页渲染中断
    const ph = document.createElement("span");
    ph.className = "member-chip violating";
    ph.textContent = "未知成员";
    return ph;
  }
  const chip = document.createElement("span");
  const locked = state.locks.members.has(sid);
  chip.className = "member-chip" + (locked ? " locked" : "") + (violating ? " violating" : "");
  chip.draggable = !locked;
  chip.dataset.sid = sid;
  chip.title = "编号 " + numOf(sid) + (s.tags.length ? " · " + s.tags.join("、") : "");
  chip.innerHTML =
    "<span>" + esc(s.name) + "</span>" +
    (s.tags.length ? '<span class="m-tags">' + esc(s.tags.slice(0, 2).join("/")) + "</span>" : "") +
    '<button class="m-lock" title="' + (locked ? "解锁成员" : "锁定成员") + '">' + (locked ? "🔒" : "🔓") + "</button>";
  chip.querySelector(".m-lock").addEventListener("click", (e) => {
    e.stopPropagation();
    pushHistory();
    if (state.locks.members.has(sid)) state.locks.members.delete(sid);
    else state.locks.members.add(sid);
    renderWorkbench();
  });
  chip.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", sid);
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => chip.classList.add("dragging"), 0);
  });
  chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  return chip;
}

function moveMember(sid, targetGi) {
  if (state.locks.members.has(sid)) { toast("该成员已锁定", true); return; }
  const fromGi = state.working.findIndex(g => g.includes(sid));
  if (fromGi === -1 || fromGi === targetGi) return;
  pushHistory();
  state.working[fromGi] = state.working[fromGi].filter(x => x !== sid);
  state.working[targetGi].push(sid);
  renderWorkbench();
  const violations = validateWorking();
  const fresh = violations.filter(v =>
    v.group === targetGi || v.group === fromGi || v.people.includes(sid));
  if (fresh.length) toast("⚠ " + fresh[0].message, true);
}

/* ================= 方案对比 ================= */
function renderCompare() {
  const has = state.solutions.length > 0;
  $("#cmp-empty").classList.toggle("hidden", has);
  $("#cmp-main").classList.toggle("hidden", !has);
  if (!has) return;

  const sols = state.solutions;
  const tags = state.settings.balanceTags;
  const bestSoft = Math.min(...sols.map(s => s.metrics.softCount));
  const bestSpread = Math.min(...sols.map(s => s.metrics.spread));

  let html = "<thead><tr><th>指标</th>";
  sols.forEach((s, i) => { html += "<th>方案 " + (i + 1) + "</th>"; });
  html += "</tr></thead><tbody>";

  // 各组人数（迷你柱状图）
  html += "<tr><td>各组人数</td>";
  sols.forEach(s => {
    const max = Math.max(...s.metrics.sizes, 1);
    html += "<td>" + s.metrics.sizes.join(" / ") +
      '<div class="mini-bars">' +
      s.metrics.sizes.map(n =>
        '<div class="mini-bar" style="height:' + Math.round(n / max * 30 + 4) + 'px"><span>' + n + "</span></div>"
      ).join("") + "</div></td>";
  });
  html += "</tr>";

  // 人数极差
  html += "<tr><td>人数极差</td>";
  sols.forEach(s => {
    const cls = s.metrics.spread === bestSpread ? "cmp-best" : "cmp-worst";
    html += '<td class="' + cls + '">' + s.metrics.spread + "</td>";
  });
  html += "</tr>";

  // 每个均衡标签的覆盖
  for (const tag of tags) {
    html += "<tr><td>标签「" + esc(tag) + "」分布</td>";
    sols.forEach(s => {
      const st = s.metrics.tags[tag];
      if (!st) { html += "<td>—</td>"; return; }
      html += "<td>" + st.counts.join(" / ") +
        '<br><span class="hint-inline">覆盖 ' + st.covered + "/" + s.metrics.sizes.length + " 组</span></td>";
    });
    html += "</tr>";
  }

  // 软约束
  html += "<tr><td>未满足软约束</td>";
  sols.forEach(s => {
    const n = s.metrics.softCount;
    const cls = n === bestSoft ? "cmp-best" : "cmp-worst";
    html += '<td class="' + cls + '">' + n + " 项</td>";
  });
  html += "</tr>";

  html += "<tr><td>软约束明细</td>";
  sols.forEach(s => {
    html += "<td>" + (s.soft.length
      ? s.soft.map(x => "△ " + esc(x.message)).join("<br>")
      : '<span class="cmp-best">✓ 全部满足</span>') + "</td>";
  });
  html += "</tr>";

  // 采用按钮
  html += "<tr><td>操作</td>";
  sols.forEach((s, i) => {
    html += '<td><button class="btn" data-idx="' + i + '">在排演台打开</button></td>';
  });
  html += "</tr></tbody>";

  const table = $("#cmp-table");
  table.innerHTML = html;
  table.querySelectorAll("button[data-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.idx, 10);
      state.current = i;
      state.working = cloneGroups(state.solutions[i].groups);
      state.locks = { members: new Set(), groups: new Set() };
      state.history = [];
      renderWorkbench();
      document.querySelector('.tab[data-tab="workbench"]').click();
    });
  });
}

/* ================= 存档 ================= */
$("#btn-save").addEventListener("click", async () => {
  if (!state.students.length) { toast("没有可保存的内容", true); return; }
  const name = $("#save-name").value.trim() ||
    "方案 " + new Date().toLocaleString("zh-CN", { hour12: false });
  try {
    const payload = {
      name,
      mode: state.mode,
      students: state.students,
      relations: state.relations,
      settings: state.settings,
      solutions: state.solutions,
      working: state.working,
      locks: { members: [...state.locks.members], groups: [...state.locks.groups] },
    };
    if (state.mode === "rotation") {
      payload.rotation = state.rotation;
      payload.plans = state.plans;
      payload.roundsWorking = state.roundsWorking;
      payload.roundLocks = roundLocksSerialize();
    }
    await api("/api/saves", "POST", payload);
    $("#save-name").value = "";
    toast("已保存：" + name);
    renderSaves();
  } catch (err) {
    toast(err.message, true);
  }
});

async function renderSaves() {
  const tbody = $("#saves-table tbody");
  tbody.innerHTML = '<tr><td colspan="6" class="hint">加载中…</td></tr>';
  try {
    const data = await api("/api/saves");
    tbody.innerHTML = "";
    if (!data.saves.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="hint">暂无存档</td></tr>';
      return;
    }
    for (const sv of data.saves) {
      const tr = document.createElement("tr");
      const time = new Date(sv.createdAt * 1000).toLocaleString("zh-CN", { hour12: false });
      const modeBadge = sv.mode === "rotation"
        ? '<span class="mode-badge rotation">多轮' + (sv.roundCount ? "·" + sv.roundCount + "轮" : "") + "</span>"
        : '<span class="mode-badge single">单轮</span>';
      tr.innerHTML =
        "<td>" + esc(sv.name) + "</td><td>" + modeBadge + "</td><td>" + time + "</td>" +
        "<td>" + sv.studentCount + "</td><td>" + sv.solutionCount + "</td>" +
        '<td><button class="btn" data-act="load">恢复</button> ' +
        '<button class="btn ghost danger" data-act="del">删除</button></td>';
      tr.querySelector('[data-act="load"]').addEventListener("click", () => loadSave(sv.id));
      tr.querySelector('[data-act="del"]').addEventListener("click", async () => {
        if (!confirm("删除存档「" + sv.name + "」？")) return;
        await api("/api/saves/" + sv.id, "DELETE");
        renderSaves();
        toast("已删除");
      });
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="hint">加载失败</td></tr>';
  }
}

async function loadSave(id) {
  try {
    const data = await api("/api/saves/" + id);
    state.students = data.students || [];
    state.relations = (data.relations || []).map(r => ({
      id: uid("r"), type: r.type, a: r.a, b: r.b,
      scope: r.scope || "all",
    }));
    state.settings = Object.assign(state.settings, data.settings || {});
    state.solutions = data.solutions || [];
    state.current = state.solutions.length ? 0 : -1;
    state.working = data.working ? cloneGroups(data.working)
      : (state.solutions.length ? cloneGroups(state.solutions[0].groups) : null);
    const lk = data.locks || {};
    state.locks = {
      members: new Set(lk.members || []),
      groups: new Set(lk.groups || []),
    };
    state.history = [];

    if (data.mode === "rotation" && data.rotation) {
      setMode("rotation");
      state.rotation = data.rotation;
      state.plans = data.plans || [];
      state.planCur = state.plans.length ? 0 : -1;
      state.roundsWorking = data.roundsWorking
        ? data.roundsWorking.map(g => cloneGroups(g))
        : (state.plans.length ? state.plans[0].rounds.map(g => cloneGroups(g)) : null);
      const R = state.rotation.rounds.length;
      const rl = data.roundLocks || {};
      state.roundLocks = Array.from({ length: R }, (_, i) => ({
        members: new Set((rl[i] || rl[String(i)] || {}).members || []),
        groups: new Set((rl[i] || rl[String(i)] || {}).groups || []),
      }));
      state.activeRound = 0;
      state.historyRot = [];
    } else {
      setMode("single");
    }
    renderRoster();
    renderSettings();
    renderWorkbench();
    toast("已恢复存档：" + data.name);
    document.querySelector('.tab[data-tab="workbench"]').click();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================= 多轮轮换 ================= */
function cloneRounds(r) { return r.map(g => cloneGroups(g)); }
function roundLocksSerialize() {
  const out = {};
  state.roundLocks.forEach((lk, i) => {
    if (lk.members.size || lk.groups.size)
      out[i] = { members: [...lk.members], groups: [...lk.groups] };
  });
  return out;
}
function roundLocksOf(ri) {
  if (!state.roundLocks[ri]) state.roundLocks[ri] = { members: new Set(), groups: new Set() };
  return state.roundLocks[ri];
}
function pushHistoryRot() {
  state.historyRot.push({
    rounds: cloneRounds(state.roundsWorking),
    locks: state.roundLocks.map(l => ({ members: new Set(l.members), groups: new Set(l.groups) })),
    activeRound: state.activeRound,
  });
  if (state.historyRot.length > 60) state.historyRot.shift();
}

/* 同伴矩阵（前端按当前编排即时计算） */
function computePairMatrix() {
  const ids = state.students.map(s => s.id);
  const pos = {};
  ids.forEach((id, i) => { pos[id] = i; });
  const n = ids.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) m[i][i] = -1;
  for (const groups of state.roundsWorking) {
    for (const grp of groups) {
      for (let x = 0; x < grp.length; x++) {
        for (let y = x + 1; y < grp.length; y++) {
          const a = pos[grp[x]], b = pos[grp[y]];
          m[a][b]++; m[b][a]++;
        }
      }
    }
  }
  return m;
}

function rotationStats() {
  const m = computePairMatrix();
  const n = state.students.length;
  let covered = 0, maxRepeat = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (m[i][j] > 0) covered++;
      if (m[i][j] > maxRepeat) maxRepeat = m[i][j];
    }
  const total = n * (n - 1) / 2;
  const cap = state.rotation.cap;
  const capHits = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (m[i][j] > cap) capHits.push({ a: state.students[i].id, b: state.students[j].id, count: m[i][j] });
  capHits.sort((x, y) => y.count - x.count);
  return { matrix: m, coverage: total ? covered / total : 1, covered, total, maxRepeat, capHits };
}

/* ---------- 生成轮换方案 ---------- */
$("#btn-rot-generate").addEventListener("click", async () => {
  collectRotationSettings();
  if (!state.students.length) { toast("请先录入学员", true); return; }
  // 前端快速预检：各轮容量
  const n = state.students.length;
  for (let i = 0; i < state.rotation.rounds.length; i++) {
    const r = state.rotation.rounds[i];
    if (n < r.numGroups * r.minSize || n > r.numGroups * r.maxSize) {
      toast("第 " + (i + 1) + " 轮的组数与人数范围无法容纳 " + n + " 名学员", true);
      return;
    }
  }
  const btn = $("#btn-rot-generate");
  btn.disabled = true;
  btn.textContent = "轮换求解中…";
  try {
    const data = await api("/api/rotation/generate", "POST", {
      students: state.students,
      relations: state.relations,
      rotation: {
        rounds: state.rotation.rounds,
        balanceTags: state.rotation.balanceTags,
        cap: state.rotation.cap,
        maxCoverage: state.rotation.maxCoverage,
        numPlans: state.rotation.numPlans,
      },
    });
    if (data.rotation) state.rotation = Object.assign(state.rotation, data.rotation);
    if (data.conflicts && data.conflicts.length) {
      renderConflicts(data.conflicts);
      state.plans = [];
      state.planCur = -1;
      state.roundsWorking = null;
      renderWorkbenchVisibility();
      toast("发现 " + data.conflicts.length + " 处冲突，无法生成轮换方案", true);
    } else {
      $("#conflict-card").classList.add("hidden");
      state.plans = data.plans || [];
      state.planCur = state.plans.length ? 0 : -1;
      state.roundsWorking = state.plans.length ? cloneRounds(state.plans[0].rounds) : null;
      const R = state.rotation.rounds.length;
      state.roundLocks = Array.from({ length: R }, () => ({ members: new Set(), groups: new Set() }));
      state.activeRound = 0;
      state.historyRot = [];
      renderWorkbench();
      toast("已生成 " + state.plans.length + " 套完整轮换方案");
      document.querySelector('.tab[data-tab="workbench"]').click();
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "一次生成完整轮换方案";
  }
});

/* ---------- 多轮换台渲染 ---------- */
function renderRotWorkbench() {
  const has = !!state.roundsWorking;
  // 显隐统一交给 renderWorkbenchVisibility（按模式 + 是否有方案），这里只做早退，
  // 避免在单轮模式/空状态下把已隐藏的面板重新显示或访问不存在的元素。
  renderWorkbenchVisibility();
  if (!has) return;
  $("#rot-conflict-card").classList.add("hidden");

  // 方案页签
  const tabs = $("#rot-plan-tabs");
  tabs.innerHTML = "";
  state.plans.forEach((p, i) => {
    const b = document.createElement("button");
    b.className = "sol-tab" + (i === state.planCur ? " active" : "");
    b.innerHTML = "方案 " + (i + 1) +
      '<span class="badge ' + (p.maxRepeat <= state.rotation.cap ? "ok" : "warn") + '">' +
      "覆盖 " + Math.round(p.coverage * 100) + "% · 重复≤" + p.maxRepeat + "</span>";
    b.addEventListener("click", () => {
      state.planCur = i;
      state.roundsWorking = cloneRounds(p.rounds);
      state.roundLocks = state.roundLocks.map(() => ({ members: new Set(), groups: new Set() }));
      state.activeRound = 0;
      state.historyRot = [];
      renderRotWorkbench();
    });
    tabs.appendChild(b);
  });

  // 轮次页签
  const rt = $("#round-tabs");
  rt.innerHTML = "";
  state.roundsWorking.forEach((groups, ri) => {
    const b = document.createElement("button");
    const lk = roundLocksOf(ri);
    b.className = "round-tab" + (ri === state.activeRound ? " active" : "");
    if (lk.members.size || lk.groups.size) b.classList.add("frozen");
    const rc = state.rotation.rounds[ri];
    b.innerHTML = "第 " + (ri + 1) + " 轮" +
      '<span class="rt-meta">' + rc.numGroups + " 组 · " + rc.minSize + "–" + rc.maxSize + " 人</span>";
    b.addEventListener("click", () => { state.activeRound = ri; renderRotWorkbench(); });
    rt.appendChild(b);
  });
  $("#rot-resolve-label").textContent = (state.activeRound + 1) + " 轮";

  renderRotRoundCards();
  renderRotStatusAndMatrix();
}

function renderRotRoundCards() {
  const ri = state.activeRound;
  const groups = state.roundsWorking[ri];
  const rc = state.rotation.rounds[ri];
  const lk = roundLocksOf(ri);
  const rels = state.relations.filter(r => relIsActive(r, ri));
  const violations = validateGroups(groups, rc.minSize, rc.maxSize, rels);
  const badGroups = new Set(), badPeople = new Set();
  violations.forEach(v => {
    if (v.group >= 0) {
      badGroups.add(v.group);
      if (v.type === "size" && groups[v.group]) groups[v.group].forEach(p => badPeople.add(p));
    }
    v.people.forEach(p => badPeople.add(p));
  });

  const grid = $("#rot-groups-grid");
  grid.innerHTML = "";
  groups.forEach((grp, gi) => {
    const card = document.createElement("div");
    card.className = "group-card";
    if (lk.groups.has(gi)) card.classList.add("locked");
    if (badGroups.has(gi)) card.classList.add("violating");
    card.dataset.group = gi;

    const sizeOk = grp.length >= rc.minSize && grp.length <= rc.maxSize;
    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML =
      "<h3>第 " + (gi + 1) + " 组</h3>" +
      '<span class="group-size' + (sizeOk ? "" : " over") + '">' +
      grp.length + " / " + rc.minSize + "–" + rc.maxSize + " 人</span>" +
      '<button class="group-lock" title="' + (lk.groups.has(gi) ? "解锁整组" : "锁定整组") + '">' +
      (lk.groups.has(gi) ? "🔒" : "🔓") + "</button>";
    head.querySelector(".group-lock").addEventListener("click", () => {
      pushHistoryRot();
      if (lk.groups.has(gi)) lk.groups.delete(gi);
      else lk.groups.add(gi);
      renderRotWorkbench();
    });
    card.appendChild(head);

    const area = document.createElement("div");
    area.className = "member-area";
    if (!grp.length) area.innerHTML = '<span class="group-empty">拖拽成员到这里</span>';
    for (const sid of grp) area.appendChild(renderRotMemberChip(sid, ri, badPeople.has(sid)));
    card.appendChild(area);

    card.addEventListener("dragover", (e) => {
      if (lk.groups.has(gi)) return;
      e.preventDefault();
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      if (lk.groups.has(gi)) { toast("第 " + (gi + 1) + " 组已整组锁定", true); return; }
      const sid = e.dataTransfer.getData("text/plain");
      const srcRound = parseInt(e.dataTransfer.getData("x-round"), 10);
      if (Number.isInteger(srcRound) && srcRound !== ri) {
        toast("成员只能在同一轮的组间拖动", true);
        return;
      }
      if (sid) moveRotMember(sid, ri, gi);
    });
    grid.appendChild(card);
  });

  // 本轮违规列表
  const vl = $("#rot-violation-list");
  vl.innerHTML = violations.length
    ? violations.map(v => '<li class="bad">✕ ' + esc(v.message) + "</li>").join("")
    : '<li class="ok">✓ 本轮人数范围与生效关系均满足</li>';
}

function renderRotMemberChip(sid, ri, violating) {
  const s = studentOf(sid);
  const lk = roundLocksOf(ri);
  const chip = document.createElement("span");
  if (!s) {
    chip.className = "member-chip violating";
    chip.textContent = "未知成员";
    return chip;
  }
  const locked = lk.members.has(sid);
  chip.className = "member-chip" + (locked ? " locked" : "") + (violating ? " violating" : "");
  chip.draggable = !locked;
  chip.dataset.sid = sid;
  chip.title = "编号 " + numOf(sid) + (s.tags.length ? " · " + s.tags.join("、") : "");
  chip.innerHTML =
    "<span>" + esc(s.name) + "</span>" +
    (s.tags.length ? '<span class="m-tags">' + esc(s.tags.slice(0, 2).join("/")) + "</span>" : "") +
    '<button class="m-lock" title="' + (locked ? "解锁成员" : "锁定成员") + '">' + (locked ? "🔒" : "🔓") + "</button>";
  chip.querySelector(".m-lock").addEventListener("click", (e) => {
    e.stopPropagation();
    pushHistoryRot();
    if (lk.members.has(sid)) lk.members.delete(sid);
    else lk.members.add(sid);
    renderRotWorkbench();
  });
  chip.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", sid);
    e.dataTransfer.setData("x-round", String(ri));
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => chip.classList.add("dragging"), 0);
  });
  chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  return chip;
}

/* 把当前方案（state.plans[planCur]）同步为实时编排结果：
   拖动调整后，页签徽章与该方案的 rounds/指标都按当前分组重算。 */
function syncCurrentPlanLive() {
  if (state.planCur < 0 || !state.plans[state.planCur] || !state.roundsWorking) return;
  const p = state.plans[state.planCur];
  p.rounds = cloneRounds(state.roundsWorking);
  const stats = rotationStats();
  p.coverage = stats.coverage;
  p.coveredPairs = stats.covered;
  p.totalPairs = stats.total;
  p.maxRepeat = stats.maxRepeat;
  p.capHits = stats.capHits;
  const tagsOf = {};
  state.students.forEach(s => { tagsOf[s.id] = new Set(s.tags); });
  p.tagDeviation = state.roundsWorking.map((groups, ri) => {
    const tags = {};
    for (const tag of state.rotation.balanceTags) {
      const counts = groups.map(grp => grp.filter(sid => (tagsOf[sid] || new Set()).has(tag)).length);
      const mean = counts.reduce((a, b) => a + b, 0) / groups.length;
      tags[tag] = {
        counts,
        mean: Math.round(mean * 100) / 100,
        deviation: Math.round(counts.reduce((s, c) => s + Math.abs(c - mean), 0) / 2 * 10) / 10,
      };
    }
    return { round: ri, tags };
  });
}

function moveRotMember(sid, ri, targetGi) {
  const lk = roundLocksOf(ri);
  if (lk.members.has(sid)) { toast("该成员本轮已锁定", true); return; }
  const groups = state.roundsWorking[ri];
  const fromGi = groups.findIndex(g => g.includes(sid));
  if (fromGi === -1 || fromGi === targetGi) return;
  if (lk.groups.has(fromGi)) { toast("来源组已整组锁定", true); return; }
  pushHistoryRot();
  groups[fromGi] = groups[fromGi].filter(x => x !== sid);
  groups[targetGi].push(sid);
  syncCurrentPlanLive();
  renderRotWorkbench();
  const rc = state.rotation.rounds[ri];
  const rels = state.relations.filter(r => relIsActive(r, ri));
  const fresh = validateGroups(groups, rc.minSize, rc.maxSize, rels)
    .filter(v => v.group === targetGi || v.group === fromGi || v.people.includes(sid));
  if (fresh.length) toast("⚠ " + fresh[0].message, true);
}

/* 实时计算某轮各标签在当前分组下的分布与偏差（不读取原始方案数据） */
function liveTagDeviation(ri) {
  const groups = state.roundsWorking[ri];
  const g = groups.length;
  const tagsOf = {};
  state.students.forEach(s => { tagsOf[s.id] = new Set(s.tags); });
  const out = [];
  for (const tag of state.rotation.balanceTags) {
    const counts = groups.map(grp => grp.filter(sid => (tagsOf[sid] || new Set()).has(tag)).length);
    const total = counts.reduce((a, b) => a + b, 0);
    const mean = total / g;
    const deviation = Math.round(counts.reduce((s, c) => s + Math.abs(c - mean), 0) / 2 * 10) / 10;
    // 是否偏离均衡（均值取整区间之外）
    const lo = Math.floor(mean), hi = Math.ceil(mean);
    const imbalanced = counts.some(c => c < lo || c > hi);
    out.push({ tag, counts, mean, deviation, imbalanced });
  }
  return out;
}

/* ---------- 状态摘要 + 同伴矩阵 ---------- */
function renderRotStatusAndMatrix() {
  const ri = state.activeRound;
  const lk = roundLocksOf(ri);
  const parts = [];
  if (lk.members.size) parts.push(lk.members.size + " 名成员已锁定");
  if (lk.groups.size) parts.push(lk.groups.size + " 个整组已锁定");
  $("#rot-lock-summary").textContent = "第 " + (ri + 1) + " 轮 · " +
    (parts.length ? "🔒 " + parts.join("，") : "本轮未锁定");

  // 硬约束状态：按当前分组实时校验（人数范围 + 本轮生效关系）
  const rc = state.rotation.rounds[ri];
  const rels = state.relations.filter(r => relIsActive(r, ri));
  const hardViolations = validateGroups(state.roundsWorking[ri], rc.minSize, rc.maxSize, rels);

  const stats = rotationStats();
  const vs = $("#rot-violation-summary");
  if (hardViolations.length) {
    vs.textContent = "⚠ 本轮 " + hardViolations.length + " 处硬约束违规";
    vs.className = "bad";
  } else {
    vs.textContent = "✓ 本轮硬约束满足";
    vs.className = "ok";
  }
  const cs = $("#rot-cross-summary");
  const capOk = stats.capHits.length === 0;
  cs.textContent = capOk
    ? "跨轮：覆盖率 " + (stats.coverage * 100).toFixed(1) + "%（" + stats.covered + "/" + stats.total +
      " 对）· 最高重复 " + stats.maxRepeat + " 次 · 上限 " + state.rotation.cap + " 次"
    : "⚠ " + stats.capHits.length + " 对学员同组超过上限 " + state.rotation.cap + " 次";
  cs.className = capOk ? "ok" : "bad";

  // 指标列表：标签分布/偏差实时按当前分组重算
  const ml = $("#rot-metrics-list");
  const tagRows = liveTagDeviation(ri);
  let html =
    '<li class="' + (capOk ? "ok" : "bad") + '">同伴覆盖率：' + (stats.coverage * 100).toFixed(1) +
    "%（" + stats.covered + "/" + stats.total + " 对曾同组）</li>" +
    '<li class="' + (stats.maxRepeat <= state.rotation.cap ? "ok" : "bad") + '">最高同组重复：' +
    stats.maxRepeat + " 次（上限 " + state.rotation.cap + "）</li>" +
    '<li class="' + (hardViolations.length ? "bad" : "ok") + '">本轮硬约束：' +
    (hardViolations.length ? hardViolations.length + " 处违规" : "全部满足") + "</li>" +
    '<li class="hint">未曾同组组合：' + (stats.total - stats.covered) + " 对</li>";
  if (tagRows.length) {
    html += tagRows.map(td =>
      '<li class="' + (td.imbalanced ? "warn" : "ok") + '">第 ' + (ri + 1) + ' 轮标签「' +
      esc(td.tag) + "」分布 " + td.counts.join("/") + "（均衡 " + td.mean.toFixed(1) +
      "，偏差 " + td.deviation + "）</li>").join("");
  }
  ml.innerHTML = html;

  renderMatrix(stats);
}

function renderMatrix(stats) {
  const table = $("#rot-matrix");
  const n = state.students.length;
  const order = [];
  if (state.matrixSort >= 0) {
    const col = state.matrixSort;
    const ids = state.students.map((s, i) => i);
    ids.sort((a, b) => (stats.matrix[b][col] - stats.matrix[a][col]) || a - b);
    order.push(col);
    ids.forEach(i => { if (i !== col) order.push(i); });
  } else {
    for (let i = 0; i < n; i++) order.push(i);
  }
  let html = "<thead><tr><th class='corner'>编号＼编号</th>";
  order.forEach(i => {
    html += "<th data-i='" + i + "' title='" + esc(state.students[i].name) + "'>" +
      String(i + 1).padStart(2, "0") + "</th>";
  });
  html += "</tr></thead><tbody>";
  order.forEach(i => {
    html += "<tr><th>" + String(i + 1).padStart(2, "0") + " " + esc(state.students[i].name) + "</th>";
    order.forEach(j => {
      const v = stats.matrix[i][j];
      let cls;
      if (i === j) cls = "mdiag";
      else if (v > state.rotation.cap) cls = "mcap";
      else cls = "m" + Math.min(v, 3);
      const shown = v < 0 ? "·" : v;
      const title = i === j ? "" :
        esc(state.students[i].name) + " × " + esc(state.students[j].name) + "：同组 " + v + " 轮" +
        (v === 0 ? "（未曾同组）" : "");
      html += '<td class="' + cls + '" title="' + title + '">' + shown + "</td>";
    });
    html += "</tr>";
  });
  html += "</tbody>";
  table.innerHTML = html;
  table.querySelectorAll("thead th[data-i]").forEach(th => {
    th.addEventListener("click", () => {
      const i = parseInt(th.dataset.i, 10);
      state.matrixSort = state.matrixSort === i ? -1 : i;
      renderMatrix(stats);
    });
  });
  $("#rot-matrix-legend").textContent =
    "色阶：灰=未曾同组(0)，蓝色越深同组轮数越多，红底=超过上限(" + state.rotation.cap +
    ")；对角线「·」为本人。共 " + (stats.total - stats.covered) + " 对学员从未同组。";
}

/* ---------- 撤销 / 清锁 / 打印 ---------- */
$("#btn-rot-undo").addEventListener("click", () => {
  const prev = state.historyRot.pop();
  if (!prev) { toast("没有可撤销的操作"); return; }
  state.roundsWorking = prev.rounds;
  state.roundLocks = prev.locks;
  state.activeRound = prev.activeRound;
  syncCurrentPlanLive();
  renderRotWorkbench();
  toast("已撤销");
});

$("#btn-rot-clear-locks").addEventListener("click", () => {
  const lk = roundLocksOf(state.activeRound);
  if (!lk.members.size && !lk.groups.size) return;
  pushHistoryRot();
  state.roundLocks[state.activeRound] = { members: new Set(), groups: new Set() };
  renderRotWorkbench();
});

$("#btn-rot-print").addEventListener("click", async () => {
  if (!state.roundsWorking) return;
  try {
    const data = await api("/api/prints", "POST", {
      mode: "rotation",
      title: "多轮轮换分组",
      students: state.students,
      rounds: state.roundsWorking,
      roundNames: state.roundsWorking.map((_, i) => "第 " + (i + 1) + " 轮分组"),
    });
    window.open("/print/" + data.id + "?anon=1", "_blank");
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- 从本轮起重排（影响预览 → 应用） ---------- */
let pendingResolve = null;

$("#btn-rot-resolve").addEventListener("click", async () => {
  const fromRound = state.activeRound;
  const lk = roundLocksOf(fromRound);
  const btn = $("#btn-rot-resolve");
  const label = $("#rot-resolve-label");
  const setBtnBusy = (busy) => {
    btn.disabled = busy;
    // 保留内部 <span id="rot-resolve-label">，不要用 textContent 覆盖整个按钮
    if (busy) {
      btn.dataset.busy = "1";
      if (label) label.textContent = "…计算中";
    } else if (label) {
      delete btn.dataset.busy;
      label.textContent = (state.activeRound + 1) + " 轮";
    }
  };
  setBtnBusy(true);
  try {
    const locks = {};
    locks[fromRound] = { members: [...lk.members], groups: [...lk.groups] };
    const data = await api("/api/rotation/resolve", "POST", {
      students: state.students,
      relations: state.relations,
      rotation: {
        rounds: state.rotation.rounds,
        balanceTags: state.rotation.balanceTags,
        cap: state.rotation.cap,
        maxCoverage: state.rotation.maxCoverage,
      },
      currentRounds: state.roundsWorking,
      fromRound,
      locks,
    });
    if (data.conflicts && data.conflicts.length) {
      const card = $("#rot-conflict-card");
      card.classList.remove("hidden");
      const box = $("#rot-conflict-list");
      box.innerHTML = "";
      data.conflicts.forEach(c => box.appendChild(buildConflictItem(c)));
      toast(data.conflicts[0].message, true);
      return;
    }
    showResolvePreview(data.payload);
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBtnBusy(false);
  }
});

function showResolvePreview(payload) {
  pendingResolve = payload;
  const names = (id) => nameOf(id);
  const changes = payload.repeatChanges;
  const fmt = (x) => "「" + esc(names(x.a)) + "–" + esc(names(x.b)) + "」 " + x.before + "→" + x.after;
  let html =
    '<p>将保持 <b>第 1～' + payload.fromRound + ' 轮</b>不变，重排 <b>第 ' +
    (payload.fromRound + 1) + "～" + state.rotation.rounds.length + ' 轮</b>。</p>' +
    '<p><b>受影响学员：' + payload.affectedCount + ' 人</b></p>';
  if (payload.affected.length) {
    html += '<div class="affected-chips">' +
      payload.affected.map(id => '<span class="node">' + esc(names(id)) + "</span>").join("") + "</div>";
  }
  html += "<p style='margin-top:12px'><b>重复搭档变化</b>：" +
    "新增重复 " + changes.moreCount + " 对，减少重复 " + changes.lessCount + " 对</p>";
  if (changes.more.length) {
    html += '<div>同组次数增加：<ul class="change-list">' +
      changes.more.slice(0, 8).map(x => '<li class="up">▲ ' + fmt(x) + "</li>").join("") + "</ul></div>";
  }
  if (changes.less.length) {
    html += '<div>同组次数减少：<ul class="change-list">' +
      changes.less.slice(0, 8).map(x => '<li class="down">▼ ' + fmt(x) + "</li>").join("") + "</ul></div>";
  }
  html += '<p class="hint">新方案覆盖率 ' + (payload.metrics.coverage * 100).toFixed(1) +
    "% · 最高重复 " + payload.metrics.maxRepeat + " 次。应用前的编排可用「撤销」恢复。</p>";
  $("#resolve-modal-body").innerHTML = html;
  $("#resolve-modal").classList.remove("hidden");
}

$("#resolve-cancel").addEventListener("click", () => {
  pendingResolve = null;
  $("#resolve-modal").classList.add("hidden");
});
$("#resolve-apply").addEventListener("click", () => {
  if (!pendingResolve) return;
  pushHistoryRot();
  state.roundsWorking = cloneRounds(pendingResolve.rounds);
  // 重排后的轮次清除锁定（之前轮次保留）；回到起始轮
  for (let ri = pendingResolve.fromRound + 1; ri < state.roundLocks.length; ri++) {
    state.roundLocks[ri] = { members: new Set(), groups: new Set() };
  }
  state.activeRound = pendingResolve.fromRound;
  $("#resolve-modal").classList.add("hidden");
  pendingResolve = null;
  syncCurrentPlanLive();
  renderRotWorkbench();
  toast("已重排第 " + (state.activeRound + 1) + " 轮及之后各轮");
});

/* ---------- 轮换方案对比 ---------- */
function tagDeviationTotal(p, ri) {
  let s = 0;
  const row = p.tagDeviation && p.tagDeviation[ri];
  if (!row) return 0;
  for (const k in row.tags) s += row.tags[k].deviation;
  return Math.round(s * 10) / 10;
}

function renderRotCompare() {
  const has = state.plans.length > 0;
  $("#rot-cmp-empty").classList.toggle("hidden", has);
  $("#rot-cmp-main").classList.toggle("hidden", !has);
  $("#cmp-empty").classList.add("hidden");
  $("#cmp-main").classList.add("hidden");
  if (!has) return;

  const plans = state.plans;
  const R = state.rotation.rounds.length;
  const bestCov = Math.max(...plans.map(p => p.coverage));
  const bestRepeat = Math.min(...plans.map(p => p.maxRepeat));

  let html = "<thead><tr><th>指标</th>";
  plans.forEach((p, i) => { html += "<th>方案 " + (i + 1) + "</th>"; });
  html += "</tr></thead><tbody>";

  html += "<tr><td>同伴覆盖率</td>";
  plans.forEach(p => {
    const cls = p.coverage === bestCov ? "cmp-best" : "cmp-worst";
    html += '<td class="' + cls + '">' + (p.coverage * 100).toFixed(1) + "%</td>";
  });
  html += "</tr>";

  html += "<tr><td>覆盖同伴对数</td>";
  plans.forEach(p => { html += "<td>" + p.coveredPairs + " / " + p.totalPairs + "</td>"; });
  html += "</tr>";

  html += "<tr><td>最高同组重复次数</td>";
  plans.forEach(p => {
    const cls = p.maxRepeat === bestRepeat ? "cmp-best" : "cmp-worst";
    html += '<td class="' + cls + '">' + p.maxRepeat +
      ' <span class="hint-inline">上限 ' + state.rotation.cap + "</span></td>";
  });
  html += "</tr>";

  html += "<tr><td>超上限搭档对</td>";
  plans.forEach(p => {
    html += "<td>" + (p.capHits.length
      ? '<span class="cmp-worst">' + p.capHits.length + " 对</span>"
      : '<span class="cmp-best">✓ 无</span>') + "</td>";
  });
  html += "</tr>";

  for (let ri = 0; ri < R; ri++) {
    html += "<tr><td>第 " + (ri + 1) + " 轮标签偏差</td>";
    plans.forEach(p => {
      const tags = state.rotation.balanceTags;
      if (!tags.length) { html += "<td>—</td>"; return; }
      html += "<td>" + tags.map(t => {
        const td = p.tagDeviation[ri] && p.tagDeviation[ri].tags[t];
        return esc(t) + ": " + (td ? td.counts.join("/") + "（偏差" + td.deviation + "）" : "—");
      }).join("<br>") + "</td>";
    });
    html += "</tr>";
  }

  html += "<tr><td>操作</td>";
  plans.forEach((p, i) => {
    html += '<td><button class="btn" data-idx="' + i + '">在排演台打开</button></td>';
  });
  html += "</tr></tbody>";

  const table = $("#rot-cmp-table");
  table.innerHTML = html;
  table.querySelectorAll("button[data-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.idx, 10);
      state.planCur = i;
      state.roundsWorking = cloneRounds(state.plans[i].rounds);
      state.roundLocks = state.roundLocks.map(() => ({ members: new Set(), groups: new Set() }));
      state.activeRound = 0;
      state.historyRot = [];
      renderRotWorkbench();
      document.querySelector('.tab[data-tab="workbench"]').click();
    });
  });
}

/* ================= 初始化 ================= */
renderRoster();
renderSettings();
ensureRotationRounds(3);
renderRotRoundsTable();
setMode("single");
renderWorkbench();

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
  // 角色轮值
  roleTpl: { roles: [], ncMode: "all", ncPairs: [], limits: {} },
  roleDraft: null,       // {sourceMode, fingerprint, groups, roundNames, assign, locks}
  roleVersions: [],      // 已确认版本（冻结，只读）
  roleActiveRound: 0,
  roleHistory: [],       // 角色草稿撤销栈
  roleViewVersion: null, // 正在查看的版本 id
  roleViewRound: 0,
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
  if (btn.dataset.tab === "roles") renderRoles();
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
  pruneRoleState();
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
  pruneRoleState();
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
  updateRoleStaleBanner();  // 来源分组可能已变化：只标过期，不改写草稿
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
    if (state.roleTpl.roles.length || state.roleDraft || state.roleVersions.length) {
      payload.roles = {
        template: state.roleTpl,
        draft: state.roleDraft,
        versions: state.roleVersions,
      };
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
    // 角色轮值：旧存档无 roles 字段 → 全部取默认空状态，正常加载
    const rd = (data.roles && typeof data.roles === "object") ? data.roles : null;
    state.roleTpl = rd && rd.template ? Object.assign(roleTplDefault(), rd.template) : roleTplDefault();
    if (!Array.isArray(state.roleTpl.roles)) state.roleTpl.roles = [];
    if (!Array.isArray(state.roleTpl.ncPairs)) state.roleTpl.ncPairs = [];
    if (!state.roleTpl.limits || typeof state.roleTpl.limits !== "object") state.roleTpl.limits = {};
    state.roleDraft = rd && rd.draft ? rd.draft : null;
    state.roleVersions = rd && Array.isArray(rd.versions) ? rd.versions : [];
    state.roleActiveRound = 0;
    state.roleHistory = [];
    state.roleViewVersion = null;
    state.roleViewRound = 0;
    renderRoleTemplate();
    renderRoles();
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
  updateRoleStaleBanner();  // 来源分组可能已变化：只标过期，不改写草稿
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
  const totalRounds = state.rotation.rounds.length;
  let rangeText;
  if (payload.fromRound <= 0) {
    // 没有前置冻结轮：直接重排全部轮次
    rangeText = totalRounds === 1
      ? "将重排 <b>第 1 轮</b>。"
      : "无前置锁定轮，将重排 <b>第 1～" + totalRounds + " 轮</b>。";
  } else {
    rangeText = "将保持 <b>第 1～" + payload.fromRound + " 轮</b>不变，重排 <b>第 " +
      (payload.fromRound + 1) + "～" + totalRounds + " 轮</b>。";
  }
  let html =
    "<p>" + rangeText + "</p>" +
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

/* ================= 角色轮值 ================= */
function roleTplDefault() { return { roles: [], ncMode: "all", ncPairs: [], limits: {} }; }
function roleById(rid) { return state.roleTpl.roles.find(r => r.id === rid); }

/* 不可兼任角色对（mode=all 时为全部两两组合） */
function roleNcPairsArr() {
  const ids = state.roleTpl.roles.map(r => r.id);
  if (state.roleTpl.ncMode !== "pairs") {
    const out = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]]);
    return out;
  }
  return state.roleTpl.ncPairs.filter(p => roleById(p[0]) && roleById(p[1]));
}

/* 学员名单变化后，清理草稿/模板中失效的成员引用（已确认版本冻结不动） */
function pruneRoleState() {
  const valid = new Set(state.students.map(s => s.id));
  state.roleTpl.roles.forEach(r => { r.ban = r.ban.filter(sid => valid.has(sid)); });
  const d = state.roleDraft;
  if (!d) return;
  d.groups = d.groups.map(rnd => rnd.map(g => g.filter(sid => valid.has(sid))));
  d.assign = d.assign.map(rnd => rnd.map(g => {
    const out = {};
    for (const rid in g) {
      const keep = g[rid].filter(sid => valid.has(sid));
      if (keep.length) out[rid] = keep;
    }
    return out;
  }));
  d.locks = d.locks.filter(l => valid.has(l.member));
}

/* ---------- 角色模板编辑 ---------- */
function renderRoleTemplate() {
  const tbody = $("#role-tpl-table tbody");
  tbody.innerHTML = "";
  if (!state.roleTpl.roles.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="hint">尚未定义角色。常见角色：主持、记录、计时、汇报。</td></tr>';
  }
  state.roleTpl.roles.forEach((role) => {
    const tr = document.createElement("tr");
    // 名称
    const tdName = document.createElement("td");
    const nameInp = document.createElement("input");
    nameInp.type = "text"; nameInp.value = role.name; nameInp.maxLength = 12;
    nameInp.style.width = "90px";
    nameInp.addEventListener("change", () => {
      const v = nameInp.value.trim();
      if (!v) { nameInp.value = role.name; return; }
      if (state.roleTpl.roles.some(r => r !== role && r.name === v)) {
        toast("已存在同名角色", true); nameInp.value = role.name; return;
      }
      role.name = v; renderRoles();
    });
    tdName.appendChild(nameInp);
    // 每组名额
    const tdPer = document.createElement("td");
    const perInp = document.createElement("input");
    perInp.type = "number"; perInp.min = "1"; perInp.max = "5";
    perInp.value = role.perGroup; perInp.style.width = "64px";
    perInp.addEventListener("change", () => {
      role.perGroup = Math.max(1, Math.min(5, parseInt(perInp.value, 10) || 1));
      perInp.value = role.perGroup;
      renderRoles();
    });
    tdPer.appendChild(perInp);
    // 所需技能标签
    const tdTags = document.createElement("td");
    const tagInp = document.createElement("input");
    tagInp.type = "text"; tagInp.placeholder = "逗号分隔，可空";
    tagInp.value = role.tags.join(",");
    tagInp.setAttribute("list", "role-tag-list");
    tagInp.addEventListener("change", () => {
      const arr = [];
      tagInp.value.split(/[,，]/).forEach(t => {
        t = t.trim(); if (t && !arr.includes(t)) arr.push(t);
      });
      role.tags = arr; tagInp.value = arr.join(",");
      renderRoles();
    });
    tdTags.appendChild(tagInp);
    // 个人禁任
    const tdBan = document.createElement("td");
    const banBox = document.createElement("div");
    banBox.className = "ban-box";
    role.ban.forEach(sid => {
      const chip = document.createElement("span");
      chip.className = "tag-chip ban";
      chip.innerHTML = esc(nameOf(sid)) + ' <button class="icon-btn" title="移出禁任">✕</button>';
      chip.querySelector("button").addEventListener("click", () => {
        role.ban = role.ban.filter(x => x !== sid);
        renderRoleTemplate(); renderRoles();
      });
      banBox.appendChild(chip);
    });
    const banSel = document.createElement("select");
    banSel.innerHTML = '<option value="">＋禁任…</option>' +
      state.students.filter(s => !role.ban.includes(s.id))
        .map(s => '<option value="' + s.id + '">' + esc(s.name) + "</option>").join("");
    banSel.addEventListener("change", () => {
      if (banSel.value) {
        role.ban.push(banSel.value);
        renderRoleTemplate(); renderRoles();
      }
    });
    banBox.appendChild(banSel);
    tdBan.appendChild(banBox);
    // 连续 / 累计上限（0 = 不限）
    const tdLim = document.createElement("td");
    const lim = state.roleTpl.limits[role.id] || { maxConsecutive: 0, maxTotal: 0 };
    state.roleTpl.limits[role.id] = lim;
    const mkLim = (key, title) => {
      const inp = document.createElement("input");
      inp.type = "number"; inp.min = "0"; inp.max = "8";
      inp.value = lim[key] || 0; inp.style.width = "52px";
      inp.title = title + "（0 = 不限）";
      inp.addEventListener("change", () => {
        lim[key] = Math.max(0, Math.min(8, parseInt(inp.value, 10) || 0));
        inp.value = lim[key];
        renderRoles();
      });
      return inp;
    };
    tdLim.appendChild(mkLim("maxConsecutive", "同一人最多连续担任该角色几轮"));
    tdLim.appendChild(document.createTextNode(" / "));
    tdLim.appendChild(mkLim("maxTotal", "同一人累计最多担任该角色几轮"));
    // 删除
    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "✕"; del.title = "删除角色";
    del.addEventListener("click", () => {
      state.roleTpl.roles = state.roleTpl.roles.filter(r => r !== role);
      delete state.roleTpl.limits[role.id];
      state.roleTpl.ncPairs = state.roleTpl.ncPairs
        .filter(p => p[0] !== role.id && p[1] !== role.id);
      renderRoleTemplate(); renderRoles();
    });
    tdDel.appendChild(del);
    [tdName, tdPer, tdTags, tdBan, tdLim, tdDel].forEach(td => tr.appendChild(td));
    tbody.appendChild(tr);
  });
  // 标签 datalist
  $("#role-tag-list").innerHTML =
    allTags().map(t => '<option value="' + esc(t) + '">').join("");
  // 不可兼任规则
  const mode = state.roleTpl.ncMode;
  $$('input[name="role-nc"]').forEach(r => { r.checked = r.value === mode; });
  $("#role-nc-pairs").classList.toggle("hidden", mode !== "pairs");
  if (mode === "pairs") {
    for (const sel of [$("#role-nc-a"), $("#role-nc-b")]) {
      const keep = sel.value;
      sel.innerHTML = state.roleTpl.roles
        .map(r => '<option value="' + r.id + '">' + esc(r.name) + "</option>").join("");
      sel.value = keep;
    }
    const ul = $("#role-nc-list");
    ul.innerHTML = state.roleTpl.ncPairs.length ? "" :
      '<li class="hint">尚未指定角色对（当前模式下同一人同轮可兼任多角色）</li>';
    state.roleTpl.ncPairs.forEach((p, idx) => {
      const li = document.createElement("li");
      li.innerHTML = '<span class="rel-badge cannot">不可兼任</span>' +
        '<span class="rel-names">' + esc((roleById(p[0]) || {}).name || "?") +
        " ↔ " + esc((roleById(p[1]) || {}).name || "?") + "</span>" +
        '<button class="icon-btn" title="删除">✕</button>';
      li.querySelector("button").addEventListener("click", () => {
        state.roleTpl.ncPairs.splice(idx, 1);
        renderRoleTemplate(); renderRoles();
      });
      ul.appendChild(li);
    });
  }
}

$("#btn-add-role").addEventListener("click", () => {
  const name = $("#role-name").value.trim();
  if (!name) { toast("请输入角色名称", true); return; }
  if (state.roleTpl.roles.some(r => r.name === name)) { toast("已存在同名角色", true); return; }
  const per = Math.max(1, Math.min(5, parseInt($("#role-per").value, 10) || 1));
  state.roleTpl.roles.push({ id: uid("role"), name, perGroup: per, tags: [], ban: [] });
  $("#role-name").value = "";
  renderRoleTemplate(); renderRoles();
});
$("#role-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-add-role").click();
});
$$('input[name="role-nc"]').forEach(radio => {
  radio.addEventListener("change", () => {
    state.roleTpl.ncMode = radio.value === "pairs" ? "pairs" : "all";
    renderRoleTemplate(); renderRoles();
  });
});
$("#btn-add-nc").addEventListener("click", () => {
  const a = $("#role-nc-a").value, b = $("#role-nc-b").value;
  if (!a || !b || a === b) { toast("请选择两个不同的角色", true); return; }
  const dup = state.roleTpl.ncPairs.some(p =>
    (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a));
  if (dup) { toast("该角色对已存在", true); return; }
  state.roleTpl.ncPairs.push([a, b]);
  renderRoleTemplate(); renderRoles();
});

/* ---------- 草稿：建立 / 过期 ---------- */
function roleSourceGroups() {
  if (state.mode === "rotation") {
    return state.roundsWorking ? cloneRounds(state.roundsWorking) : null;
  }
  return state.working ? [cloneGroups(state.working)] : null;
}

function roleFingerprint(groups) {
  // 规范化指纹：组内成员排序 + 组间排序；成员在组内移动不算来源变化
  return JSON.stringify((groups || [])
    .map(rnd => rnd.map(g => g.slice().sort()).sort()));
}

function roleDraftStale() {
  const d = state.roleDraft;
  if (!d) return false;
  const cur = roleSourceGroups();
  if (!cur) return true;
  if (d.sourceMode !== state.mode) return true;
  return roleFingerprint(cur) !== d.fingerprint;
}

function renderRoleStale() {
  $("#role-stale").classList.toggle("hidden", !roleDraftStale());
}

function updateRoleStaleBanner() {
  const el = $("#role-stale");
  if (el) renderRoleStale();
}

function buildRoleDraft() {
  const groups = roleSourceGroups();
  if (!groups) { toast("请先在排演台生成分组方案", true); return false; }
  if (!state.roleTpl.roles.length) { toast("请先定义角色模板", true); return false; }
  state.roleDraft = {
    sourceMode: state.mode,
    fingerprint: roleFingerprint(groups),
    groups,
    roundNames: groups.map((_, i) => "第 " + (i + 1) + " 轮"),
    assign: groups.map(rnd => rnd.map(() => ({}))),
    locks: [],
  };
  state.roleActiveRound = 0;
  state.roleHistory = [];
  renderRoles();
  toast("已建立角色轮值草稿（" + groups.length + " 轮）");
  return true;
}

$("#btn-role-draft").addEventListener("click", () => {
  if (state.roleDraft &&
      !confirm("重建草稿将丢弃当前未确认的角色安排（已确认版本不受影响），继续？")) return;
  buildRoleDraft();
});
$("#btn-role-redraft").addEventListener("click", () => {
  if (!confirm("按当前分组重建草稿？当前草稿的未确认安排将丢失（已确认版本不受影响）。")) return;
  buildRoleDraft();
});

/* ---------- 草稿编辑（撤销 / 清除 / 槽位操作） ---------- */
function pushRoleHistory() {
  state.roleHistory.push({
    assign: JSON.stringify(state.roleDraft.assign),
    locks: JSON.stringify(state.roleDraft.locks),
  });
  if (state.roleHistory.length > 60) state.roleHistory.shift();
}

$("#btn-role-undo").addEventListener("click", () => {
  const prev = state.roleHistory.pop();
  if (!prev) { toast("没有可撤销的操作"); return; }
  state.roleDraft.assign = JSON.parse(prev.assign);
  state.roleDraft.locks = JSON.parse(prev.locks);
  renderRoles();
  toast("已撤销");
});

$("#btn-role-clear").addEventListener("click", () => {
  const d = state.roleDraft;
  if (!d) return;
  const lockSet = new Set(d.locks.map(l =>
    l.round + "|" + l.group + "|" + l.role + "|" + l.member));
  const hasUnlocked = d.assign.some((rnd, ri) => rnd.some((g, gi) =>
    Object.keys(g).some(rid =>
      g[rid].some(m => !lockSet.has(ri + "|" + gi + "|" + rid + "|" + m)))));
  if (!hasUnlocked) { toast("没有未锁定的安排可清除"); return; }
  pushRoleHistory();
  d.assign = d.assign.map((rnd, ri) => rnd.map((g, gi) => {
    const out = {};
    for (const rid in g) {
      const keep = g[rid].filter(m => lockSet.has(ri + "|" + gi + "|" + rid + "|" + m));
      if (keep.length) out[rid] = keep;
    }
    return out;
  }));
  renderRoles();
  toast("已清除未锁定的安排");
});

function roleAssignMember(sid, ri, gi, rid) {
  const d = state.roleDraft;
  const role = roleById(rid);
  if (!d || !role) return;
  if (!d.groups[ri][gi].includes(sid)) { toast("该成员不在本组", true); return; }
  const slot = d.assign[ri][gi][rid] || (d.assign[ri][gi][rid] = []);
  if (slot.includes(sid)) return;
  if (slot.length >= role.perGroup) {
    toast("「" + role.name + "」名额已满（" + role.perGroup + " 人）", true);
    return;
  }
  pushRoleHistory();
  slot.push(sid);
  renderRoles();
  const fresh = validateRoleDraft()
    .filter(v => v.people.includes(sid) && v.round === ri);
  if (fresh.length) toast("⚠ " + fresh[0].message, true);
}

function roleUnassignMember(sid, ri, gi, rid) {
  const d = state.roleDraft;
  if (!d) return;
  const slot = ((d.assign[ri] || [])[gi] || {})[rid] || [];
  if (!slot.includes(sid)) return;
  pushRoleHistory();
  d.assign[ri][gi][rid] = slot.filter(x => x !== sid);
  d.locks = d.locks.filter(l =>
    !(l.round === ri && l.group === gi && l.role === rid && l.member === sid));
  renderRoles();
}

function roleMoveMember(sid, ri, fromGi, fromRid, toGi, toRid) {
  const d = state.roleDraft;
  const role = roleById(toRid);
  if (!d || !role) return;
  if (!d.groups[ri][toGi].includes(sid)) { toast("该成员不在本组", true); return; }
  const locked = d.locks.some(l =>
    l.round === ri && l.group === fromGi && l.role === fromRid && l.member === sid);
  if (locked) { toast("该安排已锁定，请先解锁", true); return; }
  const toSlot = d.assign[ri][toGi][toRid] || [];
  if (!toSlot.includes(sid) && toSlot.length >= role.perGroup) {
    toast("「" + role.name + "」名额已满（" + role.perGroup + " 人）", true);
    return;
  }
  pushRoleHistory();
  const fromSlot = (d.assign[ri][fromGi] || {})[fromRid] || [];
  d.assign[ri][fromGi][fromRid] = fromSlot.filter(x => x !== sid);
  if (!toSlot.includes(sid)) {
    (d.assign[ri][toGi][toRid] || (d.assign[ri][toGi][toRid] = [])).push(sid);
  }
  renderRoles();
  const fresh = validateRoleDraft()
    .filter(v => v.people.includes(sid) && v.round === ri);
  if (fresh.length) toast("⚠ " + fresh[0].message, true);
}

function roleToggleLock(sid, ri, gi, rid) {
  const d = state.roleDraft;
  if (!d) return;
  const idx = d.locks.findIndex(l =>
    l.round === ri && l.group === gi && l.role === rid && l.member === sid);
  pushRoleHistory();
  if (idx >= 0) d.locks.splice(idx, 1);
  else d.locks.push({ round: ri, group: gi, role: rid, member: sid });
  renderRoles();
}

/* ---------- 即时校验：兼任 / 空缺 / 资格 / 锁定 / 超限 ---------- */
function validateRoleDraft() {
  const d = state.roleDraft;
  if (!d) return [];
  const v = [];
  const tagsOf = {};
  state.students.forEach(s => { tagsOf[s.id] = new Set(s.tags); });
  const lockSet = new Set(d.locks.map(l =>
    l.round + "|" + l.group + "|" + l.role + "|" + l.member));
  const pairs = roleNcPairsArr();
  const R = d.groups.length;
  for (let ri = 0; ri < R; ri++) {
    d.groups[ri].forEach((grp, gi) => {
      const gas = d.assign[ri][gi] || {};
      const heldBy = {};   // sid -> [rid]
      state.roleTpl.roles.forEach(role => {
        const got = (gas[role.id] || []).slice(0, role.perGroup);
        const missing = role.perGroup - got.length;
        if (missing > 0) {
          v.push({ type: "vacant", round: ri, group: gi, role: role.id, people: [],
                   message: "第 " + (ri + 1) + " 轮第 " + (gi + 1) + " 组「" +
                            role.name + "」缺 " + missing + " 人" });
        }
        const seen = new Set();
        got.forEach(sid => {
          const locked = lockSet.has(ri + "|" + gi + "|" + role.id + "|" + sid);
          const t = locked ? "lock" : "qual";
          const lockNote = locked ? "（已锁定）" : "";
          if (!grp.includes(sid)) {
            v.push({ type: "lock", round: ri, group: gi, role: role.id, people: [sid],
                     message: "「" + nameOf(sid) + "」不在第 " + (ri + 1) + " 轮第 " +
                              (gi + 1) + " 组，不能担任「" + role.name + "」" + lockNote });
            return;
          }
          if (seen.has(sid)) return;
          seen.add(sid);
          if (role.ban.includes(sid)) {
            v.push({ type: t, round: ri, group: gi, role: role.id, people: [sid],
                     message: "「" + nameOf(sid) + "」被禁任「" + role.name + "」（第 " +
                              (ri + 1) + " 轮第 " + (gi + 1) + " 组）" + lockNote });
          } else if (role.tags.some(x => !(tagsOf[sid] || new Set()).has(x))) {
            v.push({ type: t, round: ri, group: gi, role: role.id, people: [sid],
                     message: "「" + nameOf(sid) + "」缺少「" + role.name +
                              "」所需标签（" + role.tags.join("、") + "）（第 " +
                              (ri + 1) + " 轮第 " + (gi + 1) + " 组）" + lockNote });
          }
          (heldBy[sid] = heldBy[sid] || []).push(role.id);
        });
      });
      // 一人同轮兼任
      Object.keys(heldBy).forEach(sid => {
        const held = heldBy[sid];
        pairs.forEach(([a, b]) => {
          if (held.includes(a) && held.includes(b)) {
            const bothLocked =
              lockSet.has(ri + "|" + gi + "|" + a + "|" + sid) &&
              lockSet.has(ri + "|" + gi + "|" + b + "|" + sid);
            v.push({ type: bothLocked ? "lock" : "concurrent",
                     round: ri, group: gi, role: a, people: [sid],
                     message: "「" + nameOf(sid) + "」在第 " + (ri + 1) +
                              " 轮同时担任「" + (roleById(a) || {}).name + "」与「" +
                              (roleById(b) || {}).name + "」，违反不可兼任规则" +
                              (bothLocked ? "（两项均已锁定）" : "") });
          }
        });
      });
    });
  }
  // 锁定条目自身有效性
  d.locks.forEach(l => {
    const role = roleById(l.role);
    if (!role) {
      v.push({ type: "lock", round: l.round, group: l.group, role: l.role,
               people: [l.member],
               message: "「" + nameOf(l.member) + "」锁定的角色已被删除（第 " +
                        (l.round + 1) + " 轮）" });
      return;
    }
    const grp = (d.groups[l.round] || [])[l.group];
    if (!grp || !grp.includes(l.member)) {
      v.push({ type: "lock", round: l.round, group: l.group, role: l.role,
               people: [l.member],
               message: "锁定失效：「" + nameOf(l.member) + "」不在第 " +
                        (l.round + 1) + " 轮第 " + (l.group + 1) + " 组" });
      return;
    }
    const got = ((d.assign[l.round] || [])[l.group] || {})[l.role] || [];
    if (!got.includes(l.member)) {
      v.push({ type: "lock", round: l.round, group: l.group, role: l.role,
               people: [l.member],
               message: "锁定失效：「" + nameOf(l.member) + "」已不在「" + role.name +
                        "」安排中（第 " + (l.round + 1) + " 轮第 " + (l.group + 1) + " 组）" });
    }
  });
  // 连续 / 累计上限
  state.roleTpl.roles.forEach(role => {
    const lim = state.roleTpl.limits[role.id] || {};
    const mc = lim.maxConsecutive || 0, mt = lim.maxTotal || 0;
    if (!mc && !mt) return;
    state.students.forEach(s => {
      const arr = [];
      for (let ri = 0; ri < R; ri++) {
        const held = d.groups[ri].some((g, gi) =>
          (((d.assign[ri] || [])[gi] || {})[role.id] || []).includes(s.id));
        arr.push(held ? 1 : 0);
      }
      const total = arr.reduce((a, b) => a + b, 0);
      if (mt && total > mt) {
        let firstExcess = R - 1, c = 0;
        for (let ri = 0; ri < R; ri++) {
          if (arr[ri]) { c++; if (c > mt) { firstExcess = ri; break; } }
        }
        v.push({ type: "limit", round: firstExcess, group: -1, role: role.id,
                 people: [s.id],
                 message: "「" + s.name + "」累计担任「" + role.name + "」" + total +
                          " 轮，超过累计上限 " + mt + " 轮" });
      }
      if (mc) {
        let run = 0;
        for (let ri = 0; ri < R; ri++) {
          if (arr[ri]) {
            run++;
            if (run > mc) {
              v.push({ type: "limit", round: ri, group: -1, role: role.id,
                       people: [s.id],
                       message: "「" + s.name + "」连续担任「" + role.name + "」超过 " +
                                mc + " 轮（第 " + (ri + 1) + " 轮起超限）" });
              break;
            }
          } else run = 0;
        }
      }
    });
  });
  return v;
}

/* 点选提示 → 定位成员与轮次 */
function locateRoleIssue(v) {
  if (Number.isInteger(v.round) && v.round >= 0 && state.roleDraft &&
      v.round < state.roleDraft.groups.length) {
    state.roleActiveRound = v.round;
  }
  renderRoles();
  const raf = window.requestAnimationFrame || ((f) => setTimeout(f, 0));
  raf(() => {
    let el = null;
    if (v.people && v.people.length) {
      el = document.querySelector('#role-groups-grid .role-chip[data-sid="' + v.people[0] + '"]') ||
           document.querySelector('#role-groups-grid .member-chip[data-sid="' + v.people[0] + '"]');
    }
    if (!el && v.role != null && Number.isInteger(v.group) && v.group >= 0) {
      el = document.querySelector('#role-groups-grid .role-slot[data-role="' +
                                  v.role + '"][data-group="' + v.group + '"]');
    }
    if (el) {
      if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1700);
    }
  });
}

/* ---------- 渲染：草稿 ---------- */
function renderRoles() {
  renderRoleStale();
  const d = state.roleDraft;
  $("#role-empty").classList.toggle("hidden", !!d);
  $("#role-draft-main").classList.toggle("hidden", !d);
  renderRoleVersions();
  if (!d) return;
  $("#role-conflict-card").classList.add("hidden");
  if (state.roleActiveRound >= d.groups.length) state.roleActiveRound = 0;
  const rt = $("#role-round-tabs");
  rt.innerHTML = "";
  d.groups.forEach((_, ri) => {
    const b = document.createElement("button");
    b.className = "round-tab" + (ri === state.roleActiveRound ? " active" : "");
    b.textContent = d.roundNames[ri] || ("第 " + (ri + 1) + " 轮");
    b.addEventListener("click", () => { state.roleActiveRound = ri; renderRoles(); });
    rt.appendChild(b);
  });
  renderRoleGrid();
  renderRoleViolations();
  renderRoleMatrix();
}

function renderRoleGrid() {
  const d = state.roleDraft;
  const ri = state.roleActiveRound;
  const groups = d.groups[ri] || [];
  const viol = validateRoleDraft();
  const lockSet = new Set(d.locks.map(l =>
    l.round + "|" + l.group + "|" + l.role + "|" + l.member));
  const grid = $("#role-groups-grid");
  grid.innerHTML = "";
  groups.forEach((grp, gi) => {
    const card = document.createElement("div");
    card.className = "group-card role-group";
    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML = "<h3>第 " + (gi + 1) + " 组</h3>" +
      '<span class="group-size">' + grp.length + " 人</span>";
    card.appendChild(head);
    // 成员池（拖回此处即移出角色）
    const pool = document.createElement("div");
    pool.className = "member-area role-pool";
    if (!grp.length) pool.innerHTML = '<span class="group-empty">本组暂无成员</span>';
    grp.forEach(sid => pool.appendChild(renderRolePoolChip(sid)));
    pool.addEventListener("dragover", (e) => {
      e.preventDefault(); pool.classList.add("drag-over");
    });
    pool.addEventListener("dragleave", () => pool.classList.remove("drag-over"));
    pool.addEventListener("drop", (e) => {
      e.preventDefault(); pool.classList.remove("drag-over");
      const sid = e.dataTransfer.getData("text/plain");
      const fromRole = e.dataTransfer.getData("x-role-from");
      const fromGi = parseInt(e.dataTransfer.getData("x-role-group"), 10);
      if (sid && fromRole && Number.isInteger(fromGi)) {
        roleUnassignMember(sid, ri, fromGi, fromRole);
      }
    });
    card.appendChild(pool);
    // 角色槽
    const slots = document.createElement("div");
    slots.className = "role-slots";
    state.roleTpl.roles.forEach(role => {
      const row = document.createElement("div");
      row.className = "role-slot";
      row.dataset.role = role.id;
      row.dataset.group = gi;
      const got = ((d.assign[ri][gi] || {})[role.id]) || [];
      const nameEl = document.createElement("span");
      nameEl.className = "role-name";
      nameEl.innerHTML = esc(role.name) + " <em>×" + role.perGroup + "</em>";
      if (role.tags.length) nameEl.title = "所需标签：" + role.tags.join("、");
      row.appendChild(nameEl);
      const people = document.createElement("span");
      people.className = "role-people";
      got.forEach(sid => {
        people.appendChild(renderRoleAssignChip(
          sid, ri, gi, role,
          lockSet.has(ri + "|" + gi + "|" + role.id + "|" + sid), viol));
      });
      for (let k = got.length; k < role.perGroup; k++) {
        const vac = document.createElement("span");
        vac.className = "role-vacant";
        vac.textContent = "空缺";
        people.appendChild(vac);
      }
      row.appendChild(people);
      row.addEventListener("dragover", (e) => {
        e.preventDefault(); row.classList.add("drag-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
      row.addEventListener("drop", (e) => {
        e.preventDefault(); row.classList.remove("drag-over");
        const sid = e.dataTransfer.getData("text/plain");
        const fromRole = e.dataTransfer.getData("x-role-from");
        const fromGi = parseInt(e.dataTransfer.getData("x-role-group"), 10);
        if (!sid) return;
        if (fromRole && (fromRole !== role.id || fromGi !== gi)) {
          roleMoveMember(sid, ri, fromGi, fromRole, gi, role.id);
        } else if (!fromRole) {
          roleAssignMember(sid, ri, gi, role.id);
        }
      });
      slots.appendChild(row);
    });
    card.appendChild(slots);
    grid.appendChild(card);
  });
}

function renderRolePoolChip(sid) {
  const s = studentOf(sid);
  const chip = document.createElement("span");
  chip.className = "member-chip";
  chip.draggable = true;
  chip.dataset.sid = sid;
  chip.textContent = s ? s.name : "未知成员";
  chip.title = s ? ("编号 " + numOf(sid) +
    (s.tags.length ? " · " + s.tags.join("、") : "")) : "已不在名单中";
  chip.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", sid);
    e.dataTransfer.setData("x-role-from", "");
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => chip.classList.add("dragging"), 0);
  });
  chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  return chip;
}

function renderRoleAssignChip(sid, ri, gi, role, locked, viol) {
  const s = studentOf(sid);
  const chip = document.createElement("span");
  const bad = viol.some(v => v.round === ri && v.group === gi &&
    v.role === role.id && v.people.includes(sid) &&
    (v.type === "qual" || v.type === "lock"));
  chip.className = "role-chip" + (locked ? " locked" : "") + (bad ? " violating" : "");
  chip.draggable = !locked;
  chip.dataset.sid = sid;
  chip.innerHTML = "<span>" + esc(s ? s.name : "未知成员") + "</span>" +
    '<button class="m-lock" title="' + (locked ? "解锁" : "锁定该安排") + '">' +
    (locked ? "🔒" : "🔓") + "</button>" +
    '<button class="m-del" title="移出该角色">✕</button>';
  chip.querySelector(".m-lock").addEventListener("click", (e) => {
    e.stopPropagation(); roleToggleLock(sid, ri, gi, role.id);
  });
  chip.querySelector(".m-del").addEventListener("click", (e) => {
    e.stopPropagation(); roleUnassignMember(sid, ri, gi, role.id);
  });
  chip.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", sid);
    e.dataTransfer.setData("x-role-from", role.id);
    e.dataTransfer.setData("x-role-group", String(gi));
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => chip.classList.add("dragging"), 0);
  });
  chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  return chip;
}

function renderRoleViolations() {
  const d = state.roleDraft;
  const viol = validateRoleDraft();
  const ul = $("#role-violation-list");
  const vs = $("#role-violation-summary");
  if (!viol.length) {
    vs.textContent = "✓ 角色编排无问题";
    vs.className = "ok";
    ul.innerHTML = '<li class="ok">✓ 名额、资格、兼任与锁定检查均通过</li>';
  } else {
    vs.textContent = "⚠ " + viol.length + " 处提示";
    vs.className = "bad";
    ul.innerHTML = "";
    viol.forEach(v => {
      const li = document.createElement("li");
      li.className = (v.type === "vacant" ? "warn" : "bad") + " clickable";
      li.innerHTML = (v.type === "vacant" ? "△ " : "✕ ") + esc(v.message);
      li.title = "点击定位到成员与轮次";
      li.addEventListener("click", () => locateRoleIssue(v));
      ul.appendChild(li);
    });
  }
  $("#role-lock-summary").textContent = d.locks.length
    ? "🔒 " + d.locks.length + " 项安排已锁定"
    : "未锁定任何安排";
}

/* ---------- 成员 × 轮次矩阵 ---------- */
function renderRoleMatrix() {
  const d = state.roleDraft;
  const table = $("#role-matrix");
  const R = d.groups.length;
  const inDraft = new Set();
  d.groups.forEach(rnd => rnd.forEach(g => g.forEach(s => inDraft.add(s))));
  const people = state.students.filter(s => inDraft.has(s.id));
  const cellOf = {};
  people.forEach(s => { cellOf[s.id] = Array.from({ length: R }, () => []); });
  d.assign.forEach((rnd, ri) => rnd.forEach((g) => {
    for (const rid in g) {
      const role = roleById(rid);
      g[rid].forEach(sid => {
        if (cellOf[sid]) cellOf[sid][ri].push(role ? role.name : rid);
      });
    }
  }));
  // 同轮兼任冲突集合
  const ncBad = new Set();
  const pairs = roleNcPairsArr();
  people.forEach(s => {
    for (let ri = 0; ri < R; ri++) {
      const heldRids = [];
      (d.assign[ri] || []).forEach((g) => {
        for (const rid in g) if (g[rid].includes(s.id)) heldRids.push(rid);
      });
      for (const [a, b] of pairs) {
        if (heldRids.includes(a) && heldRids.includes(b)) {
          ncBad.add(s.id + "|" + ri);
          break;
        }
      }
    }
  });
  let html = "<thead><tr><th class='corner'>成员＼轮次</th>";
  for (let ri = 0; ri < R; ri++) {
    html += "<th>" + esc(d.roundNames[ri] || ("第 " + (ri + 1) + " 轮")) + "</th>";
  }
  html += "<th>合计</th></tr></thead><tbody>";
  people.forEach(s => {
    const total = cellOf[s.id].reduce((n, c) => n + c.length, 0);
    html += "<tr><th>" + esc(s.name) + "</th>";
    for (let ri = 0; ri < R; ri++) {
      const c = cellOf[s.id][ri];
      const cls = ncBad.has(s.id + "|" + ri) ? "mcap" : (c.length ? "m1" : "m0");
      html += '<td class="role-cell ' + cls + '" title="' + esc(s.name) + " · " +
        esc(d.roundNames[ri] || "") + (c.length ? "：" + esc(c.join("、")) : "（无角色）") +
        '">' + (c.length ? esc(c.join("、")) : "—") + "</td>";
    }
    html += '<td class="role-total">' + total + "</td></tr>";
  });
  html += "</tbody>";
  table.innerHTML = html;
  $("#role-matrix-legend").textContent =
    "共 " + people.length + " 人参与 · 红底 = 同轮兼任冲突 · 「—」= 该轮无角色 · 末列为担任总人次";
}

/* ---------- 补齐空缺：候选对比 ---------- */
let roleCandidates = null;

$("#btn-role-fill").addEventListener("click", async () => {
  const d = state.roleDraft;
  if (!d) return;
  if (!state.roleTpl.roles.length) { toast("请先定义角色模板", true); return; }
  const btn = $("#btn-role-fill");
  btn.disabled = true;
  btn.textContent = "求解中…";
  try {
    const data = await api("/api/roles/fill", "POST", {
      students: state.students,
      template: state.roleTpl,
      groups: d.groups,
      assign: d.assign,
      locks: d.locks,
      numCandidates: 3,
    });
    if (data.conflicts && data.conflicts.length) {
      const card = $("#role-conflict-card");
      card.classList.remove("hidden");
      const box = $("#role-conflict-list");
      box.innerHTML = "";
      data.conflicts.forEach(c => box.appendChild(buildConflictItem(c)));
      toast(data.conflicts[0].message, true);
      return;
    }
    $("#role-conflict-card").classList.add("hidden");
    showRoleCandidates(data.candidates || [], data.warnings || []);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "⚙ 补齐空缺";
  }
});

function showRoleCandidates(cands, warnings) {
  if (!cands.length) { toast("没有可用的补齐方案", true); return; }
  roleCandidates = cands;
  const bestOf = (fn) => Math.min(...cands.map(c => fn(c.metrics)));
  const best = {
    vac: bestOf(m => m.vacancies),
    qual: bestOf(m => m.qualViolations),
    rep: bestOf(m => m.roleRepeats),
    spread: bestOf(m => m.loadSpread),
  };
  let html = "";
  if (warnings.length) {
    html += '<div class="cand-warnings">' +
      warnings.slice(0, 5).map(w => "<p>△ " + esc(w.message) + "</p>").join("") +
      "</div>";
  }
  html += '<table class="table cmp-table"><thead><tr><th>候选</th><th>空缺</th>' +
    "<th>资格违规</th><th>同轮兼任</th><th>超限</th><th>角色重复</th><th>负担差异</th>" +
    "<th></th></tr></thead><tbody>";
  cands.forEach((c, i) => {
    const m = c.metrics;
    const cls = (v, b) => v === b ? "cmp-best" : "cmp-worst";
    html += "<tr><td>候选 " + (i + 1) + "</td>" +
      '<td class="' + cls(m.vacancies, best.vac) + '">' + m.vacancies + "</td>" +
      '<td class="' + cls(m.qualViolations, best.qual) + '">' + m.qualViolations + "</td>" +
      "<td>" + m.concurrentViolations + "</td>" +
      "<td>" + m.limitViolations + "</td>" +
      '<td class="' + cls(m.roleRepeats, best.rep) + '">' + m.roleRepeats + "</td>" +
      '<td class="' + cls(m.loadSpread, best.spread) + '">' + m.loadSpread + "</td>" +
      '<td><button class="btn primary" data-idx="' + i + '">采用</button></td></tr>';
  });
  html += "</tbody></table>";
  html += '<p class="hint">空缺 = 无人担任的槽位数；资格违规 = 缺所需标签或违反禁任；' +
    "角色重复 = 同一人重复担任同一角色的次数；负担差异 = 担任最多与最少者的人次差。" +
    "采用前的编排可用「撤销」恢复。</p>";
  $("#role-cand-body").innerHTML = html;
  $("#role-cand-modal").classList.remove("hidden");
  $$("#role-cand-body button[data-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const c = roleCandidates[idx];
      pushRoleHistory();
      state.roleDraft.assign = c.assign;
      roleCandidates = null;
      $("#role-cand-modal").classList.add("hidden");
      renderRoles();
      toast("已采用候选 " + (idx + 1) + "，空缺已补齐");
    });
  });
}

$("#role-cand-cancel").addEventListener("click", () => {
  roleCandidates = null;
  $("#role-cand-modal").classList.add("hidden");
});

/* ---------- 确认版本（冻结） ---------- */
$("#btn-role-confirm").addEventListener("click", () => {
  const d = state.roleDraft;
  if (!d) return;
  const viol = validateRoleDraft();
  if (viol.length &&
      !confirm("仍有 " + viol.length + " 处提示未处理，仍要确认并冻结版本吗？")) return;
  const name = "版本 " + (state.roleVersions.length + 1) + " · " +
    new Date().toLocaleString("zh-CN", { hour12: false });
  state.roleVersions.push({
    id: uid("rv"),
    name,
    createdAt: Math.floor(Date.now() / 1000),
    sourceMode: d.sourceMode,
    template: JSON.parse(JSON.stringify(state.roleTpl)),
    groups: JSON.parse(JSON.stringify(d.groups)),
    roundNames: d.roundNames.slice(),
    assign: JSON.parse(JSON.stringify(d.assign)),
    students: state.students.map(s => ({ id: s.id, name: s.name })),
  });
  renderRoleVersions();
  toast("已确认「" + name + "」：来源分组与规则已冻结，需调整请复制为新草稿");
});

function renderRoleVersions() {
  const tbody = $("#role-versions-table tbody");
  tbody.innerHTML = "";
  if (!state.roleVersions.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="hint">暂无已确认版本。' +
      "确认后版本被冻结，只能复制为新草稿再调整。</td></tr>";
    $("#role-version-view").classList.add("hidden");
    return;
  }
  state.roleVersions.forEach(v => {
    const tr = document.createElement("tr");
    const time = new Date(v.createdAt * 1000).toLocaleString("zh-CN", { hour12: false });
    tr.innerHTML = "<td>" + esc(v.name) + "</td><td>" + time + "</td>" +
      "<td>" + v.groups.length + " 轮</td>" +
      "<td>" + (v.sourceMode === "rotation" ? "多轮轮换" : "单轮分组") + "</td>" +
      '<td><button class="btn" data-act="view">查看</button> ' +
      '<button class="btn" data-act="print">🖨 匿名打印</button> ' +
      '<button class="btn" data-act="copy">复制为新草稿</button> ' +
      '<button class="btn ghost danger" data-act="del">删除</button></td>';
    tr.querySelector('[data-act="view"]').addEventListener("click", () => {
      state.roleViewVersion = state.roleViewVersion === v.id ? null : v.id;
      state.roleViewRound = 0;
      renderRoleVersions();
    });
    tr.querySelector('[data-act="print"]').addEventListener("click", () => roleVersionPrint(v));
    tr.querySelector('[data-act="copy"]').addEventListener("click", () => roleCopyVersion(v));
    tr.querySelector('[data-act="del"]').addEventListener("click", () => {
      if (!confirm("删除版本「" + v.name + "」？")) return;
      state.roleVersions = state.roleVersions.filter(x => x !== v);
      if (state.roleViewVersion === v.id) state.roleViewVersion = null;
      renderRoleVersions();
    });
    tbody.appendChild(tr);
  });
  // 只读查看：逐轮角色卡
  const view = $("#role-version-view");
  const v = state.roleVersions.find(x => x.id === state.roleViewVersion);
  if (!v) { view.classList.add("hidden"); return; }
  view.classList.remove("hidden");
  $("#role-version-title").textContent = v.name + "（已冻结 · 只读）";
  if (state.roleViewRound >= v.groups.length) state.roleViewRound = 0;
  const rt = $("#role-version-rounds");
  rt.innerHTML = "";
  v.groups.forEach((_, ri) => {
    const b = document.createElement("button");
    b.className = "round-tab" + (ri === state.roleViewRound ? " active" : "");
    b.textContent = v.roundNames[ri] || ("第 " + (ri + 1) + " 轮");
    b.addEventListener("click", () => { state.roleViewRound = ri; renderRoleVersions(); });
    rt.appendChild(b);
  });
  const grid = $("#role-version-grid");
  grid.innerHTML = "";
  const names = {};
  (v.students || []).forEach(s => { names[s.id] = s.name; });
  const ri = state.roleViewRound;
  v.groups[ri].forEach((grp, gi) => {
    const card = document.createElement("div");
    card.className = "group-card";
    let inner = '<div class="group-head"><h3>第 ' + (gi + 1) + " 组</h3>" +
      '<span class="group-size">' + grp.length + " 人</span></div>";
    inner += '<div class="member-area">' +
      grp.map(sid => '<span class="member-chip">' + esc(names[sid] || "?") + "</span>").join("") +
      "</div>";
    inner += '<div class="role-slots">';
    v.template.roles.forEach(role => {
      const got = (((v.assign[ri] || [])[gi]) || {})[role.id] || [];
      inner += '<div class="role-slot readonly"><span class="role-name">' +
        esc(role.name) + " <em>×" + role.perGroup + "</em></span>" +
        '<span class="role-people">' +
        (got.length
          ? got.map(sid => '<span class="role-chip">' + esc(names[sid] || "?") + "</span>").join("")
          : '<span class="role-vacant">空缺</span>') +
        "</span></div>";
    });
    inner += "</div>";
    card.innerHTML = inner;
    grid.appendChild(card);
  });
}

function roleCopyVersion(v) {
  if (state.roleDraft &&
      !confirm("复制为新草稿将替换当前未确认的草稿，继续？")) return;
  state.roleTpl = JSON.parse(JSON.stringify(v.template));
  state.roleDraft = {
    sourceMode: v.sourceMode,
    fingerprint: roleFingerprint(v.groups),
    groups: JSON.parse(JSON.stringify(v.groups)),
    roundNames: v.roundNames.slice(),
    assign: JSON.parse(JSON.stringify(v.assign)),
    locks: [],
  };
  state.roleActiveRound = 0;
  state.roleHistory = [];
  renderRoleTemplate();
  renderRoles();
  toast("已复制「" + v.name + "」为新草稿，可继续调整");
}

async function roleVersionPrint(v) {
  try {
    const pages = v.groups.map((rnd, ri) => ({
      title: (v.roundNames[ri] || "第 " + (ri + 1) + " 轮") + " · 角色安排",
      groups: rnd.map((grp, gi) => ({
        members: grp.slice(),
        roles: v.template.roles.map(role => ({
          name: role.name,
          people: ((((v.assign[ri] || [])[gi]) || {})[role.id] || []).slice(),
        })),
      })),
    }));
    const data = await api("/api/prints", "POST", {
      mode: "roles",
      title: "角色轮值 · " + v.name,
      students: v.students,
      pages,
    });
    window.open("/print/" + data.id + "?anon=1", "_blank");
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================= 初始化 ================= */
renderRoster();
renderSettings();
ensureRotationRounds(3);
renderRotRoundsTable();
setMode("single");
renderWorkbench();
renderRoleTemplate();
renderRoles();

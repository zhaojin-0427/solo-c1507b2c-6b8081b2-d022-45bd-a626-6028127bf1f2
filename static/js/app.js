/* ============ 约束分组排演台 · 前端逻辑 ============ */
"use strict";

/* ---------------- 全局状态 ---------------- */
const state = {
  students: [],          // {id, name, tags:[]}
  relations: [],         // {id, type:'must'|'cannot', a, b}
  settings: { numGroups: 3, minSize: 3, maxSize: 6, balanceTags: [], numSolutions: 3 },
  solutions: [],         // 后端生成的方案 [{groups, soft, metrics, hardOk}]
  current: -1,           // 当前采用的方案下标
  working: null,         // 当前编排 [[sid...], ...]
  locks: { members: new Set(), groups: new Set() },
  history: [],           // 撤销栈 [{groups, locks}]
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
  if (btn.dataset.tab === "compare") renderCompare();
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
}

/* ================= 关系管理 ================= */
$("#btn-add-relation").addEventListener("click", () => {
  const a = $("#rel-a").value, b = $("#rel-b").value, type = $("#rel-type").value;
  if (!a || !b || a === b) { toast("请选择两名不同的学员", true); return; }
  const dup = state.relations.some(r =>
    (r.a === a && r.b === b) || (r.a === b && r.b === a));
  if (dup) { toast("两人之间已存在关系，请先删除旧关系", true); return; }
  state.relations.push({ id: uid("r"), type, a, b });
  renderRelations();
});

function renderRelations() {
  const ul = $("#relation-list");
  ul.innerHTML = "";
  if (!state.relations.length) {
    ul.innerHTML = '<li class="hint">暂无关系约束</li>';
    return;
  }
  for (const r of state.relations) {
    const li = document.createElement("li");
    li.innerHTML =
      '<span class="rel-badge ' + r.type + '">' + (r.type === "must" ? "必须同组" : "不可同组") + "</span>" +
      '<span class="rel-names">' + esc(nameOf(r.a)) + " ↔ " + esc(nameOf(r.b)) + "</span>" +
      '<button class="icon-btn" title="删除">✕</button>';
    li.querySelector("button").addEventListener("click", () => {
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
}

/* ================= 生成方案 ================= */
$("#btn-generate").addEventListener("click", async () => {
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

function renderConflicts(conflicts) {
  const card = $("#conflict-card");
  card.classList.remove("hidden");
  const box = $("#conflict-list");
  box.innerHTML = "";
  for (const c of conflicts) {
    const div = document.createElement("div");
    div.className = "conflict-item";
    let html = "<p>" + esc(c.message) + "</p>";
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
    box.appendChild(div);
  }
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
      toast(data.conflicts[0].message, true);
      return;
    }
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
function validateWorking() {
  const v = [];
  if (!state.working) return v;
  const { minSize, maxSize } = state.settings;
  state.working.forEach((grp, gi) => {
    if (grp.length < minSize)
      v.push({ type: "size", group: gi, people: [], message: "第 " + (gi + 1) + " 组 " + grp.length + " 人，少于下限 " + minSize + " 人" });
    if (grp.length > maxSize)
      v.push({ type: "size", group: gi, people: [], message: "第 " + (gi + 1) + " 组 " + grp.length + " 人，超出上限 " + maxSize + " 人" });
  });
  const groupOf = {};
  state.working.forEach((grp, gi) => grp.forEach(sid => { groupOf[sid] = gi; }));
  for (const r of state.relations) {
    const ga = groupOf[r.a], gb = groupOf[r.b];
    if (ga === undefined || gb === undefined) continue;
    if (r.type === "cannot" && ga === gb)
      v.push({ type: "cannot", group: ga, people: [r.a, r.b], message: "「" + nameOf(r.a) + "」与「" + nameOf(r.b) + "」不可同组，却都在第 " + (ga + 1) + " 组" });
    if (r.type === "must" && ga !== gb)
      v.push({ type: "must", group: -1, people: [r.a, r.b], message: "「" + nameOf(r.a) + "」（第 " + (ga + 1) + " 组）与「" + nameOf(r.b) + "」（第 " + (gb + 1) + " 组）必须同组" });
  }
  return v;
}

/* 软约束报告（与后端 evaluate_solution 同规则） */
function softReport() {
  const groups = state.working;
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
  for (const tag of state.settings.balanceTags) {
    const counts = groups.map(grp => grp.filter(sid => (tagsOf[sid] || new Set()).has(tag)).length);
    const tot = counts.reduce((a, b) => a + b, 0);
    const mean = tot / g;
    const tlo = Math.floor(mean), thi = Math.ceil(mean);
    counts.forEach((c, gi) => {
      if (c < tlo || c > thi)
        items.push({ warn: true, message: "第 " + (gi + 1) + " 组标签「" + tag + "」为 " + c + " 人，偏离均衡值 " + mean.toFixed(1) + " 人" });
    });
  }
  return items;
}

/* ---------- 渲染排演台 ---------- */
function renderWorkbench() {
  const has = !!state.working;
  $("#wb-empty").classList.toggle("hidden", has);
  $("#wb-main").classList.toggle("hidden", !has);
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
    if (v.group >= 0) badGroups.add(v.group);
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
    await api("/api/saves", "POST", {
      name,
      students: state.students,
      relations: state.relations,
      settings: state.settings,
      solutions: state.solutions,
      working: state.working,
      locks: { members: [...state.locks.members], groups: [...state.locks.groups] },
    });
    $("#save-name").value = "";
    toast("已保存：" + name);
    renderSaves();
  } catch (err) {
    toast(err.message, true);
  }
});

async function renderSaves() {
  const tbody = $("#saves-table tbody");
  tbody.innerHTML = '<tr><td colspan="5" class="hint">加载中…</td></tr>';
  try {
    const data = await api("/api/saves");
    tbody.innerHTML = "";
    if (!data.saves.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="hint">暂无存档</td></tr>';
      return;
    }
    for (const sv of data.saves) {
      const tr = document.createElement("tr");
      const time = new Date(sv.createdAt * 1000).toLocaleString("zh-CN", { hour12: false });
      tr.innerHTML =
        "<td>" + esc(sv.name) + "</td><td>" + time + "</td>" +
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
    tbody.innerHTML = '<tr><td colspan="5" class="hint">加载失败</td></tr>';
  }
}

async function loadSave(id) {
  try {
    const data = await api("/api/saves/" + id);
    state.students = data.students || [];
    state.relations = (data.relations || []).map(r => ({ id: uid("r"), type: r.type, a: r.a, b: r.b }));
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
    renderRoster();
    renderSettings();
    renderWorkbench();
    toast("已恢复存档：" + data.name);
    document.querySelector('.tab[data-tab="workbench"]').click();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================= 初始化 ================= */
renderRoster();
renderSettings();
renderWorkbench();

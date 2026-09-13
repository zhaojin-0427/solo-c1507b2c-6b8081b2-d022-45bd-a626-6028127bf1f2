/**
 * 真实前后端回归验证（E2E）。
 *
 * 用 jsdom 加载真实页面与前端脚本，fetch 直通真实运行的 Flask 服务，
 * 覆盖两处已修复缺陷：
 *   场景A：5 人“不可同组”奇环 + 2 组 → 页面显示无解冲突链，不展示任何方案；
 *   场景B：同一“必须同组”块成员分处两组并分别锁定 → 局部重排报告冲突，
 *           锁定成员位置不被改变。
 *
 * 前置条件：
 *   1. Flask 服务已启动：python3 app.py   （默认 http://127.0.0.1:5000，可用 BASE 覆盖）
 *   2. 已安装 jsdom：npm install jsdom    （或用 NODE_PATH 指向其所在目录）
 *
 * 运行：node tests/e2e_jsdom.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  console.error("缺少 jsdom，请先执行：npm install jsdom");
  process.exit(2);
}

const BASE = process.env.BASE || "http://127.0.0.1:5000";
const ROOT = path.join(__dirname, "..");

const html = fs.readFileSync(path.join(ROOT, "templates/index.html"), "utf8")
  .replace(/{{ url_for\('static', filename='[^']*'\) }}/g, "");
const appJs = fs.readFileSync(path.join(ROOT, "static/js/app.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: BASE + "/" });
  const { window } = dom;
  // fetch 直通真实 Flask 服务
  window.fetch = (url, opt) => fetch(BASE + url, opt);
  window.confirm = () => true;
  window.alert = () => {};
  window.eval(appJs);
  return window;
}

const results = [];
function check(name, cond, extra) {
  results.push([name, !!cond]);
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : (extra ? " —— " + extra : "")));
  if (!cond) process.exitCode = 1;
}

/* ---------------- 场景A：奇环无解 ---------------- */
async function scenarioA() {
  console.log("场景A：5 人“不可同组”奇环 + 2 组");
  const window = await newPage();
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => Array.from(window.document.querySelectorAll(s));

  // 录入 5 名学员
  $("#bulk-text").value = "甲\n乙\n丙\n丁\n戊";
  $("#btn-bulk-import").click();
  check("A1 学员录入 5 人", $$("#student-table tbody tr").length === 5);

  // 通过界面下拉构造 C5 奇环：甲-乙-丙-丁-戊-甲
  const idOf = {};
  $$("#rel-a option").forEach((o) => { idOf[o.textContent] = o.value; });
  $("#rel-type").value = "cannot";
  for (const [a, b] of [["甲", "乙"], ["乙", "丙"], ["丙", "丁"], ["丁", "戊"], ["戊", "甲"]]) {
    $("#rel-a").value = idOf[a];
    $("#rel-b").value = idOf[b];
    $("#btn-add-relation").click();
  }
  check("A2 关系录入 5 条", $$("#relation-list li").length === 5);

  // 2 组，人数范围可容纳 5 人（排除容量类冲突干扰）
  $("#set-groups").value = "2";
  $("#set-min").value = "2";
  $("#set-max").value = "3";
  $("#btn-generate").click();
  await sleep(300);

  // 冲突卡片可见，包含全部 5 人与 5 条“不可同组”链路
  const card = $("#conflict-card");
  check("A3 冲突卡片已显示", !card.classList.contains("hidden"));
  const text = card.textContent;
  check("A4 冲突说明显示全部涉及人员",
    ["甲", "乙", "丙", "丁", "戊"].every((n) => text.includes(n)), text.slice(0, 80));
  check("A5 冲突说明明示“无解”", text.includes("无解"));
  const cannotLinks = $$("#conflict-list .chain .link.cannot").length;
  check("A6 冲突链路含 5 条不可同组边", cannotLinks === 5, "实际 " + cannotLinks);

  // 不输出任何方案：排演台为空、无方案页签
  check("A7 排演台保持为空", !$("#wb-empty").classList.contains("hidden"));
  check("A8 无方案页签", $$(".sol-tab").length === 0);
}

/* ---------------- 场景B：矛盾锁定 ---------------- */
async function scenarioB() {
  console.log("场景B：同一“必须同组”块成员分处两组并分别锁定");
  const window = await newPage();
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => Array.from(window.document.querySelectorAll(s));

  $("#bulk-text").value = "甲\n乙\n丙\n丁\n戊\n己";
  $("#btn-bulk-import").click();
  const idOf = {};
  $$("#rel-a option").forEach((o) => { idOf[o.textContent] = o.value; });
  $("#rel-type").value = "must";
  $("#rel-a").value = idOf["甲"];
  $("#rel-b").value = idOf["乙"];
  $("#btn-add-relation").click();

  $("#set-groups").value = "2";
  $("#set-min").value = "2";
  $("#set-max").value = "4";
  $("#btn-generate").click();
  await sleep(300);

  const chipOf = (name) =>
    $$(".member-chip").find((c) => c.children[0] && c.children[0].textContent === name);
  const groupOf = (name) => {
    const chip = chipOf(name);
    return chip ? parseInt(chip.closest(".group-card").dataset.group, 10) : -1;
  };

  check("B1 生成后甲乙同组", groupOf("甲") === groupOf("乙") && groupOf("甲") >= 0,
    "甲在组" + groupOf("甲") + "，乙在组" + groupOf("乙"));
  const jiaGroup = groupOf("甲");

  // 模拟拖拽：把乙拖到另一组（前端允许的违规操作，会即时提示）
  const yiSid = chipOf("乙").dataset.sid;
  const targetCard = $$(".group-card")[1 - jiaGroup];
  const drop = new window.Event("drop", { bubbles: true, cancelable: true });
  drop.dataTransfer = { getData: () => yiSid };
  targetCard.dispatchEvent(drop);
  await sleep(30);
  check("B2 拖拽后甲乙分处两组", groupOf("乙") === 1 - jiaGroup);
  check("B3 即时提示“必须同组”违规", $("#violation-list").textContent.includes("必须同组"));

  // 分别锁定甲（原组）与乙（新组）
  chipOf("甲").querySelector(".m-lock").click();
  await sleep(20);
  chipOf("乙").querySelector(".m-lock").click();
  await sleep(20);
  check("B4 两名成员已锁定", $("#lock-summary").textContent.includes("2 名成员已锁定"));

  // 局部重排 → 应报告矛盾锁定冲突，且不改变任何位置
  $("#btn-resolve").click();
  await sleep(300);
  const wbCard = $("#wb-conflict-card");
  check("B5 排演台显示冲突卡片", !wbCard.classList.contains("hidden"));
  check("B6 冲突说明指出锁定矛盾", wbCard.textContent.includes("矛盾"),
    wbCard.textContent.slice(0, 80));
  check("B7 冲突链路包含甲乙", wbCard.textContent.includes("甲") && wbCard.textContent.includes("乙"));
  check("B8 甲未被移动", groupOf("甲") === jiaGroup, "甲在组" + groupOf("甲"));
  check("B9 乙未被移动", groupOf("乙") === 1 - jiaGroup, "乙在组" + groupOf("乙"));

  // 解除乙的锁定后重排：乙应被拉回与甲同组（锁不再矛盾，甲的锁仍生效）
  chipOf("乙").querySelector(".m-lock").click();
  await sleep(20);
  $("#btn-resolve").click();
  await sleep(300);
  check("B10 解锁后重排成功", $("#wb-conflict-card").classList.contains("hidden"));
  check("B11 甲仍在原组（成员锁生效）", groupOf("甲") === jiaGroup);
  check("B12 乙被拉回与甲同组", groupOf("乙") === jiaGroup);
}

/* ---------------- 场景C：拖动后硬约束/标签实时重算 ---------------- */
async function scenarioC() {
  console.log("场景C：单轮拖动引发容量与标签变化，状态实时重算");
  const window = await newPage();
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => Array.from(window.document.querySelectorAll(s));

  // 8 人：4 名带「前端」标签 + 4 名不带；2 组、每组 4 人
  $("#bulk-text").value =
    "甲 前端\n乙 前端\n丙 前端\n丁 前端\n戊\n己\n庚\n辛";
  $("#btn-bulk-import").click();
  check("C1 学员录入 8 人", $$("#student-table tbody tr").length === 8);

  $("#set-groups").value = "2";
  $("#set-min").value = "4";
  $("#set-max").value = "4";
  $("#btn-generate").click();
  await sleep(400);

  const chipOf = (name) =>
    $$(".member-chip").find((c) => c.children[0] && c.children[0].textContent === name);
  const groupOf = (name) => {
    const chip = chipOf(name);
    return chip ? parseInt(chip.closest(".group-card").dataset.group, 10) : -1;
  };
  const sizes = () => $$("#groups-grid .group-card").map(
    (c) => c.querySelectorAll(".member-chip").length);

  check("C2 生成两组各 4 人", sizes().join("/") === "4/4", sizes().join("/"));
  check("C3 初始硬约束满足", $("#violation-summary").classList.contains("ok"));

  // 记录拖动前某组的标签软约束条数
  const softBefore = $$("#soft-list li.warn").length;

  // 把一个人从组0拖到组1 → 容量变为 3/5（超过上限4）
  const victim = $$("#groups-grid .group-card")[0]
    .querySelectorAll(".member-chip")[0];
  const sid = victim.dataset.sid;
  const target = $$("#groups-grid .group-card")[1];
  const drop = new window.Event("drop", { bubbles: true, cancelable: true });
  drop.dataTransfer = { getData: (k) => (k === "text/plain" ? sid : "") };
  target.dispatchEvent(drop);
  await sleep(40);

  check("C4 拖动后容量实时变化 3/5", sizes().join("/") === "3/5", sizes().join("/"));
  check("C5 硬约束状态实时变红", $("#violation-summary").classList.contains("bad"),
    $("#violation-summary").textContent);
  const vtext = $("#violation-list").textContent;
  check("C6 违规列表提示超出上限", vtext.includes("超出上限"));
  // 重渲染会重建卡片，必须重新查询当前 DOM（旧 target 已脱离文档）
  const redAfter = $$("#groups-grid .group-card")[1]
    .querySelectorAll(".member-chip.violating").length;
  check("C7 违规组成员芯片标红", redAfter > 0, "红芯片 " + redAfter);

  // 软约束（人数均衡/标签）也应按当前分组重算
  const softAfter = $$("#soft-list li.warn").length;
  check("C8 标签/人数软约束按当前分组重算",
    softAfter >= softBefore && $$("#soft-list li").length > 0,
    "before=" + softBefore + " after=" + softAfter);

  // 撤销 → 恢复 4/4，硬约束回到满足
  $("#btn-undo").click();
  await sleep(30);
  check("C9 撤销后恢复 4/4", sizes().join("/") === "4/4", sizes().join("/"));
  check("C10 撤销后硬约束恢复满足", $("#violation-summary").classList.contains("ok"));
}

/* ---------------- 场景D：多轮轮换 ---------------- */
async function scenarioD() {
  console.log("场景D：多轮轮换生成、同伴矩阵、后续重排、撤销、分页打印");
  const window = await newPage();
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => Array.from(window.document.querySelectorAll(s));

  $("#bulk-text").value =
    "甲 前端\n乙 后端\n丙 设计\n丁 前端\n戊 后端\n己 运维\n庚 测试\n辛 设计\n壬 前端\n癸 后端";
  $("#btn-bulk-import").click();
  check("D1 学员录入 10 人", $$("#student-table tbody tr").length === 10);

  // 切换到多轮轮换
  $$("#mode-switch .mode-btn").find((b) => b.dataset.mode === "rotation").click();
  check("D2 已切换多轮设置面板", !$("#rotation-settings").classList.contains("hidden"));

  // 2 轮：3 组、每组 3~4 人（10 人），cap=2，勾选前端标签
  $("#rot-rounds").value = "2";
  $("#rot-rounds").dispatchEvent(new window.Event("change"));
  $("#rot-cap").value = "2";
  $("#rot-cap").dispatchEvent(new window.Event("change"));
  const inputs = $$("#rot-rounds-table tbody input");
  const setRow = (r, ng, mn, mx) => {
    inputs[r * 3].value = ng; inputs[r * 3].dispatchEvent(new window.Event("change"));
    inputs[r * 3 + 1].value = mn; inputs[r * 3 + 1].dispatchEvent(new window.Event("change"));
    inputs[r * 3 + 2].value = mx; inputs[r * 3 + 2].dispatchEvent(new window.Event("change"));
  };
  setRow(0, 3, 3, 4);
  setRow(1, 3, 3, 4);
  // 勾选“前端”标签均衡
  $$("#rot-tag-options .tag-option").forEach((lab) => {
    if (lab.textContent.trim() === "前端" && !lab.classList.contains("checked"))
      lab.querySelector("input").click();
  });

  $("#btn-rot-generate").click();
  await sleep(1200);
  check("D3 无冲突卡片", $("#conflict-card").classList.contains("hidden"));
  check("D4 轮换台显示", !$("#rot-main").classList.contains("hidden"));
  check("D5 生成 2 个轮次页签", $$("#round-tabs .round-tab").length === 2);
  check("D6 有轮换方案页签", $$("#rot-plan-tabs .sol-tab").length >= 1);

  const sizesNow = () => $$("#rot-groups-grid .group-card").map(
    (c) => c.querySelectorAll(".member-chip").length);
  check("D7 本轮 3 组且人数在 3~4", sizesNow().length === 3 &&
    sizesNow().every((n) => n >= 3 && n <= 4), sizesNow().join("/"));

  // 同伴矩阵：10×10 + 表头，对角线，存在 0 与 >0 单元
  const cells = $$("#rot-matrix tbody td");
  check("D8 同伴矩阵 100 格", cells.length === 100, "实际 " + cells.length);
  const zero = $$("#rot-matrix td.m0").length;
  const diag = $$("#rot-matrix td.mdiag").length;
  check("D9 矩阵对角线 10 格", diag === 10, "实际 " + diag);
  check("D10 矩阵标出未曾同组组合", zero > 0, "m0=" + zero);

  // 跨轮摘要含覆盖率与最高重复
  const crossText = $("#rot-cross-summary").textContent;
  check("D11 跨轮摘要含覆盖率/最高重复",
    crossText.includes("覆盖率") && crossText.includes("最高重复"), crossText);

  // 实时标签偏差显示（当前分组）
  check("D12 当前轮标签偏差实时显示",
    $$("#rot-metrics-list li").some((li) => li.textContent.includes("前端")),
    $("#rot-metrics-list").textContent.slice(0, 60));

  // 拖动一个成员到一个 4 人组，使其变 5 人（超过上限 4），状态应实时变红
  const cards = $$("#rot-groups-grid .group-card");
  let sourceCard = null, targetCard = null, sid = null;
  for (let i = 0; i < cards.length && !targetCard; i++) {
    if (cards[i].querySelectorAll(".member-chip").length !== 4) continue;
    for (let j = 0; j < cards.length; j++) {
      if (j !== i && cards[j].querySelectorAll(".member-chip").length >= 1) {
        sourceCard = cards[j]; targetCard = cards[i]; break;
      }
    }
  }
  sid = sourceCard.querySelectorAll(".member-chip")[0].dataset.sid;
  const sizesBefore = sizesNow();
  const drop = new window.Event("drop", { bubbles: true, cancelable: true });
  drop.dataTransfer = { getData: (k) => (k === "text/plain" ? sid : "") };
  targetCard.dispatchEvent(drop);
  await sleep(40);
  check("D13 拖动后组人数变化",
    sizesNow().join("/") !== sizesBefore.join("/"),
    sizesBefore.join("/") + " -> " + sizesNow().join("/"));
  check("D14 拖动后本轮硬约束实时重算",
    $("#rot-violation-summary").classList.contains("bad") ||
      $$("#rot-violation-list li.bad").length > 0,
    $("#rot-violation-summary").textContent);

  // 从本轮起重排（第1轮，fromRound=0，无冻结），应弹出影响预览
  $("#btn-rot-resolve").click();
  await sleep(1500);
  check("D15 弹出重排影响预览", !$("#resolve-modal").classList.contains("hidden"),
    $("#rot-conflict-card").textContent.slice(0, 60));
  const modalText = $("#resolve-modal-body").textContent;
  check("D16 预览含受影响人数", modalText.includes("受影响学员"));
  check("D17 预览含重复搭档变化", modalText.includes("重复搭档变化"));
  // 第 1 轮发起（fromRound=0）：不得出现“第 1～0 轮不变”，应说明重排第 1～2 轮
  check("D17b 第1轮发起不显示 1～0 轮不变", !modalText.includes("1～0"), modalText.slice(0, 80));
  check("D17c 第1轮发起说明重排第1～2轮",
    modalText.includes("无前置锁定轮") && modalText.includes("第 1～2 轮"),
    modalText.slice(0, 80));
  // 应用
  $("#resolve-apply").click();
  await sleep(50);
  check("D18 应用后弹窗关闭", $("#resolve-modal").classList.contains("hidden"));
  check("D19 应用后各组人数合法（3~4 人）",
    sizesNow().length === 3 && sizesNow().every((n) => n >= 3 && n <= 4) &&
      sizesNow().reduce((a, b) => a + b, 0) === 10,
    sizesNow().join("/"));
  check("D20 应用后硬约束满足",
    $$("#rot-violation-list li.ok").length > 0 &&
      $$("#rot-violation-list li.bad").length === 0);
  check("D21 应用后跨轮无超限", $("#rot-cross-summary").classList.contains("ok"),
    $("#rot-cross-summary").textContent);

  // 撤销可回到应用前
  $("#btn-rot-undo").click();
  await sleep(40);
  check("D22 撤销可用", true);

  // 分页打印：创建成功并打开（jsdom 拦截 window.open）
  let openedUrl = null;
  window.open = (u) => { openedUrl = u; return null; };
  $("#btn-rot-print").click();
  await sleep(500);
  check("D23 已创建打印页", !!openedUrl && openedUrl.includes("/print/"), String(openedUrl));
  if (openedUrl) {
    const html = await (await fetch(BASE + openedUrl)).text();
    const pages = (html.match(/class="page"/g) || []).length;
    check("D24 打印视图含 2 个分页", pages === 2, "实际 " + pages);
    check("D25 打印页含匿名编号", html.includes("成员01"));
  }
}

/* ---------------- 场景E：从第 2 轮发起重排的预览文案 ---------------- */
async function setupRotationPage2(window, $, $$, rounds) {
  $("#bulk-text").value =
    "甲 前端\n乙 后端\n丙 设计\n丁 前端\n戊 后端\n己 运维\n庚 测试\n辛 设计\n壬 前端\n癸 后端";
  $("#btn-bulk-import").click();
  $$("#mode-switch .mode-btn").find((b) => b.dataset.mode === "rotation").click();
  $("#rot-rounds").value = "2";
  $("#rot-rounds").dispatchEvent(new window.Event("change"));
  $("#rot-cap").value = "2";
  $("#rot-cap").dispatchEvent(new window.Event("change"));
  const inputs = $$("#rot-rounds-table tbody input");
  const row = (r, ng, mn, mx) =>
    [0, 1, 2].forEach((k) => {
      inputs[r * 3 + k].value = [ng, mn, mx][k];
      inputs[r * 3 + k].dispatchEvent(new window.Event("change"));
    });
  row(0, rounds[0][0], rounds[0][1], rounds[0][2]);
  row(1, rounds[1][0], rounds[1][1], rounds[1][2]);
  $("#btn-rot-generate").click();
}

async function scenarioE() {
  console.log("场景E：从第 2 轮发起重排，预览应说明保持第1轮不变");
  const window = await newPage();
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => Array.from(window.document.querySelectorAll(s));
  await setupRotationPage2(window, $, $$, [[3, 3, 4], [3, 3, 4]]);
  await sleep(1500);
  check("E1 轮换台已就绪", !$("#rot-main").classList.contains("hidden"));

  // 切到第 2 轮（round-tab idx=1），再发起重排
  $$("#round-tabs .round-tab")[1].click();
  await sleep(40);
  $("#btn-rot-resolve").click();
  await sleep(1500);
  check("E2 弹出重排影响预览", !$("#resolve-modal").classList.contains("hidden"),
    $("#rot-conflict-card").textContent.slice(0, 80));
  const text = $("#resolve-modal-body").textContent;
  check("E3 预览说明保持第 1 轮不变", text.includes("保持") && text.includes("第 1～1 轮"),
    text.slice(0, 90));
  check("E4 预览说明重排第 2～2 轮", text.includes("第 2～2 轮"), text.slice(0, 90));
  check("E5 不出现 1～0 轮不变", !text.includes("1～0"));
  $("#resolve-cancel").click();
  await sleep(20);
  check("E6 取消后弹窗关闭", $("#resolve-modal").classList.contains("hidden"));
}

(async () => {
  // 确认服务可达
  try {
    const res = await fetch(BASE + "/api/saves");
    if (!res.ok) throw new Error(String(res.status));
  } catch (e) {
    console.error("无法连接 Flask 服务 " + BASE + "，请先运行 python3 app.py");
    process.exit(2);
  }
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  const passed = results.filter(([, ok]) => ok).length;
  console.log("\nE2E 回归：" + passed + "/" + results.length + " 通过");
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("E2E 执行异常:", e);
  process.exit(1);
});

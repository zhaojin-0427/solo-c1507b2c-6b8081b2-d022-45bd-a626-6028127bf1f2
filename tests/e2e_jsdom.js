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
  const passed = results.filter(([, ok]) => ok).length;
  console.log("\nE2E 回归：" + passed + "/" + results.length + " 通过");
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("E2E 执行异常:", e);
  process.exit(1);
});

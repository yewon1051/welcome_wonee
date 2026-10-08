import { BAG, POLICY, DEFAULT_BIRTH } from "./seed.js";

/* ---------- 기본 도구 ---------- */
const FB = "https://www.gstatic.com/firebasejs/10.12.2";
const cfg = window.FIREBASE_CONFIG || {};
const configured = !!(cfg.apiKey && cfg.projectId);
// 부부 공용 로그인 계정. Firebase 비밀번호는 PIN 앞에 PIN_PREFIX를 붙인 값이에요 (Firebase는 6자 이상만 받아서).
const LOGIN_EMAIL = window.LOGIN_EMAIL || "family@example.com";
const PIN_PREFIX = "pin-";
const ROOM = "home";
const APP_NAME = "만나기 체크리스트";
const ROLE = { wife: "아내", husband: "남편", both: "같이" };
const LIST_NAME = { bag: "🎒 출산가방", policy: "📋 출산 후 신청" };
const $ = (s) => document.querySelector(s);

const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (["checked", "value", "disabled", "open", "readOnly"].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2400);
}

const pad = (n) => String(n).padStart(2, "0");
const DOW = "일월화수목금토";
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function dayDiff(a, b) { return Math.round((a - b) / 86400000); }
function fmtDay(d) { return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`; }
function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
function safeUrl(u) {
  if (!u) return "";
  const s = String(u).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return "https://" + s;
  return "";
}

/* ---------- 상태 ---------- */
const state = {
  tab: LS.get("cb_tab") === "policy" ? "policy" : "bag",
  filter: "all",
  items: {},
  meta: {},
  me: LS.get("cb_me"),
  status: "connecting",
  statusMsg: "",
  loaded: false,
  metaLoaded: false,
};
let store = null;
let seeding = false;
let setupShown = false;
const closedGroups = new Set(JSON.parse(LS.get("cb_closed") || "[]"));

/* ---------- Firebase ---------- */
let fb = null;
async function fbInit() {
  if (fb) return fb;
  const [appM, authM, fs] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);
  const app = appM.initializeApp(cfg);
  const auth = authM.getAuth(app);
  let db;
  try {
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch (e) {
    db = fs.getFirestore(app);
  }
  fb = { authM, fs, auth, db };
  return fb;
}

// 이 기기에 저장된 로그인 상태를 확인해요 (오프라인이어도 동작).
function savedUser() {
  return new Promise((resolve) => {
    const off = fb.authM.onAuthStateChanged(fb.auth, (u) => { off(); resolve(u); });
  });
}

/* ---------- 저장소: Firebase(공유) / 로컬(체험) ---------- */
function firebaseStore(hd) {
  const { fs, db } = fb;
  const col = fs.collection(db, "rooms", ROOM, "items");
  const metaRef = fs.doc(db, "rooms", ROOM, "meta", "info");
  const fail = (e) => hd.onStatus("error", e && e.code === "permission-denied"
    ? "권한 오류: Firestore 규칙(Rules)과 로그인 계정을 확인하세요."
    : "연결 오류: " + ((e && e.message) || e));
  fs.onSnapshot(col, (snap) => {
    const m = {};
    snap.forEach((d) => { m[d.id] = d.data(); });
    hd.onItems(m);
    hd.onStatus(snap.metadata.fromCache ? "syncing" : "online");
  }, fail);
  fs.onSnapshot(metaRef, (snap) => {
    hd.onMeta(snap.exists() ? snap.data() : null, snap.exists(), !snap.metadata.fromCache);
  }, fail);
  return {
    mode: "shared",
    upsert: (id, d) => fs.setDoc(fs.doc(col, id), d, { merge: true }),
    remove: (id) => fs.deleteDoc(fs.doc(col, id)),
    setMeta: (d) => fs.setDoc(metaRef, d, { merge: true }),
    async seed(entries, meta) {
      const b = fs.writeBatch(db);
      for (const [id, d] of entries) b.set(fs.doc(col, id), d, { merge: true });
      b.set(metaRef, meta, { merge: true });
      await b.commit();
    },
  };
}

function localStore(hd) {
  const key = "cb_local_" + ROOM;
  const load = () => { try { return JSON.parse(LS.get(key) || "null"); } catch (e) { return null; } };
  let data = load() || { items: {}, meta: null };
  const persist = () => LS.set(key, JSON.stringify(data));
  const emit = () => {
    hd.onItems({ ...data.items });
    hd.onMeta(data.meta, !!data.meta, true);
    hd.onStatus("local");
  };
  window.addEventListener("storage", (e) => { if (e.key === key) { data = load() || data; emit(); } });
  setTimeout(emit, 0);
  return {
    mode: "local",
    async upsert(id, d) { data.items[id] = { ...(data.items[id] || {}), ...d }; persist(); emit(); },
    async remove(id) { delete data.items[id]; persist(); emit(); },
    async setMeta(d) { data.meta = { ...(data.meta || {}), ...d }; persist(); emit(); },
    async seed(entries, meta) {
      for (const [id, d] of entries) data.items[id] = { ...d, ...(data.items[id] || {}) };
      data.meta = { ...(data.meta || {}), ...meta };
      persist(); emit();
    },
  };
}

function seedEntries() {
  const out = [];
  let o = 0;
  for (const [list, groups] of [["bag", BAG], ["policy", POLICY]]) {
    for (const g of groups) {
      for (const it of g.items) {
        out.push([it.id, {
          list, group: g.name, title: it.t, note: it.n || "", link: it.link || "",
          offset: typeof it.o === "number" ? it.o : null, when: it.w || "",
          assignee: it.a || "both", order: (o += 10),
        }]);
      }
    }
  }
  return out;
}

const handlers = {
  onItems(m) { state.items = m; state.loaded = true; render(); },
  onMeta(meta, exists, fromServer) {
    state.meta = meta || {};
    if (fromServer) state.metaLoaded = true;
    if (!exists && fromServer && !seeding && store) {
      seeding = true;
      store.seed(seedEntries(), { seeded: true, babyName: "", birthDate: DEFAULT_BIRTH, createdAt: Date.now() })
        .catch((e) => setStatus("error", "기본 리스트를 만들지 못했어요: " + ((e && e.message) || e)))
        .finally(() => { seeding = false; });
    }
    render();
    maybeSetup();
  },
  onStatus(s, msg) { setStatus(s, msg); },
};

function setStatus(s, msg) { state.status = s; state.statusMsg = msg || ""; renderProgress(); }

function connect() {
  setStatus("connecting");
  store = configured ? firebaseStore(handlers) : localStore(handlers);
}

async function save(id, data) {
  if (!store) { toast("아직 연결 중이에요"); return false; }
  try { await store.upsert(id, data); return true; }
  catch (e) { toast("저장하지 못했어요. 연결을 확인하세요."); return false; }
}

/* ---------- 계산 ---------- */
function dueOf(it) {
  if (it.dueDate) return parseDate(it.dueDate);
  const b = parseDate(state.meta && state.meta.birthDate);
  if (b && typeof it.offset === "number") return addDays(b, it.offset);
  return null;
}
function entriesOf(tab) { return Object.entries(state.items).filter(([, it]) => it.list === tab); }
function matches(it) {
  switch (state.filter) {
    case "todo": return !it.done;
    case "done": return !!it.done;
    case "mine": return !it.done && (it.assignee === state.me || it.assignee === "both" || !it.assignee);
    default: return true;
  }
}
function grouped(tab, useFilter) {
  const map = new Map();
  for (const [id, it] of entriesOf(tab)) {
    if (useFilter && !matches(it)) continue;
    const g = it.group || "기타";
    if (!map.has(g)) map.set(g, []);
    map.get(g).push([id, it]);
  }
  const arr = [...map].map(([name, entries]) => {
    entries.sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
    return { name, entries, min: entries[0][1].order || 0 };
  });
  arr.sort((a, b) => a.min - b.min);
  return arr;
}
function groupNames(tab) { return grouped(tab, false).map((g) => g.name); }
function counts(tab) {
  const e = entriesOf(tab);
  return { done: e.filter(([, it]) => it.done).length, total: e.length };
}
function appTitle() {
  const name = state.meta && state.meta.babyName;
  return name ? `${name} ${APP_NAME}` : APP_NAME;
}

/* ---------- 렌더 ---------- */
const STATUS_TXT = {
  connecting: "연결 중…",
  syncing: "☁️ 동기화 중",
  online: "🔄 실시간 공유 중",
  local: "📱 체험 모드 (이 기기에만 저장)",
  error: "⚠️ 연결 문제",
};

function renderTitle() {
  const t = appTitle();
  $("#title").textContent = "🤍 " + t;
  document.title = t;
}

function renderProgress() {
  const c = counts(state.tab);
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const b = parseDate(state.meta && state.meta.birthDate);
  let dd = "";
  if (b) {
    const n = dayDiff(b, today());
    dd = n > 0 ? `출산 D-${n}` : n === 0 ? "출산 D-day" : `출산 후 ${-n}일`;
  }
  const txt = state.status === "error" && state.statusMsg ? state.statusMsg : STATUS_TXT[state.status] || "";
  $("#prog").replaceChildren(
    h("div", { class: "bar" }, h("i", { style: `width:${pct}%` })),
    h("div", { class: "meta" },
      h("span", null, `${c.done} / ${c.total} 완료 (${pct}%)${dd ? " · " + dd : ""}`),
      h("span", { class: "chip-status" + (state.status === "error" ? " error" : "") }, txt)),
  );
}

function renderTabs() {
  $("#tabs").replaceChildren(...["bag", "policy"].map((t) => {
    const c = counts(t);
    return h("button", {
      type: "button", class: state.tab === t ? "on" : "",
      onclick: () => { state.tab = t; LS.set("cb_tab", t); render(); window.scrollTo(0, 0); },
    }, LIST_NAME[t], h("small", null, `${c.done}/${c.total}`));
  }));
}

function renderFilters() {
  const opts = [["all", "전체"], ["todo", "남은 것"], ["mine", "내 것"], ["done", "완료"]];
  $("#filters").replaceChildren(...opts.map(([k, label]) => h("button", {
    type: "button", class: state.filter === k ? "on" : "",
    onclick: () => { state.filter = k; render(); },
  }, label)));
}

function dueTag(it) {
  if (it.done) return null;
  const d = dueOf(it);
  if (!d) return null;
  const n = dayDiff(d, today());
  if (n < 0) return h("span", { class: "tag late" }, `⏰ ${fmtDay(d)} 지남 D+${-n}`);
  if (n <= 7) return h("span", { class: "tag soon" }, `⏰ ${fmtDay(d)} ${n === 0 ? "오늘" : "D-" + n}`);
  return h("span", { class: "tag" }, `🗓 ${fmtDay(d)}까지 권장`);
}

function itemEl(id, it) {
  const done = !!it.done;
  const url = safeUrl(it.link);
  const asg = it.assignee && it.assignee !== "both" ? it.assignee : null;
  return h("div", { class: "item" + (done ? " done" : "") },
    h("label", { class: "chk" },
      h("input", { type: "checkbox", checked: done, "aria-label": it.title, onchange: (e) => toggle(id, e.target.checked) }),
      h("span", { class: "box" })),
    h("div", { class: "body", onclick: () => openEdit(id) },
      h("div", { class: "title" }, it.title),
      it.when ? h("div", { class: "when" }, "📌 " + it.when) : null,
      it.note ? h("div", { class: "note" }, it.note) : null,
      h("div", { class: "tags" },
        asg ? h("span", { class: "tag " + asg }, ROLE[asg] + " 담당") : null,
        dueTag(it)),
      done ? h("div", { class: "who" }, `✓ ${ROLE[it.doneBy] || ""} · ${fmtTime(it.doneAt)}`) : null),
    url ? h("a", { class: "lnk", href: url, target: "_blank", rel: "noopener", title: "바로가기", "aria-label": "바로가기" }, "🔗") : null);
}

function renderList() {
  const root = $("#list");
  const nodes = [];
  if (!configured) {
    nodes.push(h("div", { class: "banner" }, h("b", null, "체험 모드예요"),
      "config.js에 Firebase 설정을 넣고 배포하면 배우자와 실시간으로 공유돼요. 지금 체크한 내용은 이 기기에만 저장돼요."));
  }
  if (state.loaded && !(state.meta && state.meta.birthDate)) {
    nodes.push(h("div", { class: "banner" }, h("b", null, "출산(예정)일을 입력해 주세요"),
      "오른쪽 위 ⚙️ 설정에서 날짜를 저장하면 신청 항목의 권장 기한과 D-day가 계산돼요."));
  }
  if (state.tab === "policy") {
    nodes.push(h("div", { class: "banner" }, h("b", null, "금액·기한은 2026년 기준으로 조사한 내용이에요"),
      "신청 전에 복지로·정부24·고용24의 최신 공고를 꼭 확인하세요. 항목을 눌러 메모·담당·기한을 고칠 수 있어요."));
  }
  if (!state.loaded) {
    nodes.push(h("div", { class: "empty" }, "불러오는 중…"));
  } else {
    const gs = grouped(state.tab, true);
    if (!gs.length) nodes.push(h("div", { class: "empty" }, state.filter === "all" ? "항목이 없어요. ＋ 버튼으로 추가해보세요." : "해당하는 항목이 없어요."));
    for (const g of gs) {
      const all = entriesOf(state.tab).filter(([, it]) => (it.group || "기타") === g.name);
      const d = all.filter(([, it]) => it.done).length;
      const key = state.tab + "|" + g.name;
      const det = h("details", { class: "grp", open: !closedGroups.has(key) },
        h("summary", null, h("span", null, g.name), h("span", { class: "cnt" + (d === all.length ? " full" : "") }, `${d}/${all.length}`)),
        g.entries.map(([id, it]) => itemEl(id, it)),
        h("button", { type: "button", class: "addbtn", onclick: () => openEdit(null, g.name) }, "＋ 이 그룹에 항목 추가"));
      det.addEventListener("toggle", () => {
        if (det.open) closedGroups.delete(key); else closedGroups.add(key);
        LS.set("cb_closed", JSON.stringify([...closedGroups]));
      });
      nodes.push(det);
    }
  }
  root.replaceChildren(...nodes);
}

function renderBadge() {
  const seen = +(LS.get("cb_seen_" + ROOM) || 0);
  const n = Object.values(state.items).filter((it) => it.at > seen && it.by && it.by !== state.me).length;
  const b = $("#badge");
  b.hidden = n === 0;
  b.textContent = n > 99 ? "99+" : String(n);
}

function render() {
  if (!state.me || !store) return;
  renderTitle();
  renderTabs();
  renderProgress();
  renderFilters();
  renderList();
  renderBadge();
}

/* ---------- 동작 ---------- */
function toggle(id, checked) {
  const now = Date.now();
  save(id, {
    done: checked, doneBy: checked ? state.me : "", doneAt: checked ? now : 0,
    by: state.me, at: now, act: checked ? "done" : "undone",
  });
}

/* ---------- 시트(모달) ---------- */
const dlg = $("#dlg");
dlg.addEventListener("click", (e) => { if (e.target === dlg && dlg.dataset.lock !== "1") dlg.close(); });
dlg.addEventListener("cancel", (e) => { if (dlg.dataset.lock === "1") e.preventDefault(); });

function sheet(title, nodes, opts) {
  const lock = !!(opts && opts.lock);
  dlg.dataset.lock = lock ? "1" : "0";
  dlg.replaceChildren(h("div", { class: "sheet" },
    h("h2", null, h("span", null, title), lock ? null : h("button", { type: "button", "aria-label": "닫기", onclick: () => dlg.close() }, "×")),
    nodes));
  if (!dlg.open) dlg.showModal();
}
function closeSheet() { dlg.dataset.lock = "0"; if (dlg.open) dlg.close(); }

function seg(options, value, onpick) {
  const wrap = h("div", { class: "seg" });
  const paint = (v) => [...wrap.children].forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  for (const [v, label] of options) {
    wrap.append(h("button", { type: "button", "data-v": v, onclick: () => { paint(v); onpick(v); } }, label));
  }
  paint(value);
  return wrap;
}

function login() {
  return new Promise((resolve) => {
    const pin = h("input", {
      type: "password", id: "pin", class: "pin", inputmode: "numeric", pattern: "[0-9]*", maxLength: 4,
      autocomplete: "current-password", "aria-label": "비밀번호 숫자 4자리",
    });
    const msg = h("p", { class: "pinmsg", role: "alert" });
    let busy = false;
    const go = async () => {
      const v = pin.value.trim();
      if (!/^\d{4}$/.test(v)) { msg.textContent = "숫자 4자리를 입력하세요."; return; }
      if (busy) return;
      busy = true;
      msg.textContent = "확인 중…";
      try {
        await fb.authM.signInWithEmailAndPassword(fb.auth, LOGIN_EMAIL, PIN_PREFIX + v);
        closeSheet();
        resolve();
      } catch (e) {
        const c = e && e.code;
        msg.textContent = c === "auth/too-many-requests" ? "시도가 너무 많아요. 잠시 뒤에 다시 해보세요."
          : c === "auth/network-request-failed" ? "인터넷 연결을 확인하세요."
          : ["auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password", "auth/user-not-found"].includes(c) ? "비밀번호가 맞지 않아요."
          : "로그인하지 못했어요. (" + (c || e) + ")";
        pin.value = "";
        pin.focus();
      } finally {
        busy = false;
      }
    };
    pin.addEventListener("input", () => {
      pin.value = pin.value.replace(/\D/g, "").slice(0, 4);
      if (pin.value.length === 4) go();
    });
    pin.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    sheet("🔒 " + APP_NAME, [
      h("p", { class: "sub" }, "부부가 같이 정한 비밀번호 숫자 4자리를 입력하세요."),
      pin, msg,
      h("div", { class: "btns" }, h("button", { type: "button", class: "btn pri", onclick: go }, "들어가기")),
    ], { lock: true });
    setTimeout(() => pin.focus(), 50);
  });
}

function askRole() {
  return new Promise((resolve) => {
    const pick = (r) => { state.me = r; LS.set("cb_me", r); closeSheet(); resolve(); };
    sheet("누구로 쓰실래요?", [
      h("p", { class: "sub" }, "체크한 사람이 표시돼요. 나중에 설정에서 바꿀 수 있어요."),
      h("button", { type: "button", class: "big", onclick: () => pick("wife") }, "👩 아내"),
      h("button", { type: "button", class: "big", onclick: () => pick("husband") }, "👨 남편"),
    ], { lock: true });
  });
}

// 아기 이름이나 출산(예정)일이 비어 있으면 처음 한 번 물어봐요.
function maybeSetup() {
  if (setupShown || !state.metaLoaded || !state.me || dlg.open) return;
  const m = state.meta || {};
  if (m.babyName && m.birthDate) return;
  setupShown = true;
  const name = h("input", { type: "text", id: "setName", value: m.babyName || "", maxLength: 20, placeholder: "예: 튼튼이" });
  const birth = h("input", { type: "date", id: "setBirth", value: m.birthDate || "" });
  sheet("처음 설정", [
    h("p", { class: "sub" }, "한 번 저장하면 배우자 화면에도 똑같이 보여요. 나중에 ⚙️ 설정에서 바꿀 수 있어요."),
    h("div", { class: "fld" }, h("label", { for: "setName" }, "아기 이름 (태명) — 제목에 '○○ 만나기 체크리스트'로 보여요"), name),
    h("div", { class: "fld" }, h("label", { for: "setBirth" }, "출산(예정)일"), birth),
    h("div", { class: "btns" },
      h("button", { type: "button", class: "btn", onclick: closeSheet }, "나중에"),
      h("button", { type: "button", class: "btn pri", onclick: async () => {
        try {
          await store.setMeta({ babyName: name.value.trim(), birthDate: birth.value || "" });
          closeSheet();
          toast("저장했어요");
        } catch (e) { toast("저장하지 못했어요. 연결을 확인하세요."); }
      } }, "저장")),
  ]);
}

function openEdit(id, groupName) {
  const it = id ? state.items[id] : null;
  if (id && !it) return;
  const names = groupNames(state.tab);
  const NEW = "__new__";
  let assignee = (it && it.assignee) || "both";
  const title = h("input", { type: "text", value: it ? it.title : "", maxLength: 120, placeholder: "예: 보조배터리" });
  const note = h("textarea", { placeholder: "수량, 준비 상태, 신청 방법 등" });
  note.value = it ? it.note || "" : "";
  const link = h("input", { type: "url", value: it ? it.link || "" : "", placeholder: "https://…", inputmode: "url" });
  const due = h("input", { type: "date", value: it ? it.dueDate || "" : "" });
  const sel = h("select", null, ...names.map((n) => h("option", { value: n }, n)), h("option", { value: NEW }, "＋ 새 그룹 만들기"));
  sel.value = it && names.includes(it.group) ? it.group : groupName && names.includes(groupName) ? groupName : names[0] || NEW;
  const newG = h("input", { type: "text", placeholder: "새 그룹 이름", maxLength: 40, style: "margin-top:6px;display:none" });
  const syncNew = () => { newG.style.display = sel.value === NEW ? "block" : "none"; };
  sel.addEventListener("change", syncNew);
  syncNew();

  const onSave = async () => {
    const t = title.value.trim();
    if (!t) { toast("제목을 입력하세요"); title.focus(); return; }
    const g = sel.value === NEW ? newG.value.trim() : sel.value;
    if (!g) { toast("그룹 이름을 입력하세요"); newG.focus(); return; }
    const now = Date.now();
    const lk = link.value.trim();
    const base = { title: t, note: note.value.trim(), assignee, dueDate: due.value || "", link: lk ? safeUrl(lk) : "", group: g, by: state.me, at: now };
    if (lk && !base.link) { toast("링크 형식을 확인하세요"); return; }
    let ok;
    if (id) ok = await save(id, { ...base, act: "edit" });
    else {
      const maxOrder = Object.values(state.items).reduce((m, x) => Math.max(m, x.order || 0), 0);
      ok = await save("c-" + now.toString(36) + Math.random().toString(36).slice(2, 6),
        { ...base, list: state.tab, order: maxOrder + 10, done: false, custom: true, act: "add" });
    }
    if (ok) closeSheet();
  };
  const onDelete = async () => {
    if (!confirm(`'${it.title}' 항목을 삭제할까요? 배우자 화면에서도 사라져요.`)) return;
    try { await store.remove(id); closeSheet(); toast("삭제했어요"); } catch (e) { toast("삭제하지 못했어요"); }
  };

  const infoLines = [];
  if (it && it.when) infoLines.push(h("div", { class: "warn" }, "📌 " + it.when));
  if (it && it.done) infoLines.push(h("div", { class: "warn" }, `✓ ${ROLE[it.doneBy] || ""}이(가) ${fmtTime(it.doneAt)}에 완료`));

  sheet(id ? "항목 보기 · 수정" : "항목 추가", [
    infoLines,
    h("div", { class: "fld" }, h("label", null, "제목"), title),
    h("div", { class: "fld" }, h("label", null, "메모"), note),
    h("div", { class: "fld" }, h("label", null, "그룹"), sel, newG),
    h("div", { class: "fld" }, h("label", null, "담당"), seg([["both", "같이"], ["wife", "아내"], ["husband", "남편"]], assignee, (v) => { assignee = v; })),
    h("div", { class: "fld" }, h("label", null, state.tab === "policy" ? "기한(직접 지정하면 출산일 기준 자동 계산보다 우선해요)" : "기한 (선택)"), due),
    h("div", { class: "fld" }, h("label", null, "바로가기 링크 (선택)"), link),
    h("div", { class: "btns" },
      id ? h("button", { type: "button", class: "btn danger", onclick: onDelete }, "삭제") : null,
      h("button", { type: "button", class: "btn", onclick: closeSheet }, "취소"),
      h("button", { type: "button", class: "btn pri", onclick: onSave }, "저장")),
  ]);
}

function openUpdates() {
  const rows = Object.values(state.items).filter((it) => it.at && it.by)
    .sort((a, b) => b.at - a.at).slice(0, 30);
  const ACT = { done: "완료", undone: "체크 해제", edit: "수정", add: "추가" };
  const seen = +(LS.get("cb_seen_" + ROOM) || 0);
  sheet("최근 업데이트", [
    h("p", { class: "sub" }, "아내·남편이 최근에 바꾼 항목이에요."),
    rows.length ? h("ul", { class: "ulist" }, rows.map((it) => h("li", null,
      `${it.at > seen && it.by !== state.me ? "🆕 " : ""}${ROLE[it.by] || ""} · ${ACT[it.act] || "변경"}: ${it.title}`,
      h("small", null, `${LIST_NAME[it.list] || ""} · ${ago(it.at)}`))))
      : h("div", { class: "empty" }, "아직 업데이트가 없어요."),
  ]);
  LS.set("cb_seen_" + ROOM, String(Date.now()));
  renderBadge();
}

function openSettings() {
  const name = h("input", { type: "text", value: (state.meta && state.meta.babyName) || "", maxLength: 20, placeholder: "예: 튼튼이" });
  const birth = h("input", { type: "date", value: (state.meta && state.meta.birthDate) || "" });
  sheet("설정", [
    h("div", { class: "fld" }, h("label", null, "나는"), seg([["wife", "👩 아내"], ["husband", "👨 남편"]], state.me, (v) => {
      state.me = v; LS.set("cb_me", v); render();
    })),
    h("div", { class: "fld" }, h("label", null, "아기 이름 (태명)"), name),
    h("div", { class: "fld" }, h("label", null, "출산(예정)일 — 신청 항목의 권장 기한이 이 날짜로 계산돼요"), birth,
      h("div", { class: "btns" }, h("button", { type: "button", class: "btn", onclick: async () => {
        try { await store.setMeta({ babyName: name.value.trim(), birthDate: birth.value || "" }); toast("저장했어요"); }
        catch (e) { toast("저장하지 못했어요"); }
      } }, "이름·날짜 저장"))),
    configured
      ? h("div", { class: "fld" },
        h("div", { class: "warn" }, "비밀번호는 배우자에게만 알려주세요. 신분증 번호·계좌번호 같은 민감한 정보는 메모에 적지 마세요."),
        h("div", { class: "btns" }, h("button", { type: "button", class: "btn danger", onclick: async () => {
          try { await fb.authM.signOut(fb.auth); } catch (e) {}
          location.reload();
        } }, "이 기기에서 로그아웃")))
      : h("div", { class: "warn" }, "지금은 체험 모드예요. README의 설정을 마치면 비밀번호로 로그인해서 같이 쓸 수 있어요."),
  ]);
}

/* ---------- 시작 ---------- */
$("#btnSet").addEventListener("click", () => { if (store) openSettings(); });
$("#btnUpd").addEventListener("click", () => { if (store) openUpdates(); });
$("#fab").addEventListener("click", () => { if (state.me && store) openEdit(null); });

async function boot() {
  renderTitle();
  if (configured) {
    let user = null;
    try {
      await fbInit();
      user = await savedUser();
    } catch (e) {
      sheet("연결하지 못했어요", [h("p", { class: "sub" },
        "인터넷 연결과 config.js 설정을 확인한 뒤 새로고침하세요. (" + ((e && e.code) || (e && e.message) || e) + ")")], { lock: true });
      return;
    }
    if (!user) await login();
  }
  if (!state.me) await askRole();
  connect();
  render();
}
boot();

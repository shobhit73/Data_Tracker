/* App shell: auth flow, navigation, shared helpers. */
const $ = (s) => document.querySelector(s);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(d) { return d || "—"; }
let toastTimer = null;
function toast(msg, ok = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = (ok ? "ok" : "err") + " show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 3500);
}
function toastUndo(msg, undoFn) {
  const t = $("#toast");
  t.textContent = "";
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  const btn = document.createElement("button");
  btn.id = "toast-undo";
  btn.type = "button";
  btn.textContent = "Undo";
  btn.onclick = () => {
    clearTimeout(toastTimer);
    t.className = "";
    guard(undoFn);
  };
  t.appendChild(btn);
  t.className = "ok show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 5000);
}
async function guard(fn) { // wrap async UI actions: surface failures as toasts
  try { return await fn(); } catch (e) { toast(e.message); }
}
async function saveChange(msg, doFn, undoFn, refresh) {
  await guard(async () => {
    await doFn();
    if (undoFn) {
      toastUndo(msg, async () => { await undoFn(); toast("Undone", true); refresh(); });
    } else {
      toast(msg, true);
    }
    refresh();
  });
}
function latestNote(t) {
  const notes = (t.task_notes || []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  return notes[0]
    ? `<span class="note">"${esc(notes[0].note)}" — ${esc(notes[0].author?.name || "sync")}</span>`
    : `<span class="muted">—</span>`;
}

const navIcon = (paths) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const NICON = {
  today:   navIcon(`<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><circle cx="12" cy="15.5" r="1.5" fill="currentColor" stroke="none"/>`),
  clients: navIcon(`<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>`),
  tasks:   navIcon(`<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>`),
  audit:   navIcon(`<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>`),
  data:    navIcon(`<path d="M12 20V10M18 20V4M6 20v-4"/>`),
  team:    navIcon(`<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`),
  mytasks: navIcon(`<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M17 11l2 2 4-4"/>`),
  folder:  navIcon(`<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>`),
  chat:    navIcon(`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`),
};

const NAV = [
  { hash: "today",      label: "Today",         roles: ["admin"],                 group: "",         icon: NICON.today },
  { hash: "clients",    label: "Clients",       roles: ["admin"],                 group: "Manage",   icon: NICON.clients },
  { hash: "open-items", label: "Open Items",    roles: ["admin"],                 group: "Manage",   icon: NICON.tasks },
  { hash: "audit-status", label: "Audit Status", roles: ["admin", "implementor"], group: "Manage",   icon: NICON.audit },
  { hash: "data",       label: "Data",          roles: ["admin", "implementor"],  group: "Insights", icon: NICON.data },
  { hash: "team",       label: "Team",          roles: ["admin"],                 group: "Insights", icon: NICON.team },
  { hash: "my-items",   label: "My Open Items", roles: ["admin", "implementor"],  group: "My space", icon: NICON.mytasks },
  { hash: "my-clients", label: "My Clients",    roles: ["implementor"],           group: "My space", icon: NICON.folder },
  { hash: "feedback",   label: "Feedback",      roles: ["admin", "implementor"],  group: "Connect",  icon: NICON.chat, badge: true },
];

function buildNav(me) {
  let html = "", lastGroup = null;
  NAV.filter((n) => n.roles.includes(me.role)).forEach((n) => {
    if (n.group !== lastGroup) {
      if (n.group) html += `<div class="nav-sec">${n.group}</div>`;
      lastGroup = n.group;
    }
    html += `<a href="#${n.hash}" data-nav="${n.hash}">${n.icon}<span>${n.label}</span>` +
      (n.badge ? `<span class="nav-badge" hidden></span>` : "") + `</a>`;
  });
  $("#nav-items").innerHTML = html;
}

let badgeTimer = null;
function startBadgePolling() {
  clearInterval(badgeTimer);
  refreshMessageBadge();
  // A minute is plenty for messages between colleagues, and costs two small reads.
  badgeTimer = setInterval(() => { if (!document.hidden) refreshMessageBadge(); }, 60000);
}

async function renderRoute() {
  const me = Store.getMe();
  if (!me) return;
  const view = $("#view");
  const home = me.role === "admin" ? "today" : "my-items";
  const hash = location.hash.replace(/^#/, "") || home;
  const [name, arg] = hash.split("/");
  document.querySelectorAll("#nav-items a").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === name));
  view.innerHTML = `<p class="muted">Loading…</p>`;
  const routes = {
    "today":      () => Views.renderToday(view),
    "clients":    () => Views.renderClients(view),
    "client":     () => Views.renderClientDetail(view, Number(arg)),
    "open-items": () => Views.renderOpenItems(view),
    "audit-status": () => Views.renderAuditStatus(view),
    "data":       () => Views.renderData(view, arg),
    "team":       () => Views.renderTeam(view),
    "my-items":   () => Views.renderMyItems(view),
    "my-clients": () => Views.renderMyClients(view),
    "feedback":   () => Views.renderFeedback(view, arg),
  };
  await guard(routes[name] || routes[home]);
}

function showLogin() { $("#login").style.display = "flex"; $("#app").style.display = "none"; }

function showReset() {
  $("#login").style.display = "none";
  $("#app").style.display = "none";
  $("#reset").style.display = "flex";
}

function showApp(me) {
  $("#login").style.display = "none";
  $("#app").style.display = "flex";
  const initial = (me.name || "?").trim().charAt(0).toUpperCase() || "?";
  $("#who").innerHTML = `<span class="ava">${esc(initial)}</span>
    <span class="who-txt"><b>${esc(me.name)}</b><small>${esc(me.role)}</small></span>`;
  buildNav(me);
  renderRoute();
  startBadgePolling();
}

function wireLogin() {
  let mode = "signin";
  const setMode = (m) => {
    mode = m;
    $("#f-name").style.display = m === "signup" ? "block" : "none";
    $("#f-password2").style.display = m === "signup" ? "block" : "none";
    $("#f-password2").required = m === "signup";
    $("#login-submit").textContent = m === "signup" ? "Sign up" : "Sign in";
    $("#tab-signin").classList.toggle("active", m === "signin");
    $("#tab-signup").classList.toggle("active", m === "signup");
  };
  $("#tab-signin").onclick = () => setMode("signin");
  $("#tab-signup").onclick = () => setMode("signup");
  $("#login-form").onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const email = $("#f-email").value, pw = $("#f-password").value;
      if (mode === "signup") {
        if (pw !== $("#f-password2").value) { toast("Passwords don't match"); return; }
        await Store.signUp($("#f-name").value.trim(), email, pw);
        await Store.signIn(email, pw);
      } else {
        await Store.signIn(email, pw);
      }
      const me = await Store.loadMe();
      if (me) { location.hash = ""; showApp(me); }
    });
  };
}

function wireReset() {
  $("#forgot").onclick = (e) => {
    e.preventDefault();
    guard(async () => {
      const email = $("#f-email").value.trim() || prompt("Your @uzio.com email:");
      if (!email) return;
      await Store.resetPassword(email);
      toast("Reset link sent — check your inbox", true);
    });
  };
  $("#reset-form").onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const p1 = $("#r-password").value, p2 = $("#r-password2").value;
      if (p1 !== p2) { toast("Passwords don't match"); return; }
      await Store.updatePassword(p1);
      toast("Password updated", true);
      location.hash = "";
      const me = await Store.loadMe();
      $("#reset").style.display = "none";
      me ? showApp(me) : showLogin();
    });
  };
}

window.addEventListener("hashchange", renderRoute);
window.addEventListener("DOMContentLoaded", async () => {
  wireLogin();
  wireReset();
  $("#signout").onclick = () => guard(async () => {
    clearInterval(badgeTimer);
    await Store.signOut(); location.hash = ""; showLogin();
  });
  Store.onPasswordRecovery(() => showReset());
  if (location.hash.includes("type=recovery")) { showReset(); return; }
  const me = await (Store.loadMe().catch((e) => { toast(e.message); return null; }));
  me ? showApp(me) : showLogin();
});

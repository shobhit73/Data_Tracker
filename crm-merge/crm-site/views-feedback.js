/* Feedback & messages: product feedback board, team announcements, and
   one-to-one messages. Storage and visibility rules live in
   scripts/migrations/2026-10-14-feedback-messages.sql. */
window.Views = window.Views || {};

const FB_TABS = [["board", "Feedback"], ["announce", "Announcements"], ["dm", "Messages"]];
const FB_CATS = [["bug", "Bug"], ["idea", "Idea"], ["question", "Question"], ["other", "Other"]];
const FB_STATUS = [["new", "New", "pill-open"], ["planned", "Planned", "pill-notstarted"],
  ["in_progress", "In progress", "pill-progress"], ["done", "Done", "pill-done"], ["wont_do", "Won't do", "pill-na"]];

function fbWhen(iso) {
  const d = new Date(iso), mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function fbBody(text) {
  // Escaped first, then line breaks — never the other way round.
  return esc(text).replace(/\n/g, "<br>");
}
function fbAvatar(name) {
  return `<span class="ava ava-sm">${esc((name || "?").trim().charAt(0).toUpperCase() || "?")}</span>`;
}

/* Unread count for the nav badge. Cheap enough to poll: two small selects. */
async function refreshMessageBadge() {
  const badge = document.querySelector('[data-nav="feedback"] .nav-badge');
  if (!badge || !Store.getMe()) return;
  try {
    const n = (await Store.listUnread()).length;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = n === 0;
  } catch { badge.hidden = true; }
}

Views.renderFeedback = async (view, tab) => {
  if (!FB_TABS.some(([k]) => k === tab)) tab = "board";
  const me = Store.getMe();
  const isAdmin = me.role === "admin";
  const unread = await Store.listUnread();
  const unreadBy = (pred) => unread.filter(pred).length;
  const counts = {
    board: unreadBy((m) => m.kind === "feedback"),
    announce: unreadBy((m) => m.kind === "broadcast"),
    dm: unreadBy((m) => m.kind === "direct"),
  };
  view.innerHTML = `
    <div class="page-head"><h1>Feedback &amp; messages</h1></div>
    <div class="tabbar">${FB_TABS.map(([k, l]) =>
      `<button type="button" data-fbtab="${k}" class="${k === tab ? "active" : ""}">${l}${counts[k] ? ` <span class="nav-badge inline">${counts[k]}</span>` : ""}</button>`).join("")}</div>
    <div id="fb-body"><p class="muted">Loading…</p></div>`;
  view.querySelectorAll("[data-fbtab]").forEach((b) =>
    (b.onclick = () => { location.hash = "#feedback/" + b.dataset.fbtab; }));
  const body = $("#fb-body");
  if (tab === "board") await fbBoard(body, me, isAdmin);
  else if (tab === "announce") await fbAnnounce(body, me, isAdmin);
  else await fbDirect(body, me);
  refreshMessageBadge();
};

/* Threads shared by the board and announcements: top-level posts with their
   replies underneath, oldest reply first. */
function fbThreads(rows) {
  const tops = rows.filter((m) => !m.parent_id);
  const kids = {};
  rows.filter((m) => m.parent_id).forEach((m) => (kids[m.parent_id] = kids[m.parent_id] || []).push(m));
  Object.values(kids).forEach((l) => l.sort((a, b) => a.created_at.localeCompare(b.created_at)));
  return tops.map((t) => ({ ...t, replies: kids[t.id] || [] }));
}

function fbThreadHtml(t, opts) {
  const st = FB_STATUS.find(([k]) => k === t.status);
  const cat = FB_CATS.find(([k]) => k === t.category);
  const unread = opts.unreadIds.has(t.id) || t.replies.some((r) => opts.unreadIds.has(r.id));
  return `<div class="card fb-post${unread ? " fb-unread" : ""}" data-thread="${t.id}">
    <div class="fb-meta">${fbAvatar(t.sender?.name)}<b>${esc(t.sender?.name || "Someone")}</b>
      <span class="muted">${fbWhen(t.created_at)}</span>
      ${cat ? `<span class="tag">${cat[1]}</span>` : ""}
      <span style="flex:1"></span>
      ${opts.isAdmin && t.kind === "feedback"
        ? `<select class="fb-status" data-id="${t.id}">${FB_STATUS.map(([k, l]) =>
            `<option value="${k}" ${k === t.status ? "selected" : ""}>${l}</option>`).join("")}</select>`
        : st ? `<span class="pill ${st[2]}">${st[1]}</span>` : ""}
    </div>
    <div class="fb-text">${fbBody(t.body)}</div>
    ${t.replies.length ? `<div class="fb-replies">${t.replies.map((r) => `<div class="fb-reply">
        <div class="fb-meta">${fbAvatar(r.sender?.name)}<b>${esc(r.sender?.name || "Someone")}</b>
          <span class="muted">${fbWhen(r.created_at)}</span></div>
        <div class="fb-text">${fbBody(r.body)}</div></div>`).join("")}</div>` : ""}
    <form class="fb-replyform" data-parent="${t.id}">
      <input placeholder="Write a reply…" maxlength="4000" style="max-width:none;flex:1">
      <button type="submit" class="small secondary">Reply</button>
    </form>
  </div>`;
}

async function fbWireThreads(body, kind, rerender) {
  body.querySelectorAll(".fb-replyform").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const input = f.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    f.querySelector("button").disabled = true;
    await guard(async () => {
      await Store.sendMessage({ kind, parent_id: Number(f.dataset.parent), body: text });
      rerender();
    });
    f.querySelector("button").disabled = false;
  }));
  body.querySelectorAll(".fb-status").forEach((s) => (s.onchange = () => guard(async () => {
    await Store.setMessageStatus(Number(s.dataset.id), s.value);
    toast("Status updated", true);
  })));
}

async function fbBoard(body, me, isAdmin) {
  const [rows, unread] = await Promise.all([Store.listMessages("feedback"), Store.listUnread()]);
  const unreadIds = new Set(unread.map((m) => m.id));
  const f = { status: "", cat: "", mine: false };
  body.innerHTML = `
    <form class="card fb-compose" id="fb-new">
      <h2 style="margin-top:0">Share feedback on this product</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="fb-cat">${FB_CATS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        <textarea id="fb-text" rows="3" maxlength="4000" placeholder="What is not working, or what would make your work easier?"></textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:8px"><button type="submit">Post feedback</button></div>
    </form>
    <div class="filter-bar">
      <select id="fb-fstatus"><option value="">All statuses</option>
        ${FB_STATUS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <select id="fb-fcat"><option value="">All types</option>
        ${FB_CATS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <label class="chk"><input type="checkbox" id="fb-mine"> Mine only</label>
      <span id="fb-count" class="muted" style="margin-left:auto"></span>
    </div>
    <div id="fb-list"></div>`;
  const threads = fbThreads(rows);
  const render = () => {
    const list = threads.filter((t) =>
      (!f.status || t.status === f.status) && (!f.cat || t.category === f.cat) &&
      (!f.mine || t.sender_id === me.id));
    $("#fb-list").innerHTML = list.map((t) => fbThreadHtml(t, { isAdmin, unreadIds })).join("") ||
      `<p class="muted">No feedback yet${f.status || f.cat || f.mine ? " matching these filters" : ""}.</p>`;
    $("#fb-count").textContent = `${list.length} of ${threads.length}`;
    fbWireThreads(body, "feedback", () => fbBoard(body, me, isAdmin));
  };
  $("#fb-fstatus").onchange = (e) => { f.status = e.target.value; render(); };
  $("#fb-fcat").onchange = (e) => { f.cat = e.target.value; render(); };
  $("#fb-mine").onchange = (e) => { f.mine = e.target.checked; render(); };
  $("#fb-new").onsubmit = (e) => {
    e.preventDefault();
    const text = $("#fb-text").value.trim();
    if (!text) return;
    guard(async () => {
      await Store.sendMessage({ kind: "feedback", category: $("#fb-cat").value, body: text });
      toast("Thanks — feedback posted", true);
      fbBoard(body, me, isAdmin);
    });
  };
  render();
  await Store.markRead(rows.filter((m) => unreadIds.has(m.id)).map((m) => m.id));
}

async function fbAnnounce(body, me, isAdmin) {
  const [rows, unread] = await Promise.all([Store.listMessages("broadcast"), Store.listUnread()]);
  const unreadIds = new Set(unread.map((m) => m.id));
  body.innerHTML = (isAdmin ? `
    <form class="card fb-compose" id="fb-bc">
      <h2 style="margin-top:0">Announce to the whole team</h2>
      <textarea id="fb-bc-text" rows="3" maxlength="4000" placeholder="Everyone who signs in will see this."></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:8px"><button type="submit">Send to everyone</button></div>
    </form>` : "") + `<div id="fb-list"></div>`;
  const threads = fbThreads(rows);
  $("#fb-list").innerHTML = threads.map((t) => fbThreadHtml(t, { isAdmin, unreadIds })).join("") ||
    `<p class="muted">No announcements yet.</p>`;
  fbWireThreads(body, "broadcast", () => fbAnnounce(body, me, isAdmin));
  await Store.markRead(rows.filter((m) => unreadIds.has(m.id)).map((m) => m.id));
  if (isAdmin) $("#fb-bc").onsubmit = (e) => {
    e.preventDefault();
    const text = $("#fb-bc-text").value.trim();
    if (!text) return;
    if (!confirm("Send this announcement to everyone?")) return;
    guard(async () => {
      await Store.sendMessage({ kind: "broadcast", body: text });
      toast("Announcement sent", true);
      fbAnnounce(body, me, isAdmin);
    });
  };
}

let fbPeer = null;   // the person whose conversation is open
async function fbDirect(body, me) {
  const [rows, users, unread] = await Promise.all([
    Store.listMessages("direct"), Store.listUsers(), Store.listUnread()]);
  const unreadIds = new Set(unread.map((m) => m.id));
  const people = users.filter((u) => u.active && u.id !== me.id);
  const other = (m) => (m.sender_id === me.id ? m.recipient_id : m.sender_id);
  const last = {}, unreadFrom = {};
  rows.forEach((m) => {
    const p = other(m);
    if (!last[p] || m.created_at > last[p].created_at) last[p] = m;
    if (unreadIds.has(m.id)) unreadFrom[p] = (unreadFrom[p] || 0) + 1;
  });
  // People you have talked to first (newest on top), then everyone else by name.
  people.sort((a, b) => (last[b.id]?.created_at || "").localeCompare(last[a.id]?.created_at || "") ||
    a.name.localeCompare(b.name));
  if (!fbPeer || !people.some((p) => p.id === fbPeer)) fbPeer = (people.find((p) => last[p.id]) || people[0] || {}).id;

  body.innerHTML = `<div class="dm">
    <aside class="dm-people card">
      <input id="dm-q" type="search" placeholder="Find a person…" style="max-width:none;width:100%;margin-bottom:8px">
      <div id="dm-list"></div>
    </aside>
    <section class="dm-thread card" id="dm-thread"></section></div>`;

  const renderPeople = (q = "") => {
    $("#dm-list").innerHTML = people.filter((p) => !q || p.name.toLowerCase().includes(q)).map((p) => {
      const l = last[p.id];
      return `<button type="button" class="dm-person${p.id === fbPeer ? " sel" : ""}" data-peer="${p.id}">
        ${fbAvatar(p.name)}<span class="dm-pt"><b>${esc(p.name)}</b>
        <small class="muted">${l ? esc((l.sender_id === me.id ? "You: " : "") + l.body.slice(0, 40)) : esc(p.role)}</small></span>
        ${unreadFrom[p.id] ? `<span class="nav-badge inline">${unreadFrom[p.id]}</span>` : ""}</button>`;
    }).join("") || `<p class="muted">Nobody else is signed up yet.</p>`;
    $("#dm-list").querySelectorAll("[data-peer]").forEach((b) => (b.onclick = () => {
      fbPeer = b.dataset.peer; renderPeople($("#dm-q").value.trim().toLowerCase()); renderThread();
    }));
  };

  const renderThread = () => {
    const peer = people.find((p) => p.id === fbPeer);
    if (!peer) { $("#dm-thread").innerHTML = `<p class="muted">Pick someone to message.</p>`; return; }
    const convo = rows.filter((m) => other(m) === peer.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
    $("#dm-thread").innerHTML = `<div class="dm-head">${fbAvatar(peer.name)}<b>${esc(peer.name)}</b>
        <span class="muted" style="font-size:12px">${esc(peer.email || "")}</span></div>
      <div class="dm-msgs" id="dm-msgs">${convo.map((m) => `<div class="dm-msg ${m.sender_id === me.id ? "out" : "in"}">
          <div class="dm-bubble">${fbBody(m.body)}</div><div class="muted dm-time">${fbWhen(m.created_at)}</div></div>`).join("") ||
        `<p class="muted" style="text-align:center">No messages yet. Say hello.</p>`}</div>
      <form id="dm-form" class="dm-compose">
        <textarea id="dm-text" rows="2" maxlength="4000" placeholder="Message ${esc(peer.name)}…  (Enter to send, Shift+Enter for a new line)"></textarea>
        <button type="submit">Send</button></form>`;
    const box = $("#dm-msgs"); box.scrollTop = box.scrollHeight;
    const send = async () => {
      const text = $("#dm-text").value.trim();
      if (!text) return;
      $("#dm-form button").disabled = true;
      await guard(async () => {
        await Store.sendMessage({ kind: "direct", recipient_id: peer.id, body: text });
        fbDirect(body, me);
      });
    };
    $("#dm-form").onsubmit = (e) => { e.preventDefault(); send(); };
    $("#dm-text").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
    const seen = convo.filter((m) => unreadIds.has(m.id)).map((m) => m.id);
    if (seen.length) {
      Store.markRead(seen).then(refreshMessageBadge);
      seen.forEach((id) => unreadIds.delete(id));
      delete unreadFrom[peer.id];
    }
  };

  $("#dm-q").oninput = (e) => renderPeople(e.target.value.trim().toLowerCase());
  renderPeople();
  renderThread();
}

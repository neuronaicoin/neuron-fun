/* sasa forum: posting, likes, reports and moderation on top of the
   server-rendered pages. Reading works without this script. */
(function () {
  "use strict";
  var data = {};
  try {
    data = JSON.parse(document.getElementById("forum-data").textContent || "{}");
  } catch (e) {}

  // ---------------------------------------------------------------- small helpers
  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
  var toastTimer;
  function toast(msg) {
    var old = $(".toast"); if (old) old.remove();
    clearTimeout(toastTimer);
    var el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); el.textContent = msg;
    document.body.appendChild(el);
    toastTimer = setTimeout(function () { el.remove(); }, 2600);
  }
  var here = location.pathname + location.search.replace(/[?&]fresh=1/, "").replace(/^&/, "?");
  var loginUrl = "/login/?next=" + encodeURIComponent(location.pathname);

  // ---------------------------------------------------------------- theme
  var themeBtn = $("#themeBtn");
  function theme() { return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  // The sun / moon icons swap by CSS; only the label changes here.
  function paintTheme() { if (themeBtn) themeBtn.setAttribute("aria-label", theme() === "light" ? "Switch to dark mode" : "Switch to light mode"); }
  if (themeBtn) themeBtn.onclick = function () {
    var next = theme() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("sasa-theme", next); } catch (e) {}
    paintTheme();
  };
  paintTheme();

  // Drop "?fresh=1" from the address bar (it only skips the cache once).
  if (/[?&]fresh=1/.test(location.search) && history.replaceState) history.replaceState(null, "", here + location.hash);

  // ---------------------------------------------------------------- session (shared with the app)
  var session = null;
  (function () {
    try {
      var cur = localStorage.getItem("sasa-session-current");
      var pick = function (addr) {
        var s = JSON.parse(localStorage.getItem("sasa-session:" + addr) || "null");
        return s && s.token && s.exp * 1000 > Date.now() + 60000 ? { address: addr, token: s.token, exp: s.exp } : null;
      };
      if (cur) session = pick(cur);
      if (!session) {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf("sasa-session:") === 0) {
            var s = pick(k.slice(13));
            if (s && (!session || s.exp > session.exp)) session = s;
          }
        }
      }
    } catch (e) {}
  })();

  // ---------------------------------------------------------------- header: balance and bell (as in the app)
  var acct = $("#acct");
  var WALLET = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/></svg>';
  var PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  if (acct && session) {
    // The app leaves the last known balance behind; show it if it's this wallet's.
    var bal = null;
    try {
      var b = JSON.parse(localStorage.getItem("sasa-balance") || "null");
      if (b && b.address === session.address && typeof b.total === "string" && typeof b.cash === "string") bal = b;
    } catch (e) {}
    acct.className = "acct";
    acct.innerHTML =
      '<a class="main" href="/me/?money=portfolio" aria-label="' + esc(bal ? "Your portfolio: " + bal.total + ", cash " + bal.cash : "Your portfolio") + '">' +
      '<span class="ic">' + WALLET + "</span>" +
      (bal
        ? '<span class="v"><b>' + esc(bal.total) + "</b><small>Cash <em>" + esc(bal.cash) + "</em></small></span>"
        : '<span class="addr">' + esc(short(session.address)) + "</span>") +
      "</a>" +
      '<a class="plus" href="/me/?money=deposit" aria-label="Add money" title="Add money">' + PLUS + "</a>";
  } else if (acct) {
    var a = acct.querySelector("a");
    if (a) a.href = loginUrl;
  }

  var bellWrap = $("#bellWrap"), bellBtn = $("#bellBtn"), bellPop = $("#bellPop"), bellBadge = $("#bellBadge");
  var notes = null;
  function notesApi(path, opts) {
    opts = opts || {};
    return fetch("/api/" + path, {
      method: opts.method || "GET",
      headers: Object.assign({ authorization: "Bearer " + session.token }, opts.body ? { "content-type": "application/json" } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function paintBadge(n) {
    if (!bellBadge) return;
    bellBadge.hidden = !(n > 0);
    bellBadge.textContent = n > 9 ? "9+" : String(n || "");
    if (bellBtn) bellBtn.setAttribute("aria-label", n > 0 ? n + " unread notifications" : "Notifications");
  }
  function ago(iso) {
    var s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
  }
  function paintPop() {
    if (!bellPop) return;
    var list = (notes && notes.notes) || [];
    bellPop.innerHTML = "<h2>Notifications</h2>" +
      (list.length
        ? list.slice(0, 12).map(function (n) {
            var href = /^https?:\/\//.test(n.url || "") ? n.url.replace(/^https?:\/\/[^/]+/, "") : "/me/";
            return '<a class="n' + (n.read ? "" : " u") + '" href="' + esc(href || "/me/") + '">' + esc(n.title) + "<small>" + esc(ago(n.createdAt)) + "</small></a>";
          }).join("")
        : '<div class="e">Nothing yet. Alerts, follows and copy signals show up here.</div>') +
      '<a class="f" href="/me/">Open the app</a>';
  }
  if (session && bellWrap) {
    bellWrap.hidden = false;
    notesApi("notes").then(function (j) { if (j) { notes = j; paintBadge(j.unread || 0); } });
    bellBtn.onclick = function () {
      var open = bellPop.hidden;
      bellPop.hidden = !open;
      bellBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        paintPop();
        if (notes && notes.unread > 0) {
          notesApi("notes/read", { method: "POST", body: { all: true } });
          notes.unread = 0;
          paintBadge(0);
        }
      }
    };
    document.addEventListener("mousedown", function (e) {
      if (!bellPop.hidden && !bellWrap.contains(e.target)) { bellPop.hidden = true; bellBtn.setAttribute("aria-expanded", "false"); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !bellPop.hidden) { bellPop.hidden = true; bellBtn.setAttribute("aria-expanded", "false"); bellBtn.focus(); }
    });
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch("/api/forum/" + path, {
      method: opts.method || "GET",
      headers: Object.assign({ authorization: "Bearer " + session.token }, opts.body ? { "content-type": "application/json" } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) {
          try { localStorage.removeItem("sasa-session:" + session.address); } catch (e) {}
          session = null;
          throw new Error("Please log in again.");
        }
        if (!r.ok) throw new Error(j.error || "Something went wrong. Try again.");
        return j;
      });
    });
  }

  var me = null; // { canPost, reason, mod, admin, likes }
  function loadMe() {
    if (!session || !data.board) return Promise.resolve(null);
    var qs = "board=" + encodeURIComponent(data.board) + (data.thread ? "&thread=" + data.thread : "");
    return api("me?" + qs).then(function (j) { me = j; return j; }).catch(function (e) { if (!session) toast(e.message); return null; });
  }

  // ---------------------------------------------------------------- gates
  function gateLogin(what) {
    return '<div class="gate"><b>Log in to ' + what + '.</b> Anyone can read; posting needs a sasa account.<div style="margin-top:.75rem"><a class="btn" href="' + esc(loginUrl) + '">Log in</a></div></div>';
  }
  function gateHold() {
    return '<div class="gate"><b>Only $' + esc(data.symbol) + ' holders can post here.</b> Buy any amount on any chain and you can join in. It keeps the board free of spam.' +
      '<div style="margin-top:.75rem"><a class="btn" href="' + esc(data.coinUrl || "/terminal/") + '">Buy $' + esc(data.symbol) + '</a></div></div>';
  }

  // ---------------------------------------------------------------- new thread
  var newBtn = $("#newThread");
  if (newBtn) newBtn.onclick = function () { openCompose(); };

  function openCompose() {
    var inner;
    if (!session) inner = gateLogin("start a thread");
    else if (!me) inner = '<p class="hint">Checking…</p>';
    else if (!me.canPost) inner = gateHold();
    else inner =
      '<label class="lbl" for="ctitle">Title</label><input class="inp" id="ctitle" maxlength="120" autocomplete="off" placeholder="What do you want to talk about?"><div class="count" id="tcount">0 / 120</div>' +
      '<label class="lbl" for="cbody">Post</label><textarea id="cbody" rows="7" maxlength="4000" placeholder="Share your view, a question or news. Links are fine; no price promises or spam."></textarea><div class="count" id="bcount">0 / 4000</div>' +
      '<p class="hint" id="chint">A clear title helps people find your thread on Google.</p>' +
      '<button class="btn" style="width:100%;margin-top:.9rem;height:3.25rem" id="cPost" type="button" disabled>Post thread</button>';
    var layer = document.createElement("div");
    layer.innerHTML = '<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="New thread"><div class="sh"><h2>New thread in ' + esc(data.boardName || "sasa") + '</h2><button class="x" type="button" aria-label="Close">×</button></div>' + inner + "</div></div>";
    document.body.appendChild(layer);
    document.body.style.overflow = "hidden";
    var close = function () { layer.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", onKey); if (newBtn) newBtn.focus(); };
    var onKey = function (e) { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    $(".scrim", layer).onclick = function (e) { if (e.target.classList.contains("scrim")) close(); };
    $(".x", layer).onclick = close;
    if (session && !me) { loadMe().then(function () { close(); openCompose(); }); return; }
    var ti = $("#ctitle", layer), bo = $("#cbody", layer), btn = $("#cPost", layer), hint = $("#chint", layer);
    if (!ti) return;
    var check = function () {
      $("#tcount", layer).textContent = ti.value.length + " / 120";
      $("#bcount", layer).textContent = bo.value.length + " / 4000";
      var letters = ti.value.replace(/[^A-Za-z]/g, "");
      var caps = letters.length > 12 && letters === letters.toUpperCase();
      var okT = ti.value.trim().length >= 8, okB = bo.value.trim().length >= 20;
      if (caps) { hint.textContent = "Please don't write the title in capitals."; hint.className = "hint err"; }
      else if (ti.value && !okT) { hint.textContent = "Make the title a little longer (8+ characters)."; hint.className = "hint err"; }
      else if (bo.value && !okB) { hint.textContent = "Write a bit more (20+ characters) so the thread is useful."; hint.className = "hint err"; }
      else { hint.textContent = "A clear title helps people find your thread on Google."; hint.className = "hint"; }
      btn.disabled = !(okT && okB && !caps);
    };
    ti.oninput = check; bo.oninput = check; ti.focus();
    btn.onclick = function () {
      btn.disabled = true; btn.textContent = "Posting…";
      api("threads", { method: "POST", body: { board: data.board, title: ti.value, body: bo.value } })
        .then(function (j) { location.href = j.url + "?fresh=1"; })
        .catch(function (e) { hint.textContent = e.message; hint.className = "hint err"; btn.disabled = false; btn.textContent = "Post thread"; });
    };
  }

  // ---------------------------------------------------------------- thread page
  var replyArea = $("#replyArea");
  function drawReply() {
    if (!replyArea) return;
    if (!session) { replyArea.innerHTML = gateLogin("reply"); return; }
    if (!me) return;
    if (!me.canPost) { replyArea.innerHTML = gateHold(); return; }
    replyArea.innerHTML = '<label class="lbl" for="reply">Your reply</label><textarea id="reply" rows="4" maxlength="4000" placeholder="Be kind. No price promises, no spam."></textarea><div class="count" id="rcount">0 / 4000</div>' +
      '<p class="hint" id="rhint" hidden></p><div style="display:flex;justify-content:flex-end;margin-top:.5rem"><button class="btn" id="sendReply" type="button" disabled>Post reply</button></div>';
    var r = $("#reply"), send = $("#sendReply"), rh = $("#rhint");
    r.oninput = function () { $("#rcount").textContent = r.value.length + " / 4000"; send.disabled = r.value.trim().length < 2; };
    send.onclick = function () {
      send.disabled = true; send.textContent = "Posting…"; rh.hidden = true;
      api("threads/" + data.thread + "/posts", { method: "POST", body: { body: r.value } })
        .then(function (j) {
          var parts = j.url.split("#");
          location.href = parts[0] + "?fresh=1" + (parts[1] ? "#" + parts[1] : "");
        })
        .catch(function (e) { rh.textContent = e.message; rh.className = "hint err"; rh.hidden = false; send.disabled = false; send.textContent = "Post reply"; });
    };
  }

  function wirePosts() {
    $$("article[data-post]").forEach(function (art) {
      var id = Number(art.getAttribute("data-post"));
      var author = art.getAttribute("data-author");
      var hidden = art.getAttribute("data-hidden");
      var isFirst = id === data.firstPost;
      var mine = session && author === session.address;

      var like = $("[data-like]", art);
      if (like) {
        if (me && me.likes && me.likes.indexOf(id) >= 0) { like.classList.add("liked"); like.setAttribute("aria-pressed", "true"); }
        like.onclick = function () {
          if (!session) { toast("Log in to like posts"); return; }
          like.disabled = true;
          api("posts/" + id + "/like", { method: "POST" })
            .then(function (j) { $("span", like).textContent = j.likes; like.classList.toggle("liked", j.liked); like.setAttribute("aria-pressed", String(j.liked)); })
            .catch(function (e) { toast(e.message); })
            .then(function () { like.disabled = false; });
        };
      }
      var rep = $("[data-reply]", art);
      if (rep) rep.onclick = function () {
        var box = $("#reply");
        if (!box) { toast(!session ? "Log in to reply" : "Only $" + data.symbol + " holders can reply"); if (replyArea) replyArea.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
        box.value = "@" + short(author) + " " + box.value.replace(/^@\S+\s/, "");
        box.focus(); box.dispatchEvent(new Event("input"));
      };

      var slot = $("[data-menu]", art);
      if (!slot) return;
      var items = [];
      if (!hidden) items.push(["copy", "Copy link"]);
      if (session && !mine && !hidden) items.push(["report", "Report"]);
      if (mine && !hidden) items.push(["delete", isFirst ? "Delete thread" : "Delete", "danger"]);
      if (me && me.mod && !mine) items.push(hidden === "mod" || hidden === "reports" ? ["unhide", "Show again"] : hidden ? null : ["hide", isFirst ? "Hide thread" : "Hide", "danger"]);
      if (me && me.admin && isFirst) items.push(["pin", data.pinned ? "Unpin thread" : "Pin thread"]);
      items = items.filter(Boolean);
      if (!items.length) return;
      slot.innerHTML = '<button type="button" aria-label="More" aria-haspopup="true" aria-expanded="false">⋯</button><div class="menu-list" hidden>' +
        items.map(function (it) { return '<button type="button" data-act="' + it[0] + '"' + (it[2] ? ' class="' + it[2] + '"' : "") + ">" + it[1] + "</button>"; }).join("") + "</div>";
      var trigger = slot.firstChild, list = slot.lastChild;
      trigger.onclick = function (e) {
        e.stopPropagation();
        var open = list.hidden;
        $$(".menu-list").forEach(function (m) { m.hidden = true; });
        list.hidden = !open; trigger.setAttribute("aria-expanded", String(open));
      };
      $$("[data-act]", list).forEach(function (b) {
        b.onclick = function () {
          list.hidden = true;
          var act = b.getAttribute("data-act");
          if (act === "copy") {
            var link = location.origin + location.pathname + "#p" + id;
            (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { toast("Link copied"); }, function () { toast(link); });
          } else if (act === "report") {
            api("posts/" + id + "/report", { method: "POST" }).then(function () { toast("Reported. Thanks, a moderator will look."); }, function (e) { toast(e.message); });
          } else if (act === "delete") {
            if (!confirm(isFirst ? "Delete this thread? It will disappear for everyone." : "Delete this post?")) return;
            api("posts/" + id, { method: "DELETE" }).then(function (j) { location.href = (j.threadHidden ? "/forum/" : location.pathname) + "?fresh=1"; }, function (e) { toast(e.message); });
          } else if (act === "hide" || act === "unhide") {
            api("posts/" + id + "/hide", { method: "POST", body: { hidden: act === "hide" } }).then(function (j) { location.href = (j.threadHidden ? "/forum/" : location.pathname) + "?fresh=1"; }, function (e) { toast(e.message); });
          } else if (act === "pin") {
            api("threads/" + data.thread + "/pin", { method: "POST", body: { pinned: !data.pinned } }).then(function () { location.href = location.pathname + "?fresh=1"; }, function (e) { toast(e.message); });
          }
        };
      });
    });
    document.addEventListener("click", function () { $$(".menu-list").forEach(function (m) { m.hidden = true; }); });
  }

  if (data.page === "thread" || data.page === "board") {
    if (session) loadMe().then(function () { drawReply(); wirePosts(); });
    else { drawReply(); wirePosts(); }
  }
})();

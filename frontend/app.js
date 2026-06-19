"use strict";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const api = (path, opts) => fetch(path, opts).then(async (r) => {
  let body = null;
  try { body = await r.json(); } catch (_) { /* empty body */ }
  if (!r.ok) {
    const detail = body && body.detail !== undefined ? body.detail : r.statusText;
    throw { status: r.status, detail };
  }
  return body;
});

function detailToText(detail) {
  if (detail == null) return "Request failed.";
  if (typeof detail === "string") return detail;
  if (detail.problems && Array.isArray(detail.problems)) return detail.problems.join(" ");
  try { return JSON.stringify(detail); } catch (_) { return String(detail); }
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "msg" + (el.classList.contains("inline") ? " inline" : "") + (kind ? " " + kind : "");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = {
  indexReady: false,
  indexRunning: false,
};
let ws = null;

// ---------------------------------------------------------------------------
// Status / environment
// ---------------------------------------------------------------------------
async function refreshStatus() {
  const s = await api("/api/status");
  state.indexReady = s.index_ready;
  state.indexRunning = s.index_running;

  renderEnvBadges(s);
  renderFileList(s.staged_files);
  updateIndexButton();

  if (s.index_status && s.index_status !== "idle") setIndexBadge(s.index_status);
  if (s.index_ready) unlockQuery();

  return s;
}

function renderEnvBadges(s) {
  const badges = [];
  badges.push(s.use_mock
    ? `<span class="badge mock" title="USE_MOCK = True">MOCK MODE</span>`
    : `<span class="badge live" title="USE_MOCK = False">LIVE (real .exe)</span>`);

  if (!s.use_mock) {
    const ix = escapeHtml(s.indexer_exe), qx = escapeHtml(s.querier_exe);
    badges.push(s.indexer_present
      ? `<span class="badge live" title="${ix}">indexer ✓</span>`
      : `<span class="badge warn" title="${ix}">indexer ✗</span>`);
    badges.push(s.querier_present
      ? `<span class="badge live" title="${qx}">querier ✓</span>`
      : `<span class="badge warn" title="${qx}">querier ✗</span>`);
    for (const [name, present] of Object.entries(s.support_files || {})) {
      badges.push(present
        ? `<span class="badge live">${escapeHtml(name)} ✓</span>`
        : `<span class="badge warn">${escapeHtml(name)} ✗</span>`);
    }
    const px = escapeHtml(s.prompts_dir || "");
    badges.push(s.prompts_present
      ? `<span class="badge live" title="${px}">prompts ✓</span>`
      : `<span class="badge warn" title="${px}">prompts ✗</span>`);
  }
  $("#envBadges").innerHTML = badges.join("");
}

// ---------------------------------------------------------------------------
// Upload + file list
// ---------------------------------------------------------------------------
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");
const folderInput = $("#folderInput");
const UPLOAD_BATCH = 100; // files per request (stays under the backend's per-upload cap)

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));

dropzone.addEventListener("drop", async (e) => {
  const dt = e.dataTransfer;
  // webkitGetAsEntry() must be read synchronously — the items are invalid after
  // this handler returns — so collect the entries first, then traverse async.
  const entries = [];
  if (dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === "function") {
    for (const item of dt.items) {
      const entry = item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
  }
  if (entries.length) {
    setMsg($("#uploadMsg"), "Reading folder…", "info");
    const files = (await Promise.all(entries.map(readAllFiles))).flat();
    handleFiles(files);
  } else {
    handleFiles(dt.files); // browsers without the entry API
  }
});

fileInput.addEventListener("change", () => { handleFiles(fileInput.files); fileInput.value = ""; });
$("#browseFolderBtn").addEventListener("click", () => folderInput.click());
folderInput.addEventListener("change", () => { handleFiles(folderInput.files); folderInput.value = ""; });

// Recursively collect every File under a dropped FileSystemEntry (file or dir).
function readAllFiles(entry) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => resolve([f]), () => resolve([]));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const collected = [];
      const readBatch = () => reader.readEntries((batch) => {
        if (!batch.length) {                       // readEntries returns [] when exhausted
          Promise.all(collected.map(readAllFiles)).then((nested) => resolve(nested.flat()));
          return;
        }
        collected.push(...batch);                  // it returns max ~100 at a time, so keep going
        readBatch();
      }, () => resolve([]));
      readBatch();
    } else {
      resolve([]);
    }
  });
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const txt = files.filter((f) => f.name.toLowerCase().endsWith(".txt"));
  const skippedCount = files.length - txt.length;

  if (!txt.length) {
    setMsg($("#uploadMsg"), "Only .txt files are accepted; nothing uploaded.", "err");
    return;
  }

  let savedTotal = 0;
  const rejected = [];
  try {
    // Upload in batches so an arbitrarily large folder works (and shows progress).
    for (let i = 0; i < txt.length; i += UPLOAD_BATCH) {
      const batch = txt.slice(i, i + UPLOAD_BATCH);
      const done = Math.min(i + batch.length, txt.length);
      setMsg($("#uploadMsg"), `Uploading ${done}/${txt.length}…`, "info");
      const form = new FormData();
      batch.forEach((f) => form.append("files", f, f.name));
      const res = await api("/api/upload", { method: "POST", body: form });
      savedTotal += res.saved.length;
      if (res.rejected) rejected.push(...res.rejected);
      renderFileList(res.files);
    }
    let note = `Added ${savedTotal} file(s).`;
    if (skippedCount) note += ` Skipped ${skippedCount} non-.txt file(s).`;
    if (rejected.length) {
      const detail = rejected.slice(0, 5).map((r) => r.reason ? `${r.name} — ${r.reason}` : r.name).join("; ");
      note += ` ${rejected.length} rejected: ${detail}${rejected.length > 5 ? "…" : ""}.`;
    }
    setMsg($("#uploadMsg"), note, (skippedCount || rejected.length) ? "err" : "ok");
  } catch (err) {
    setMsg($("#uploadMsg"), "Upload failed: " + detailToText(err.detail), "err");
  }
  updateIndexButton();
}

function renderFileList(files) {
  const list = $("#fileList");
  list.innerHTML = "";
  (files || []).forEach((f) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = f.name;
    const size = document.createElement("span");
    size.className = "fsize";
    size.textContent = fmtSize(f.size);
    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.title = "Remove";
    btn.innerHTML = "&times;";
    btn.addEventListener("click", () => removeFile(f.name));
    li.append(name, size, btn);
    list.appendChild(li);
  });
  state.fileCount = (files || []).length;
  updateIndexButton();
}

async function removeFile(name) {
  try {
    const res = await api("/api/files/" + encodeURIComponent(name), { method: "DELETE" });
    renderFileList(res.files);
  } catch (err) {
    setMsg($("#uploadMsg"), "Could not remove file: " + detailToText(err.detail), "err");
  }
}

function updateIndexButton() {
  $("#runIndexBtn").disabled = state.indexRunning || !(state.fileCount > 0);
  $("#clearOutputBtn").disabled = state.indexRunning; // never clear mid-run
  syncPipeline();
}

// ---------------------------------------------------------------------------
// Indexing + live log stream
// ---------------------------------------------------------------------------
const logConsole = $("#logConsole");

function appendLogLine(line) {
  const span = document.createElement("span");
  let cls = "";
  if (/^\[runner\]/.test(line)) cls = "l-runner";
  else if (/error|traceback|exception|failed/i.test(line)) cls = "l-err";
  else if (/success|complete|finished/i.test(line)) cls = "l-ok";
  if (cls) span.className = cls;
  span.textContent = line + "\n";
  const atBottom = logConsole.scrollHeight - logConsole.scrollTop - logConsole.clientHeight < 40;
  logConsole.appendChild(span);
  if (atBottom) logConsole.scrollTop = logConsole.scrollHeight;
}

function setIndexBadge(status) {
  const badge = $("#indexBadge");
  badge.className = "status-badge " + status;
  badge.textContent = status;
  syncPipeline();
}

$("#clearLogBtn").addEventListener("click", () => { logConsole.innerHTML = ""; });

$("#runIndexBtn").addEventListener("click", runIndexing);

$("#clearOutputBtn").addEventListener("click", clearOutput);

async function clearOutput() {
  if (!confirm("Delete all indexed artifacts in msgragtest/output?\nThis can't be undone — you'd have to re-index.")) return;
  $("#clearOutputBtn").disabled = true;
  try {
    const res = await api("/api/output/clear", { method: "POST" });
    state.indexReady = res.index_ready;
    setMsg($("#indexMsg"), "Output cleared.", "ok");
    if (!res.index_ready) lockQuery();
  } catch (err) {
    setMsg($("#indexMsg"), "Could not clear output: " + detailToText(err.detail), "err");
  } finally {
    updateIndexButton();
  }
}

async function runIndexing() {
  setMsg($("#indexMsg"), "", "");
  logConsole.innerHTML = "";
  $("#runIndexBtn").disabled = true;

  let started;
  try {
    started = await api("/api/index/start", { method: "POST" });
  } catch (err) {
    setMsg($("#indexMsg"), "Cannot start: " + detailToText(err.detail), "err");
    state.indexRunning = false;
    updateIndexButton();
    return;
  }

  state.indexRunning = true;
  setIndexBadge("running");
  setMsg($("#indexMsg"), `Indexing ${started.file_count} file(s)…`, "info");
  openLogSocket();
}

function openLogSocket() {
  if (ws) { try { ws.close(); } catch (_) {} }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/index`);

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "line") {
      appendLogLine(msg.data);
    } else if (msg.type === "status") {
      onIndexFinished(msg.data);
    } else if (msg.type === "error") {
      appendLogLine("[runner] " + msg.data);
    }
  };
  ws.onerror = () => appendLogLine("[runner] WebSocket error — falling back to polling.");
  ws.onclose = () => {
    // If we closed before a terminal status arrived, poll once to settle state.
    if (state.indexRunning) pollIndexStatus();
  };
}

async function pollIndexStatus() {
  try {
    const s = await api("/api/index/status");
    if (s.status && s.status !== "running" && s.status !== "idle") {
      onIndexFinished({ status: s.status, returncode: s.returncode, error: s.error });
    }
  } catch (_) { /* ignore */ }
}

function onIndexFinished(data) {
  if (!state.indexRunning && $("#indexBadge").textContent === data.status) return;
  state.indexRunning = false;
  setIndexBadge(data.status);
  updateIndexButton();

  if (data.status === "success") {
    setMsg($("#indexMsg"), "Indexing complete. You can query now.", "ok");
    state.indexReady = true;
    unlockQuery();
  } else {
    const reason = data.error || (data.returncode != null ? `exit code ${data.returncode}` : "unknown error");
    setMsg($("#indexMsg"), "Indexing failed: " + reason, "err");
  }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------
function unlockQuery() {
  $("#card-query").classList.remove("disabled");
  $("#queryHint").textContent = "Ask as many questions as you like — no need to re-index.";
  syncPipeline();
}

function lockQuery() {
  $("#card-query").classList.add("disabled");
  $("#queryHint").textContent = "Finish indexing to unlock querying.";
  syncPipeline();
}

$("#queryBtn").addEventListener("click", runQuery);
$("#queryInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(); });

async function runQuery() {
  if (state.queryInFlight) return;   // guard against Enter-spam / double-submit
  const query = $("#queryInput").value.trim();
  if (!query) { setMsg($("#queryMsg"), "Type a question first.", "err"); return; }

  state.queryInFlight = true;
  $("#queryBtn").disabled = true;
  setMsg($("#queryMsg"), "", "");
  const pending = renderPendingAnswer(query);

  try {
    const res = await api("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    fillAnswer(pending, res);
    if (res.ok) $("#queryInput").value = "";
  } catch (err) {
    fillAnswer(pending, { ok: false, query, error: detailToText(err.detail), raw_output: "" });
  } finally {
    state.queryInFlight = false;
    $("#queryBtn").disabled = false;
  }
}

function renderPendingAnswer(query) {
  const card = document.createElement("div");
  card.className = "answer";
  card.innerHTML = `
    <div class="a-q"></div>
    <div class="a-body"><span class="spinner"></span>Running query…</div>`;
  card.querySelector(".a-q").textContent = query;
  $("#answers").prepend(card);
  return card;
}

function fillAnswer(card, res) {
  card.classList.toggle("is-error", !res.ok);
  const body = card.querySelector(".a-body");
  if (res.ok) {
    body.textContent = res.answer || "(empty response)";
  } else {
    body.textContent = "Error: " + (res.error || "query failed");
  }
  if (res.raw_output) {
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "raw output";
    const pre = document.createElement("pre");
    pre.className = "raw";
    pre.textContent = res.raw_output;
    det.append(sum, pre);
    card.appendChild(det);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  try {
    const s = await refreshStatus();
    const js = await api("/api/index/status");
    if (js.status === "running") {
      // The WebSocket subscribe() replays the full buffer, so do NOT also
      // prefill from REST here or every backlogged line renders twice.
      logConsole.innerHTML = "";
      state.indexRunning = true;
      setIndexBadge("running");
      openLogSocket();
    } else {
      (js.lines || []).forEach(appendLogLine);   // show the last run's log
      if (js.status && js.status !== "idle") setIndexBadge(js.status);
    }
  } catch (err) {
    document.body.insertAdjacentHTML("afterbegin",
      `<div class="msg err" style="padding:12px 24px">Could not reach backend: ${detailToText(err.detail)}</div>`);
  }
})();

// ---------------------------------------------------------------------------
// Pipeline node markers (corpus → graph → query). Purely visual: reads the
// existing state and lights each spine node. Never throws if markers are absent.
// ---------------------------------------------------------------------------
function syncPipeline() {
  const set = (id, s) => { const el = document.getElementById(id); if (el) el.dataset.state = s; };
  const filesReady = (state.fileCount || 0) > 0;

  set("node-corpus", filesReady ? "done" : "active");

  const badge = document.getElementById("indexBadge");
  const st = badge ? badge.textContent.trim() : "";
  if (state.indexRunning || st === "running") set("node-graph", "running");
  else if (state.indexReady) set("node-graph", "done");
  else if (st === "failed" || st === "error") set("node-graph", "error");
  else set("node-graph", filesReady ? "active" : "locked");

  const q = document.getElementById("card-query");
  set("node-query", q && !q.classList.contains("disabled") ? "active" : "locked");
}

// ---------------------------------------------------------------------------
// Ambient knowledge-graph field behind the hero — drifting amber nodes joined
// by faint periwinkle edges. Static single frame under reduced-motion.
// ---------------------------------------------------------------------------
function initGraphField() {
  const canvas = document.getElementById("graphField");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NODE = "245, 195, 107";   // amber (entities)
  const EDGE = "138, 169, 255";   // periwinkle (relationships)
  let w = 0, h = 0, nodes = [], linkDist = 130, raf = 0, resizeTimer = 0;

  function build() {
    const host = canvas.parentElement;
    w = host.clientWidth;
    h = host.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, w * dpr);
    canvas.height = Math.max(1, h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    linkDist = Math.max(110, Math.min(175, w / 9));
    const count = Math.round(Math.max(24, Math.min(62, (w * h) / 14000)));
    nodes = [];
    for (let i = 0; i < count; i++) {
      nodes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: Math.random() * 1.4 + 1.1,
        bright: Math.random() < 0.27,
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < linkDist) {
          ctx.strokeStyle = `rgba(${EDGE}, ${((1 - d / linkDist) * 0.22).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    for (const n of nodes) {
      ctx.shadowBlur = n.bright ? 9 : 0;
      ctx.shadowColor = `rgba(${NODE}, 0.9)`;
      ctx.fillStyle = n.bright ? `rgb(${NODE})` : `rgba(${NODE}, 0.5)`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  function step() {
    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    }
    draw();
    raf = requestAnimationFrame(step);
  }

  function start() {
    cancelAnimationFrame(raf);
    build();
    draw();
    if (!reduce) raf = requestAnimationFrame(step);
  }

  start();
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(start, 200); });
  window.addEventListener("load", () => setTimeout(start, 60)); // re-fit once webfonts settle the hero height
}

initGraphField();


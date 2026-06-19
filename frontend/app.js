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
let graphFX = null;   // hero graph-field controller (set at boot) — lets the pipeline make the constellation react

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
    btn.setAttribute("aria-label", "Remove " + f.name);
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

// --- indexing progress: a guaranteed-correct elapsed timer + a best-effort
// phase label scraped from the log stream (GraphRAG prints its workflow names).
let indexStart = 0, indexTick = 0, indexPhase = "";
function startIndexProgress() {
  indexStart = Date.now();
  indexPhase = "";
  const el = $("#indexProgress");
  if (el) el.hidden = false;
  logConsole.classList.add("is-live");      // blinking caret at the live log tail (#6)
  renderIndexProgress();
  clearInterval(indexTick);
  indexTick = setInterval(renderIndexProgress, 1000);
}
function stopIndexProgress() {
  clearInterval(indexTick); indexTick = 0;
  const el = $("#indexProgress");
  if (el) el.hidden = true;
  logConsole.classList.remove("is-live");
}
function setIndexPhase(p) {
  if (state.indexRunning && p && p !== indexPhase) { indexPhase = p; renderIndexProgress(); }
}
function renderIndexProgress() {
  const el = $("#indexProgress");
  if (!el || !indexStart) return;
  const secs = Math.max(0, Math.round((Date.now() - indexStart) / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  el.textContent = indexPhase ? `${indexPhase} · ${mm}:${ss}` : `elapsed ${mm}:${ss}`;
}

function appendLogLine(line) {
  if (state.indexRunning) {
    const m = line.match(/\b(?:running\s+workflow|workflow|executing|phase)\b[:\s]+["']?([A-Za-z0-9_][\w .\-]{2,46})/i);
    if (m) setIndexPhase(m[1].replace(/["'].*$/, "").trim());
  }
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
    const statsEl = $("#indexStats");
    if (statsEl) statsEl.hidden = true;
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
  const statsEl = $("#indexStats");
  if (statsEl) statsEl.hidden = true;
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
  startIndexProgress();
  graphFX?.setBusy(true);
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
  stopIndexProgress();
  graphFX?.setBusy(false);
  setIndexBadge(data.status);
  updateIndexButton();

  if (data.status === "success") {
    setMsg($("#indexMsg"), "Indexing complete. You can query now.", "ok");
    state.indexReady = true;
    unlockQuery();
    graphFX?.bloom();
    showIndexStats();
  } else {
    const reason = data.error || (data.returncode != null ? `exit code ${data.returncode}` : "unknown error");
    setMsg($("#indexMsg"), "Indexing failed: " + reason, "err");
  }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

// ---------------------------------------------------------------------------
// Post-index instrument readout — counts up the stats the backend can vouch for
// (#4). Renders only fields that came back. The animated numbers are aria-hidden
// and the final figures are announced once via an sr-only summary, so the count-up
// never floods the #indexStats live region (same decoupling as the answer stream).
// ---------------------------------------------------------------------------
async function showIndexStats() {
  const host = $("#indexStats");
  if (!host) return;
  let stats;
  try { stats = await api("/api/index/stats"); } catch (_) { host.hidden = true; return; }

  const cells = [];
  const add = (v, label) => { if (typeof v === "number" && isFinite(v) && v >= 0) cells.push({ v, label }); };
  add(stats.documents, "documents");
  add(stats.entities, "entities");
  add(stats.relationships, "relationships");
  add(stats.communities, "communities");
  if (!cells.length) { host.hidden = true; return; }

  host.innerHTML = "";
  const mkCell = (text, label, extraClass) => {
    const cell = document.createElement("div");
    cell.className = "stat-cell";
    cell.setAttribute("aria-hidden", "true");   // visual only — the sr-only summary speaks
    const val = document.createElement("span");
    val.className = "stat-val" + (extraClass ? " " + extraClass : "");
    val.textContent = text;
    const lab = document.createElement("span");
    lab.className = "stat-label";
    lab.textContent = label;
    cell.append(val, lab);
    host.appendChild(cell);
    return val;
  };

  for (const c of cells) countUp(mkCell("0", c.label), c.v, 950);

  let timeStr = "";
  if (indexStart) {
    const secs = Math.max(1, Math.round((Date.now() - indexStart) / 1000));
    timeStr = String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
    mkCell(timeStr, "index time", "stat-time");
  }

  const sr = document.createElement("span");
  sr.className = "sr-only";
  sr.textContent = "Index complete: " + cells.map((c) => `${c.v} ${c.label}`).join(", ") +
    (timeStr ? `, index time ${timeStr}` : "") + ".";
  host.appendChild(sr);
  host.hidden = false;
}

function countUp(el, target, dur) {
  if (prefersReducedMotion() || target <= 0) { el.textContent = String(target); return; }
  const t0 = performance.now();
  (function frame() {
    const t = Math.min(1, (performance.now() - t0) / dur);
    el.textContent = String(Math.round((1 - Math.pow(1 - t, 3)) * target));
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = String(target);
  })();
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
  state.queryAnswered = false;     // a fresh index hasn't been queried yet
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
  graphFX?.pulse();
  graphFX?.setBusy(true);   // energize the field while the graph "thinks"
  syncPipeline();           // light the query node as running (spins its ring)

  try {
    const res = await api("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    fillAnswer(pending, res);
    if (res.ok) { $("#queryInput").value = ""; state.queryAnswered = true; }
  } catch (err) {
    fillAnswer(pending, { ok: false, query, error: detailToText(err.detail), raw_output: "" });
  } finally {
    state.queryInFlight = false;
    $("#queryBtn").disabled = false;
    graphFX?.setBusy(false);
    syncPipeline();          // settle the query node back to active
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

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// Reveal `text` into `el` like the graph is speaking — a progressive char reveal
// trailing a blinking periwinkle caret. The per-frame chunk scales with length so
// total time stays ~capped (long answers don't crawl). Instant under reduced-motion.
function streamAnswer(el, text, onDone) {
  el.textContent = "";
  if (!text || prefersReducedMotion()) { el.textContent = text || ""; if (onDone) onDone(); return; }

  const textNode = document.createTextNode("");
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.setAttribute("aria-hidden", "true");
  el.append(textNode, caret);

  const perFrame = Math.max(1, Math.ceil(text.length / (1400 / 16)));   // ≈1.4s ceiling at 60fps
  let i = 0;
  (function tick() {
    i = Math.min(text.length, i + perFrame);
    textNode.nodeValue = text.slice(0, i);
    if (i < text.length) requestAnimationFrame(tick);
    else { caret.remove(); if (onDone) onDone(); }
  })();
}

function fillAnswer(card, res) {
  card.classList.toggle("is-error", !res.ok);
  const body = card.querySelector(".a-body");

  const appendRaw = () => {
    if (!res.raw_output) return;
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "raw output";
    const pre = document.createElement("pre");
    pre.className = "raw";
    pre.textContent = res.raw_output;
    det.append(sum, pre);
    card.appendChild(det);
  };

  if (!res.ok) {                       // errors appear at once — never stream a failure
    body.textContent = "Error: " + (res.error || "query failed");
    appendRaw();
    return;
  }

  const answer = res.answer || "(empty response)";
  // Decouple the visual stream from the a11y announcement: hide the typing churn
  // from screen readers (the #answers region is aria-live), and announce the full
  // answer exactly once via a polite sr-only node.
  card.classList.add("is-streaming");
  body.setAttribute("aria-hidden", "true");
  const sr = document.createElement("span");
  sr.className = "sr-only";
  sr.textContent = answer;
  card.appendChild(sr);

  flowSpark("node-query");   // signal shoots down the spine from the query node as the answer begins to stream
  streamAnswer(body, answer, () => {
    card.classList.remove("is-streaming");
    body.removeAttribute("aria-hidden");
    sr.remove();
    appendRaw();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const s = await refreshStatus();
    const js = await api("/api/index/status");
    if (js.status === "running") {
      // The WebSocket subscribe() replays the full buffer, so do NOT also
      // prefill from REST here or every backlogged line renders twice.
      logConsole.innerHTML = "";
      state.indexRunning = true;
      setIndexBadge("running");
      startIndexProgress();
      graphFX?.setBusy(true);
      openLogSocket();
    } else {
      (js.lines || []).forEach(appendLogLine);   // show the last run's log
      if (js.status && js.status !== "idle") setIndexBadge(js.status);
    }
  } catch (err) {
    showBootError(err.detail);
  }
}

// Styled, dismissible, retryable banner for a failed backend connection.
// Built with textContent (not innerHTML) so server-provided detail stays inert.
function showBootError(detail) {
  document.querySelector(".boot-error")?.remove();
  const bar = document.createElement("div");
  bar.className = "boot-error";
  bar.setAttribute("role", "alert");
  const msg = document.createElement("span");
  msg.className = "boot-error-msg";
  msg.textContent = "Could not reach the backend — " + detailToText(detail);
  const retry = document.createElement("button");
  retry.className = "btn ghost";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => { bar.remove(); boot(); });
  const dismiss = document.createElement("button");
  dismiss.className = "btn ghost";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => bar.remove());
  bar.append(msg, retry, dismiss);
  document.body.prepend(bar);
}

// ---------------------------------------------------------------------------
// Pipeline node markers (corpus → graph → query). Purely visual: reads the
// existing state and lights each spine node. Never throws if markers are absent.
// ---------------------------------------------------------------------------
// When a node completes, a periwinkle "signal" travels down the spine to the next
// node — reinforcing that an edge means active flow. Edge-triggered from the state
// machine below; reused single element, animated with the Web Animations API.
const NODE_FLOW = { "node-corpus": "node-graph", "node-graph": "node-query" };
const prevNodeState = {};
let spineSpark = null;

// Send the signal from `fromId`'s node to `toId`'s node, OR — when `toId` is
// omitted — downward from the node to the bottom of the spine (used by the query
// step, which is the last station: the answer flows out the bottom).
function flowSpark(fromId, toId) {
  if (prefersReducedMotion()) return;
  const from = document.getElementById(fromId);
  const pipeline = document.querySelector(".pipeline");
  if (!from || !pipeline) return;
  const fr = from.getBoundingClientRect();
  if (fr.height === 0) return;   // rail hidden (mobile) — no spine to travel
  const pr = pipeline.getBoundingClientRect();

  const x = fr.left + fr.width / 2 - pr.left;
  const y0 = fr.top + fr.height / 2 - pr.top;
  let y1;
  if (toId) {
    const to = document.getElementById(toId);
    if (!to) return;
    const tr = to.getBoundingClientRect();
    if (tr.height === 0) return;
    y1 = tr.top + tr.height / 2 - pr.top;     // to the next node
  } else {
    y1 = pr.height - 16;                       // down toward the bottom of the page
  }

  if (!spineSpark) {
    spineSpark = document.createElement("div");
    spineSpark.className = "spine-spark";
    spineSpark.setAttribute("aria-hidden", "true");
    pipeline.appendChild(spineSpark);
  }
  spineSpark.style.left = x + "px";
  const dur = Math.round(Math.max(720, Math.min(1100, Math.abs(y1 - y0) * 1.5)));   // longer travel → longer flight

  spineSpark.animate(
    [
      { transform: `translate(-50%, ${y0}px) scaleY(0.7)`, opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { transform: `translate(-50%, ${(y0 + y1) / 2}px) scaleY(1.35)`, offset: 0.5 },
      { opacity: 1, offset: 0.8 },
      { transform: `translate(-50%, ${y1}px) scaleY(0.7)`, opacity: 0 },
    ],
    { duration: dur, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }
  );
}

function syncPipeline() {
  const set = (id, s) => {
    const el = document.getElementById(id);
    if (!el) return;
    const prev = prevNodeState[id];
    el.dataset.state = s;
    prevNodeState[id] = s;
    // fire only on a genuine transition into "done" (not on first paint / re-asserts)
    if (s === "done" && prev && prev !== "done" && NODE_FLOW[id]) flowSpark(id, NODE_FLOW[id]);
  };
  const filesReady = (state.fileCount || 0) > 0;

  set("node-corpus", filesReady ? "done" : "active");

  const badge = document.getElementById("indexBadge");
  const st = badge ? badge.textContent.trim() : "";
  if (state.indexRunning || st === "running") set("node-graph", "running");
  else if (state.indexReady) set("node-graph", "done");
  else if (st === "failed" || st === "error") set("node-graph", "error");
  else set("node-graph", filesReady ? "active" : "locked");

  const q = document.getElementById("card-query");
  const queryLocked = !q || q.classList.contains("disabled");
  if (state.queryInFlight) set("node-query", "running");           // "thinking" while a query is in flight
  else if (queryLocked) set("node-query", "locked");
  else if (state.queryAnswered) set("node-query", "done");         // amber once a query has been answered (like the index node)
  else set("node-query", "active");
}

// ---------------------------------------------------------------------------
// Ambient knowledge-graph field behind the hero — drifting amber nodes joined
// by faint periwinkle edges. It reacts to real pipeline state: the cursor pulls
// nearby nodes (magnetism), indexing "energizes" the field, a successful index
// blooms an amber ring outward, and each query sends a periwinkle pulse.
// Static single frame + no reactions under reduced-motion.
// ---------------------------------------------------------------------------
function initGraphField() {
  const canvas = document.getElementById("graphField");
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
  const interactive = !reduce && finePointer;     // magnetism only with a real pointer + motion allowed

  const NODE = "245, 195, 107";   // amber (entities)
  const EDGE = "138, 169, 255";   // periwinkle (relationships)
  const PULL = 168;               // cursor magnetism radius (px)
  const now = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;

  let w = 0, h = 0, nodes = [], linkDist = 130, raf = 0, resizeTimer = 0;
  let energy = 0, targetEnergy = 0;               // 0..1 "thinking" intensity (ramps while indexing)
  let energyHold = 0;                             // timer id for the bloom's energy spike
  let ripples = [];                               // expanding rings: {x,y,hue,start,dur,maxR}
  const pointer = { x: 0, y: 0, active: false };

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

  // Display position = true position + an elastic shove toward the cursor. It's
  // render-only (never written back to the node), so the field springs back on
  // its own when the pointer moves away — no clumping, no runaway velocity.
  function placed(n) {
    if (!interactive || !pointer.active) return { x: n.x, y: n.y, pull: 0 };
    const dx = pointer.x - n.x, dy = pointer.y - n.y;
    const d = Math.hypot(dx, dy);
    if (d >= PULL || d < 0.01) return { x: n.x, y: n.y, pull: 0 };
    const pull = 1 - d / PULL;                    // 0..1, stronger near the cursor
    const shove = pull * pull * 24;               // eased, up to ~24px
    return { x: n.x + (dx / d) * shove, y: n.y + (dy / d) * shove, pull };
  }

  function draw() {
    const t0 = now();
    ctx.clearRect(0, 0, w, h);

    const P = nodes.map(placed);
    const edgeBoost = 1 + energy * 0.9;

    // edges between nodes
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const a = P[i], b = P[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < linkDist) {
          const al = Math.min(0.5, (1 - d / linkDist) * 0.22 * edgeBoost);
          ctx.strokeStyle = `rgba(${EDGE}, ${al.toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // edges reaching from the cursor to the nodes it's pulling
    if (interactive && pointer.active) {
      for (const p of P) {
        if (p.pull > 0) {
          ctx.strokeStyle = `rgba(${EDGE}, ${(p.pull * 0.4).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(pointer.x, pointer.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
      }
    }

    // nodes
    for (let i = 0; i < P.length; i++) {
      const n = nodes[i], p = P[i];
      const lit = n.bright || p.pull > 0.4 || energy > 0.5;
      ctx.shadowBlur = lit ? 9 + p.pull * 8 : 0;
      ctx.shadowColor = `rgba(${NODE}, 0.9)`;
      const a = Math.min(1, (n.bright ? 1 : 0.5) + p.pull * 0.5 + energy * 0.25);
      ctx.fillStyle = `rgba(${NODE}, ${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r + p.pull * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // expanding rings — index-success bloom (amber) / query pulse (periwinkle)
    for (const rp of ripples) {
      const t = Math.min(1, (t0 - rp.start) / rp.dur);
      const ease = 1 - Math.pow(1 - t, 3);        // ease-out
      const al = (1 - t) * 0.45;
      ctx.strokeStyle = `rgba(${rp.hue === "edge" ? EDGE : NODE}, ${al.toFixed(3)})`;
      ctx.lineWidth = (1 - t) * 2.5 + 0.4;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, ease * rp.maxR, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function step() {
    const t0 = now();
    energy += (targetEnergy - energy) * 0.05;     // smooth ramp toward target
    for (const n of nodes) {
      const sp = 1 + energy * 0.8;                // drift faster while "thinking"
      n.x += n.vx * sp; n.y += n.vy * sp;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    }
    if (ripples.length) ripples = ripples.filter((rp) => t0 - rp.start < rp.dur);
    draw();
    raf = requestAnimationFrame(step);
  }

  function spawnRipple(hue, dur, maxR) {
    ripples.push({ x: w / 2, y: h * 0.46, hue, dur, maxR, start: now() });
    if (ripples.length > 6) ripples.shift();
  }

  function start() {
    cancelAnimationFrame(raf);
    build();
    draw();
    if (!reduce) raf = requestAnimationFrame(step);
  }

  if (interactive) {
    const host = canvas.parentElement;
    host.addEventListener("pointermove", (e) => {
      const rect = host.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
    }, { passive: true });
    host.addEventListener("pointerleave", () => { pointer.active = false; }, { passive: true });
  }

  start();
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(start, 200); });
  window.addEventListener("load", () => setTimeout(start, 60)); // re-fit once webfonts settle the hero height

  // Hooks the pipeline calls so the constellation reflects real state.
  return {
    setBusy(on) {
      if (reduce) return;
      clearTimeout(energyHold);
      targetEnergy = on ? 0.85 : 0;
    },
    bloom() {
      if (reduce) return;
      spawnRipple("node", 1150, Math.hypot(w, h) * 0.62);
      spawnRipple("node", 1550, Math.hypot(w, h) * 0.84);   // a second, slower ring for depth
      targetEnergy = 1;
      clearTimeout(energyHold);
      energyHold = setTimeout(() => { targetEnergy = 0; }, 650);
    },
    pulse() {
      if (reduce) return;
      spawnRipple("edge", 900, Math.hypot(w, h) * 0.42);
    },
  };
}

graphFX = initGraphField();
boot();


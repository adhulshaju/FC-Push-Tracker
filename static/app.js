// ── FC Push Tracker — app.js ──────────────────────────────────────────────────
// localStorage-based, no server DB needed.

const STORAGE_KEY = "fcpush_v8";
const REPUSH_MS   = 30 * 60 * 1000;

const STATUS_META = {
  pending: { icon: "⏳", label: "Pending",  dotClass: "pending" },
  pushed:  { icon: "✓",  label: "Pushed",   dotClass: "pushed"  },
  pulled:  { icon: "⬆",  label: "Pull Out", dotClass: "pulled"  },
  skipped: { icon: "✕",  label: "Skip",     dotClass: "skipped" },
};

// ── State ─────────────────────────────────────────────────────────────────────
let entries    = [];
let qFilter    = "active";
let menuTarget = null; // { eId, tIdx }
let currentTab = "manual";

function loadEntries() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}
function saveEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  entries = loadEntries();
  bindEvents();
  renderAll();
});

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Tabs
  document.querySelectorAll(".tab-btn").forEach(btn =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );

  // Manual form
  const stEl = document.getElementById("stationInput");
  const tEl  = document.getElementById("toteInput");

  stEl.addEventListener("input", () => {
    if (stEl.value.length > 2) stEl.value = stEl.value.slice(0, 2);
  });
  stEl.addEventListener("keydown", e => { if (e.key === "Enter") tEl.focus(); });
  tEl.addEventListener("keydown",  e => { if (e.key === "Enter") handleAddManual(); });
  tEl.addEventListener("input", updateTotePreview);
  document.getElementById("addBtn").addEventListener("click", handleAddManual);

  // Scan
  document.getElementById("cameraInput").addEventListener("change",  e => handlePhotoFile(e.target.files[0]));
  document.getElementById("galleryInput").addEventListener("change", e => handlePhotoFile(e.target.files[0]));

  // Queue filter pills
  document.querySelectorAll(".filter-pill").forEach(btn =>
    btn.addEventListener("click", () => {
      qFilter = btn.dataset.filter;
      document.querySelectorAll(".filter-pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderQueue();
    })
  );

  // Clear closed
  document.getElementById("clearClosedBtn").addEventListener("click", () => {
    const n = entries.filter(isClosed).length;
    entries = entries.filter(e => !isClosed(e));
    saveEntries();
    renderAll();
    if (n) showToast("success", "🗑️ Cleared", `${n} closed entr${n > 1 ? "ies" : "y"} removed`);
  });

  // Tote menu backdrop + close btn
  document.getElementById("menuBackdrop").addEventListener("click", closeMenu);
  document.getElementById("menuCloseBtn").addEventListener("click", closeMenu);

  // Menu option buttons
  document.querySelectorAll(".menu-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!menuTarget) return;
      const { eId, tIdx } = menuTarget;
      updateToteStatus(eId, tIdx, btn.dataset.status);
      closeMenu();
    });
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  currentTab = name;
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name)
  );
  document.querySelectorAll(".panel").forEach(p =>
    p.classList.toggle("active", p.id === "panel-" + name)
  );
  if (name === "queue") renderQueue();
  if (name === "manual") renderRecent();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isClosed(e) { return e.totes.every(t => t.status !== "pending"); }

function nowTime() {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function parseTotes(raw) {
  return raw.split(/[,;\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
}

function getRecentlyPushedSet() {
  const now = Date.now(), s = new Set();
  entries.forEach(e => e.totes.forEach(t => {
    if (t.status === "pushed" && (now - e.addedAt) < REPUSH_MS) s.add(t.name);
  }));
  return s;
}

// Returns set of tote names currently in ANY active (non-closed) entry
function getActiveTotenameSet() {
  const s = new Set();
  entries.forEach(e => {
    if (!isClosed(e)) e.totes.forEach(t => s.add(t.name));
  });
  return s;
}

// ── Add entry ─────────────────────────────────────────────────────────────────
function doAddEntry(stRaw, names, source) {
  const pushed   = getRecentlyPushedSet();
  const autoMarked = names.filter(n => pushed.has(n));

  const totes = names.map(name => ({
    name, status: pushed.has(name) ? "pushed" : "pending"
  }));

  const entry = {
    id:      Date.now() + "_" + Math.random().toString(36).slice(2),
    station: String(stRaw).replace(/\D/g, "").slice(-2).padStart(2, "0"),
    totes, source,
    time:    nowTime(),
    addedAt: Date.now()
  };

  entries.unshift(entry);
  saveEntries();

  if (autoMarked.length) {
    showToast("warn", "♻️ Repush detected", `${autoMarked.join(", ")} pre-marked as pushed`);
  }
  return entry;
}

// ── Manual add ────────────────────────────────────────────────────────────────
function handleAddManual() {
  const stEl  = document.getElementById("stationInput");
  const tEl   = document.getElementById("toteInput");
  const st    = stEl.value.trim();
  const names = parseTotes(tEl.value);

  if (!st) {
    flashInputError(stEl, "Enter station number");
    return;
  }
  if (!names.length) {
    flashInputError(tEl, "Enter at least one tote");
    return;
  }

  const e = doAddEntry(st, names, "manual");
  stEl.value = "";
  tEl.value  = "";
  document.getElementById("totePreviewWrap").classList.add("hidden");
  document.getElementById("repushAlert").classList.add("hidden");

  showToast("success", "✅ Task Added", `ST-${e.station} · ${names.length} tote${names.length > 1 ? "s" : ""}`);
  renderAll();
}

function flashInputError(el, msg) {
  el.style.borderColor = "var(--red)";
  el.style.boxShadow   = "0 0 0 3px rgba(239,68,68,0.2)";
  el.focus();
  showToast("error", "⚠️ Missing field", msg);
  setTimeout(() => { el.style.borderColor = ""; el.style.boxShadow = ""; }, 900);
}

// ── Live tote preview ─────────────────────────────────────────────────────────
function updateTotePreview() {
  const names = parseTotes(document.getElementById("toteInput").value);
  const wrap  = document.getElementById("totePreviewWrap");
  const chips = document.getElementById("totePreviewChips");

  if (!names.length) { wrap.classList.add("hidden"); }
  else {
    wrap.classList.remove("hidden");
    chips.innerHTML = names.map(n =>
      `<span class="preview-chip">${n}</span>`
    ).join("");
  }

  const pushed = getRecentlyPushedSet();
  const warn   = names.filter(n => pushed.has(n));
  const alertEl = document.getElementById("repushAlert");
  if (warn.length) {
    document.getElementById("repushMsg").textContent =
      `${warn.join(", ")} pushed in last 30 min — will be pre-marked`;
    alertEl.classList.remove("hidden");
  } else {
    alertEl.classList.add("hidden");
  }
}

// ── Photo scan ────────────────────────────────────────────────────────────────
async function handlePhotoFile(file) {
  if (!file) return;

  const previewWrap = document.getElementById("scanPreviewWrap");
  const imgEl       = document.getElementById("imgPreview");
  const overlay     = document.getElementById("scanOverlay");
  const statusBar   = document.getElementById("scanStatusBar");
  const extSection  = document.getElementById("extractedSection");

  // Preview
  imgEl.src = URL.createObjectURL(file);
  previewWrap.classList.remove("hidden");
  overlay.classList.remove("hidden");
  extSection.classList.add("hidden");
  statusBar.className = "scan-status-bar hidden";
  document.getElementById("extractedList").innerHTML = "";

  // Convert to base64
  let base64, mime;
  try {
    mime = file.type || "image/jpeg";
    base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  } catch {
    overlay.classList.add("hidden");
    showScanStatus("error", "❌ Could not read image file");
    showToast("error", "❌ File Error", "Could not read the selected image");
    return;
  }

  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, mediaType: mime })
    });

    overlay.classList.add("hidden");

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error || `Server error ${res.status}`;
      showScanStatus("error", "❌ " + msg);
      showToast("error", "❌ Scan Failed", msg);
      return;
    }

    const data = await res.json();
    const stations = data.stations || [];

    if (!stations.length) {
      showScanStatus("error", "⚠️ No stations found — try a clearer photo");
      showToast("warn", "⚠️ Nothing found", "Try a closer, clearer photo of the screen");
      return;
    }

    showScanStatus("ok", `✓ Found ${stations.length} station${stations.length > 1 ? "s" : ""}, ${stations.reduce((a, s) => a + s.totes.length, 0)} totes`);
    showToast("info", "📷 Scan Complete", `${stations.length} station${stations.length > 1 ? "s" : ""} detected`);
    renderExtracted(stations);

  } catch (err) {
    overlay.classList.add("hidden");
    showScanStatus("error", "❌ Network error — is the server running?");
    showToast("error", "❌ Network Error", err.message || "Cannot reach server");
  }
}

function showScanStatus(type, msg) {
  const bar = document.getElementById("scanStatusBar");
  bar.className = "scan-status-bar " + type;
  bar.textContent = msg;
  bar.classList.remove("hidden");
}

function renderExtracted(stations) {
  const section  = document.getElementById("extractedSection");
  const list     = document.getElementById("extractedList");
  const addAllBtn = document.getElementById("addAllBtn");
  const label    = document.getElementById("extractedLabel");

  section.classList.remove("hidden");
  label.textContent = `${stations.length} Detected Station${stations.length > 1 ? "s" : ""}`;

  const activeNames = getActiveTotenameSet(); // for duplicate detection
  let addedCount = 0;
  const addedMap = {}; // idx -> bool

  function refreshAddAll() {
    const remaining = stations.filter((_, i) => !addedMap[i]).length;
    if (remaining === 0) {
      addAllBtn.textContent = "✓ All Added";
      addAllBtn.disabled = true;
    } else {
      addAllBtn.textContent = `Add All (${remaining})`;
      addAllBtn.disabled = false;
    }
  }

  list.innerHTML = "";
  stations.forEach((row, idx) => {
    const stShort = row.st.slice(-2).padStart(2, "0");

    // Check which totes already exist in active queue
    const alreadyTotes  = row.totes.filter(t => activeNames.has(t));
    const newTotes      = row.totes.filter(t => !activeNames.has(t));
    const hasAlready    = alreadyTotes.length > 0;

    const card = document.createElement("div");
    card.className = "extracted-card";
    card.id = `ext-card-${idx}`;

    const totesHtml = row.totes.map(t => {
      const already = activeNames.has(t);
      return `<span class="ext-tote-chip ${already ? "already-in" : ""}">${t}</span>`;
    }).join("");

    card.innerHTML = `
      <div class="extracted-info">
        ${hasAlready ? `<span class="already-badge">⚠️ ${alreadyTotes.length} already in queue</span>` : ""}
        <div class="ext-station">ST-${stShort} <span style="font-size:10px;color:var(--text-muted)">${row.st}</span></div>
        <div class="ext-totes">${totesHtml}</div>
      </div>
      <button class="ext-add-btn" id="extbtn-${idx}">+ Add</button>`;

    card.querySelector(`#extbtn-${idx}`).addEventListener("click", function () {
      if (addedMap[idx]) return;
      addedMap[idx] = true;
      this.textContent = "✓ Added";
      this.disabled = true;
      // Merge: add only NEW totes if already exists, else create new entry
      mergeOrAddStation(row.st, row.totes);
      refreshAddAll();
      // Update activeNames for subsequent cards
      row.totes.forEach(t => activeNames.add(t));
      // Refresh remaining cards' already-in indicators
      renderExtracted._refresh && renderExtracted._refresh();
    });

    list.appendChild(card);
    addedMap[idx] = false;
  });

  refreshAddAll();

  addAllBtn.onclick = () => {
    stations.forEach((row, idx) => {
      if (addedMap[idx]) return;
      addedMap[idx] = true;
      const btn = document.getElementById(`extbtn-${idx}`);
      if (btn) { btn.textContent = "✓ Added"; btn.disabled = true; }
      mergeOrAddStation(row.st, row.totes);
      row.totes.forEach(t => activeNames.add(t));
    });
    refreshAddAll();
    showToast("success", "✅ All Added", `${stations.length} stations added to queue`);
    setTimeout(() => switchTab("queue"), 700);
  };
}

/**
 * Smart merge: if a station entry already exists in the active queue,
 * add only the new totes to it instead of creating a duplicate.
 * If it doesn't exist, create a new entry.
 */
function mergeOrAddStation(st, toteNames) {
  const stShort = String(st).replace(/\D/g, "").slice(-2).padStart(2, "0");

  // Find existing active entry for this station
  const existing = entries.find(e =>
    !isClosed(e) && e.station === stShort
  );

  if (existing) {
    const existingNames = new Set(existing.totes.map(t => t.name));
    const newTotes = toteNames.filter(n => !existingNames.has(n));
    const repeated = toteNames.filter(n => existingNames.has(n));

    if (newTotes.length) {
      newTotes.forEach(name => existing.totes.push({ name, status: "pending" }));
      showToast("success", "🔗 Merged", `${newTotes.length} new tote${newTotes.length > 1 ? "s" : ""} added to ST-${stShort}`);
    }
    if (repeated.length) {
      showToast("warn", "♻️ Skipped duplicates", `${repeated.join(", ")} already in ST-${stShort}`);
    }
    saveEntries();
    renderAll();
  } else {
    const e = doAddEntry(st, toteNames, "scan");
    showToast("success", "✅ Added", `ST-${e.station} · ${toteNames.length} tote${toteNames.length > 1 ? "s" : ""}`);
    renderAll();
  }
}

// ── Tote status update ────────────────────────────────────────────────────────
function updateToteStatus(eId, tIdx, status) {
  const entry = entries.find(e => e.id === eId);
  if (!entry || !entry.totes[tIdx]) return;
  entry.totes[tIdx].status = status;
  saveEntries();
  renderAll();
  showToast("info", "Updated", `${entry.totes[tIdx].name} → ${STATUS_META[status].label}`);
}

// ── Open tote menu ────────────────────────────────────────────────────────────
function openToteMenu(eId, tIdx) {
  const entry = entries.find(e => e.id === eId);
  if (!entry) return;
  const tote = entry.totes[tIdx];
  if (!tote) return;

  menuTarget = { eId, tIdx };

  document.getElementById("menuToteName").textContent    = tote.name;
  document.getElementById("menuStationName").textContent = `Station ST-${entry.station}`;

  // Highlight current status
  document.querySelectorAll(".menu-opt").forEach(btn => {
    const isCurrent = btn.dataset.status === tote.status;
    btn.classList.toggle("is-active", isCurrent);
    btn.querySelector(".opt-check").classList.toggle("hidden", !isCurrent);
  });

  document.getElementById("toteMenu").classList.remove("hidden");
  document.getElementById("menuBackdrop").classList.remove("hidden");
}

function closeMenu() {
  document.getElementById("toteMenu").classList.add("hidden");
  document.getElementById("menuBackdrop").classList.add("hidden");
  menuTarget = null;
}

// ── Render: all ───────────────────────────────────────────────────────────────
function renderAll() {
  renderBadges();
  renderStats();
  if (currentTab === "manual") renderRecent();
  if (currentTab === "queue")  renderQueue();
}

function renderBadges() {
  const active = entries.filter(e => !isClosed(e)).length;
  const badge  = document.getElementById("queueBadge");
  if (active > 0) {
    badge.textContent = active > 99 ? "99+" : active;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
  document.getElementById("statsText").textContent = `${active} active`;
}

function renderStats() {
  let pushed = 0, pulled = 0, skipped = 0;
  entries.filter(e => !isClosed(e)).forEach(e => {
    e.totes.forEach(t => {
      if (t.status === "pushed")  pushed++;
      if (t.status === "pulled")  pulled++;
      if (t.status === "skipped") skipped++;
    });
  });
  const active = entries.filter(e => !isClosed(e)).length;
  document.getElementById("statActive").textContent  = active;
  document.getElementById("statPushed").textContent  = pushed;
  document.getElementById("statPulled").textContent  = pulled;
  document.getElementById("statSkipped").textContent = skipped;
}

// ── Render: recent (manual tab) ───────────────────────────────────────────────
function renderRecent() {
  const el    = document.getElementById("recentList");
  const items = entries.filter(e => !isClosed(e)).slice(0, 4);
  if (!items.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-title">No active tasks</div>
      <div class="empty-sub">Add a push task above or scan the CPT screen</div>
    </div>`;
    return;
  }
  el.innerHTML = "";
  items.forEach(e => el.appendChild(buildEntryCard(e, true)));
}

// ── Render: queue ─────────────────────────────────────────────────────────────
function renderQueue() {
  const active = entries.filter(e => !isClosed(e));
  const closed = entries.filter(isClosed);
  const list   = qFilter === "active" ? active : closed;

  document.getElementById("activeCount").textContent = active.length;
  document.getElementById("closedCount").textContent = closed.length;

  const clearBtn = document.getElementById("clearClosedBtn");
  clearBtn.classList.toggle("hidden", !(qFilter === "closed" && closed.length > 0));

  const el = document.getElementById("queueList");
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">${qFilter === "active" ? "📦" : "✅"}</div>
      <div class="empty-title">${qFilter === "active" ? "No active tasks" : "No closed tasks"}</div>
      <div class="empty-sub">${qFilter === "active" ? "Add manual entries or scan the CPT screen" : "Completed tasks appear here"}</div>
    </div>`;
    return;
  }
  el.innerHTML = "";
  list.forEach(e => el.appendChild(buildEntryCard(e, false)));
}

// ── Build entry card DOM ──────────────────────────────────────────────────────
function buildEntryCard(entry, compact) {
  const closed = isClosed(entry);

  // Progress
  const total    = entry.totes.length;
  const done     = entry.totes.filter(t => t.status !== "pending").length;
  const pct      = total ? Math.round((done / total) * 100) : 0;

  // Status summary counts
  const counts = { pushed: 0, pulled: 0, skipped: 0, pending: 0 };
  entry.totes.forEach(t => counts[t.status]++);

  const card = document.createElement("div");
  card.className = `entry-card-item source-${entry.source} ${closed ? "entry-closed closed" : ""}`;

  // Tote chips HTML
  const totesHtml = entry.totes.map((t, i) => {
    const sm = STATUS_META[t.status];
    return `<span class="tote-chip ${t.status}" data-eid="${entry.id}" data-tidx="${i}" title="Tap to change status">
      <span class="tote-chip-icon">${sm.icon}</span>${t.name}
    </span>`;
  }).join("");

  // Status summary chips
  const summaryChips = [
    counts.pending  ? `<span class="status-chip" style="background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.25);color:var(--green)">⏳ ${counts.pending} pending</span>` : "",
    counts.pushed   ? `<span class="status-chip" style="background:rgba(100,116,139,.1);border-color:rgba(100,116,139,.2);color:#94a3b8">✓ ${counts.pushed} pushed</span>` : "",
    counts.pulled   ? `<span class="status-chip" style="background:rgba(249,115,22,.1);border-color:rgba(249,115,22,.25);color:var(--orange)">⬆ ${counts.pulled} pull</span>` : "",
    counts.skipped  ? `<span class="status-chip" style="background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.2);color:var(--red)">✕ ${counts.skipped} skip</span>` : "",
  ].filter(Boolean).join("");

  card.innerHTML = `
    <div class="entry-top">
      <div class="entry-left">
        <div class="station-badge">ST-${entry.station}</div>
        <div class="entry-meta">
          <span class="entry-time">${entry.time}</span>
          <span class="src-badge ${entry.source}">${entry.source === "scan" ? "📷 SCAN" : "🎙 MANUAL"}</span>
        </div>
      </div>
      <div class="entry-actions">
        <button class="action-btn del" data-del="${entry.id}" title="Delete entry">🗑</button>
      </div>
    </div>
    ${compact ? "" : `<div class="totes-label">Tap a tote to update its status</div>`}
    <div class="totes-wrap">${totesHtml}</div>
    ${!compact ? `
      <div class="status-summary">${summaryChips}</div>
      <div class="entry-progress">
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-label">${done}/${total} actioned${closed ? " · Complete" : ""}</div>
      </div>
    ` : ""}`;

  // Delete button
  card.querySelector(`[data-del="${entry.id}"]`).addEventListener("click", e => {
    e.stopPropagation();
    deleteEntry(entry.id);
  });

  // Tote chip taps
  card.querySelectorAll(".tote-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      openToteMenu(chip.dataset.eid, parseInt(chip.dataset.tidx));
    });
  });

  return card;
}

// ── Delete entry ──────────────────────────────────────────────────────────────
function deleteEntry(id) {
  entries = entries.filter(e => e.id !== id);
  saveEntries();
  renderAll();
  showToast("warn", "🗑️ Deleted", "Entry removed");
}

// ── Toast system ──────────────────────────────────────────────────────────────
const toastTimers = new Map();

function showToast(type, title, subtitle) {
  const stack = document.getElementById("toastStack");
  const id    = "toast_" + Date.now();

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.id = id;

  const icons = { success: "✅", error: "❌", warn: "⚠️", info: "ℹ️" };
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || "ℹ️"}</span>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${subtitle ? `<div class="toast-sub">${subtitle}</div>` : ""}
    </div>
    <button class="toast-close" onclick="dismissToast('${id}')">✕</button>`;

  stack.appendChild(toast);

  // Auto dismiss
  const timer = setTimeout(() => dismissToast(id), 3200);
  toastTimers.set(id, timer);
}

function dismissToast(id) {
  const toast = document.getElementById(id);
  if (!toast) return;
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  toast.classList.add("exiting");
  setTimeout(() => toast.remove(), 280);
}

// ── FC Push Tracker — Free Edition ────────────────────────────────────────────
// All data stored in device localStorage — no server DB, works on any device

const REPUSH_MS   = 30 * 60 * 1000;
const LS_KEY      = "fcpush_entries";

const STATUS_META = {
  pending: { icon: "⏳", label: "Pending",  cls: "pending" },
  pushed:  { icon: "✓",  label: "Pushed",   cls: "pushed"  },
  pulled:  { icon: "⬆",  label: "Pull Out", cls: "pulled"  },
  skipped: { icon: "✕",  label: "Skip",     cls: "skipped" },
};

let entries    = [];
let qFilter    = "active";
let menuTarget = null;
let toastTmr;

// ── localStorage helpers ──────────────────────────────────────────────────────
function loadEntries() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveEntries() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch (e) {
    showToast("Storage full — clear old entries", true);
  }
}

// ── Scan API helper (only endpoint still on server) ───────────────────────────
async function apiScan(image, mediaType) {
  const r = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, mediaType })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  entries = loadEntries();
  render();
  bindEvents();
});

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      qFilter = btn.dataset.filter;
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderQueue();
    });
  });

  document.getElementById("stationInput").addEventListener("input", function () {
    if (this.value.length > 2) this.value = this.value.slice(0, 2);
  });
  document.getElementById("stationInput").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("toteInput").focus();
  });
  document.getElementById("toteInput").addEventListener("keydown", e => {
    if (e.key === "Enter") handleAddManual();
  });
  document.getElementById("toteInput").addEventListener("input", updateTotePreview);
  document.getElementById("addBtn").addEventListener("click", handleAddManual);

  document.getElementById("cameraInput").addEventListener("change", e => handlePhotoFile(e.target.files[0]));
  document.getElementById("galleryInput").addEventListener("change", e => handlePhotoFile(e.target.files[0]));

  document.getElementById("clearClosedBtn").addEventListener("click", () => {
    const closedIds = new Set(entries.filter(isClosed).map(e => e.id));
    entries = entries.filter(e => !closedIds.has(e.id));
    saveEntries();
    showToast(`Cleared ${closedIds.size} closed`);
    renderQueue();
  });

  document.getElementById("menuOverlay").addEventListener("click", closeMenu);
  document.querySelectorAll(".menu-item").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!menuTarget) return;
      const { entryId, toteIdx } = menuTarget;
      const entry = entries.find(e => e.id === entryId);
      if (entry && entry.totes[toteIdx]) {
        entry.totes[toteIdx].status = btn.dataset.status;
        saveEntries();
        renderQueue();
      }
      closeMenu();
    });
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + name));
  if (name === "queue") renderQueue();
}

// ── Manual add ────────────────────────────────────────────────────────────────
function handleAddManual() {
  const stEl  = document.getElementById("stationInput");
  const tEl   = document.getElementById("toteInput");
  const st    = stEl.value.trim();
  const names = parseTotes(tEl.value);

  if (!st)          { flashError(stEl); return; }
  if (!names.length){ flashError(tEl);  return; }

  const recentPushed = getRecentlyPushed();
  const id = Date.now() + "" + Math.random().toString(36).slice(2);
  const entry = {
    id,
    station:  st.padStart(2, "0"),
    source:   "manual",
    time:     nowTime(),
    addedAt:  Date.now(),
    totes:    names.map(name => ({
      name,
      status: recentPushed.has(name) ? "pushed" : "pending"
    }))
  };

  entries.unshift(entry);
  saveEntries();
  stEl.value = ""; tEl.value = "";
  document.getElementById("totePreview").textContent = "";
  document.getElementById("repushWarn").classList.add("hidden");
  showToast(`ST-${entry.station} · ${names.length} tote${names.length > 1 ? "s" : ""} added`);
  renderBadge();
}

function updateTotePreview() {
  const names = parseTotes(document.getElementById("toteInput").value);
  const preview = document.getElementById("totePreview");
  preview.textContent = names.length
    ? `${names.length} tote${names.length > 1 ? "s" : ""}: ${names.join(" · ")}`
    : "";

  const recentPushed = getRecentlyPushed();
  const warn = names.filter(n => recentPushed.has(n));
  const warnEl = document.getElementById("repushWarn");
  if (warn.length) {
    warnEl.textContent = `⚠ Pushed recently: ${warn.join(", ")} — will be pre-marked`;
    warnEl.classList.remove("hidden");
  } else {
    warnEl.classList.add("hidden");
  }
}

// ── Photo scan ────────────────────────────────────────────────────────────────
async function handlePhotoFile(file) {
  if (!file) return;

  const preview = document.getElementById("imgPreview");
  preview.src = URL.createObjectURL(file);
  preview.classList.remove("hidden");

  const statusEl = document.getElementById("scanStatus");
  const listEl   = document.getElementById("extractedList");
  listEl.innerHTML = "";
  statusEl.className = "scan-status scanning";
  statusEl.innerHTML = '<span class="spinner"></span> AI reading CPT Priorizer screen…';
  statusEl.classList.remove("hidden");

  let base64, mime;
  try {
    mime   = file.type || "image/jpeg";
    base64 = await fileToBase64(file);
  } catch {
    statusEl.className = "scan-status error";
    statusEl.textContent = "✗ Could not read image file";
    return;
  }

  try {
    const result   = await apiScan(base64, mime);
    const stations = result.stations || [];

    if (!stations.length) {
      statusEl.className = "scan-status error";
      statusEl.textContent = "No stations found — try a clearer photo";
      return;
    }

    statusEl.className = "scan-status done";
    statusEl.textContent = `✓ Found ${stations.length} station${stations.length > 1 ? "s" : ""}`;

    const addedSet = new Set();

    stations.forEach((row, idx) => {
      const stShort = row.st.slice(-2).padStart(2, "0");
      const div = document.createElement("div");
      div.className = "extracted-item";
      div.innerHTML = `
        <div class="ext-info">
          <div class="ext-station">ST-${stShort} <span style="color:var(--muted);font-size:10px">${row.st}</span></div>
          <div class="ext-totes">${row.totes.join(" · ")}</div>
        </div>
        <button class="ext-add-btn" id="extbtn-${idx}">+ Add</button>`;
      div.querySelector(`#extbtn-${idx}`).addEventListener("click", function () {
        if (addedSet.has(idx)) return;
        addedSet.add(idx);
        this.textContent = "✓ Added";
        this.disabled = true;
        addScannedStation(row.st, row.totes);
      });
      listEl.appendChild(div);
    });

    const addAllBtn = document.createElement("button");
    addAllBtn.className = "btn-purple";
    addAllBtn.textContent = `📦 Add All ${stations.length} Stations`;
    addAllBtn.addEventListener("click", () => {
      stations.forEach(row => addScannedStation(row.st, row.totes));
      document.querySelectorAll(".ext-add-btn").forEach(b => { b.textContent = "✓ Added"; b.disabled = true; });
      addAllBtn.textContent = "✓ All Added";
      addAllBtn.disabled = true;
      showToast(`${stations.length} stations added`);
      setTimeout(() => switchTab("queue"), 600);
    });
    listEl.appendChild(addAllBtn);

  } catch (err) {
    statusEl.className = "scan-status error";
    statusEl.textContent = "✗ " + (err.message || "Scan failed");
  }
}

function addScannedStation(st, totes) {
  const recentPushed = getRecentlyPushed();
  const id = Date.now() + "" + Math.random().toString(36).slice(2);
  const entry = {
    id,
    station: st.slice(-2).padStart(2, "0"),
    source:  "scan",
    time:    nowTime(),
    addedAt: Date.now(),
    totes:   totes.map(name => ({
      name,
      status: recentPushed.has(name) ? "pushed" : "pending"
    }))
  };
  entries.unshift(entry);
  saveEntries();
  renderBadge();
  showToast("ST-" + entry.station + " added");
}

// ── Queue render ──────────────────────────────────────────────────────────────
function renderQueue() {
  const active = entries.filter(e => !isClosed(e));
  const closed = entries.filter(isClosed);
  const list   = qFilter === "active" ? active : closed;

  document.getElementById("activeCount").textContent = active.length;
  document.getElementById("closedCount").textContent = closed.length;
  document.getElementById("clearClosedBtn").classList.toggle("hidden", qFilter !== "closed" || !closed.length);

  const el = document.getElementById("queueList");

  if (!list.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div>${qFilter === "active" ? "No active pushes" : "No closed entries"}</div>`;
    return;
  }

  el.innerHTML = "";
  list.forEach(entry => {
    const closed = isClosed(entry);
    const card = document.createElement("div");
    card.className = "entry";
    card.style.borderLeft = `4px solid ${closed ? "#3a4555" : entry.source === "scan" ? "var(--purple)" : "var(--green)"}`;
    card.style.opacity = closed ? "0.65" : "1";

    const counts = { pending: 0, pushed: 0, pulled: 0, skipped: 0 };
    entry.totes.forEach(t => counts[t.status]++);
    const summaryHtml = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([st, n]) => {
        const s    = STATUS_META[st];
        const colors = { pending: "var(--green)", pushed: "#8090a0", pulled: "var(--warn)", skipped: "var(--danger)" };
        const bgs    = { pending: "rgba(0,200,150,.1)", pushed: "rgba(90,90,110,.18)", pulled: "rgba(255,140,0,.12)", skipped: "rgba(255,68,68,.1)" };
        const bcs    = { pending: "rgba(0,200,150,.3)", pushed: "#3a4555", pulled: "rgba(255,140,0,.4)", skipped: "rgba(255,68,68,.3)" };
        return `<div class="stat-pill" style="color:${colors[st]};background:${bgs[st]};border-color:${bcs[st]}">${s.icon} ${n} ${s.label.toLowerCase()}</div>`;
      }).join("");

    card.innerHTML = `
      <div class="entry-header">
        <div class="entry-meta">
          <div class="station-chip">ST-${entry.station}</div>
          <span class="entry-time">${entry.time}</span>
          <span class="src-badge ${entry.source}">${entry.source === "scan" ? "📷 SCAN" : "🎙 MANUAL"}</span>
        </div>
        <button class="del-btn" data-id="${entry.id}">✕</button>
      </div>
      <div class="totes-label">Tap tote to change status:</div>
      <div class="totes-wrap">
        ${entry.totes.map((t, i) => `
          <div class="tote-chip ${t.status}" data-entry="${entry.id}" data-idx="${i}">
            ${STATUS_META[t.status].icon} ${t.name}
          </div>`).join("")}
      </div>
      <div class="status-summary">${summaryHtml}</div>`;

    card.querySelector(".del-btn").addEventListener("click", () => {
      entries = entries.filter(e => e.id !== entry.id);
      saveEntries();
      renderQueue();
      renderBadge();
    });

    card.querySelectorAll(".tote-chip").forEach(chip => {
      chip.addEventListener("click", e =>
        openToteMenu(e, chip.dataset.entry, parseInt(chip.dataset.idx),
          chip.textContent.trim().split(" ").slice(1).join(" "))
      );
    });

    el.appendChild(card);
  });
}

// ── Tote context menu ─────────────────────────────────────────────────────────
function openToteMenu(event, entryId, toteIdx, toteName) {
  menuTarget = { entryId, toteIdx };
  const menu = document.getElementById("toteMenu");
  document.getElementById("toteMenuName").textContent = toteName;

  const entry = entries.find(e => e.id === entryId);
  const currentStatus = entry?.totes[toteIdx]?.status;
  document.querySelectorAll(".menu-item").forEach(btn => {
    btn.classList.toggle("active-status", btn.dataset.status === currentStatus);
  });

  const rect = event.target.getBoundingClientRect();
  menu.style.left = Math.min(rect.left, window.innerWidth - 200) + "px";
  menu.style.top  = (rect.bottom + 6 + window.scrollY) + "px";

  menu.classList.remove("hidden");
  document.getElementById("menuOverlay").classList.remove("hidden");
}

function closeMenu() {
  document.getElementById("toteMenu").classList.add("hidden");
  document.getElementById("menuOverlay").classList.add("hidden");
  menuTarget = null;
}

// ── Render helpers ────────────────────────────────────────────────────────────
function render()      { renderBadge(); renderQueue(); }

function renderBadge() {
  const pending = entries.filter(e => !isClosed(e)).length;
  const badge = document.getElementById("queueCount");
  badge.textContent = pending > 0 ? `(${pending})` : "";
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function isClosed(e) { return e.totes.every(t => t.status !== "pending"); }

function getRecentlyPushed() {
  const now = Date.now(), s = new Set();
  entries.forEach(e => e.totes.forEach(t => {
    if (t.status === "pushed" && (now - e.addedAt) < REPUSH_MS) s.add(t.name);
  }));
  return s;
}

function parseTotes(raw) {
  return raw.split(/[,;\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
}

function nowTime() {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function flashError(el) {
  el.style.borderColor = "var(--danger)";
  el.focus();
  setTimeout(() => el.style.borderColor = "", 700);
}

function showToast(msg, warn) {
  clearTimeout(toastTmr);
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (warn ? " warn" : "");
  el.classList.remove("hidden");
  toastTmr = setTimeout(() => el.classList.add("hidden"), 2500);
}

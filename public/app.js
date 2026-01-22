/* public/app.js */

const API_URL = "/api/vehicles";
const POLL_MS = 9000;              // Worker TTL is 10s; don't hammer
const MIN_ZOOM_FOR_MARKERS = 12;   // Hide markers when zoomed out (performance)
const MAX_MARKERS = 900;           // Safety cap in-view
const ICON_SIZE = 32;

const qs = new URLSearchParams(location.search);
const animParam = (qs.get("anim") || "").toLowerCase();
// anim=all -> animate ALL markers (heavy)
// anim=off -> no animations anywhere
// default -> animate ONLY selected marker (fast)
const ANIM_ALL = animParam === "all" || animParam === "1" || animParam === "true";
const ANIM_OFF = animParam === "off" || animParam === "0" || animParam === "false";

const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const CAN_ANIMATE = !ANIM_OFF && !prefersReducedMotion;

const ICON_BASE_ANIM = "/emoji";
const ICON_BASE_STATIC = "/emoji/static";

const hud1 = document.getElementById("hud-line-1");
const hud2 = document.getElementById("hud-line-2");

function setHud(line1, line2 = "") {
  if (hud1) hud1.textContent = line1;
  if (hud2) hud2.textContent = line2;
}

function fmtAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

const map = L.map("map", {
  preferCanvas: true,
  zoomControl: true,
});

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  updateWhenIdle: true,
  keepBuffer: 2,
}).addTo(map);

// Default view: Sydney
map.setView([-33.8688, 151.2093], 12);

// Try to center on user (fast timeout; ignore if denied)
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords || {};
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        map.setView([latitude, longitude], 14);
      }
    },
    () => {},
    { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
  );
}

// Pause DOM churn while user is panning/zooming
let userInteracting = false;
map.on("movestart zoomstart", () => {
  userInteracting = true;
});
map.on("moveend zoomend", () => {
  userInteracting = false;
  if (lastData) render(lastData);
});

const iconCache = new Map();
function iconKey(kind, animated) {
  return `${kind}|${animated ? "a" : "s"}`;
}
function getIcon(kind, animated) {
  const key = iconKey(kind, animated);
  const cached = iconCache.get(key);
  if (cached) return cached;

  const base = animated ? ICON_BASE_ANIM : ICON_BASE_STATIC;
  const icon = L.icon({
    iconUrl: `${base}/${kind}.png`,
    iconSize: [ICON_SIZE, ICON_SIZE],
    iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
    className: "vehicle-icon",
  });
  iconCache.set(key, icon);
  return icon;
}

// TfNSW endpoint here is buses; keep a hook for future
function kindForVehicle(_v) {
  return "bus";
}

const markerMeta = new Map(); // id -> { marker, kind, lastSeen }
let selectedId = null;

function setSelected(id) {
  selectedId = selectedId === id ? null : id;

  // Update icons for current markers
  for (const [vid, meta] of markerMeta) {
    const isSelected = selectedId && vid === selectedId;
    const animateThis = CAN_ANIMATE && (ANIM_ALL || isSelected);
    const wanted = getIcon(meta.kind, animateThis);
    if (meta.marker.options.icon !== wanted) meta.marker.setIcon(wanted);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

let lastData = null;
let lastOkAt = 0;
let lastErr = "";

async function loop() {
  try {
    const data = await fetchJson(API_URL);
    lastData = data;
    lastOkAt = Date.now();
    lastErr = "";

    if (!userInteracting) {
      render(data);
    } else {
      const total = Array.isArray(data?.vehicles) ? data.vehicles.length : 0;
      setHud(
        `${total} vehicles (panning…)`,
        CAN_ANIMATE ? (ANIM_ALL ? "anim=all" : "anim=selected") : "anim=off"
      );
    }
  } catch (e) {
    lastErr = String(e?.message || e || "unknown error");
    const age = lastOkAt ? `last ok ${fmtAge(Date.now() - lastOkAt)} ago` : "no data yet";
    setHud(`Error loading vehicles (${age})`, lastErr);
  } finally {
    setTimeout(loop, POLL_MS);
  }
}

function render(data) {
  const vehicles = Array.isArray(data?.vehicles) ? data.vehicles : [];

  const zoom = map.getZoom();
  if (zoom < MIN_ZOOM_FOR_MARKERS) {
    for (const meta of markerMeta.values()) {
      if (map.hasLayer(meta.marker)) map.removeLayer(meta.marker);
    }
    setHud(
      `Zoom in to see vehicles (zoom ${zoom}, need ≥ ${MIN_ZOOM_FOR_MARKERS})`,
      `${vehicles.length} total • ${CAN_ANIMATE ? (ANIM_ALL ? "anim=all" : "anim=selected") : "anim=off"}`
    );
    return;
  }

  const bounds = map.getBounds().pad(0.15);

  const visible = [];
  for (const v of vehicles) {
    const lat = v?.lat;
    const lon = v?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!bounds.contains([lat, lon])) continue;
    if (!v?.id) continue;
    visible.push(v);
    if (visible.length >= MAX_MARKERS) break;
  }

  const now = Date.now();
  const shownIds = new Set();

  for (const v of visible) {
    const id = String(v.id);
    const kind = kindForVehicle(v);
    shownIds.add(id);

    const isSelected = selectedId && id === selectedId;
    const animateThis = CAN_ANIMATE && (ANIM_ALL || isSelected);
    const icon = getIcon(kind, animateThis);

    let meta = markerMeta.get(id);
    if (!meta) {
      const m = L.marker([v.lat, v.lon], { icon, keyboard: false });
      m.on("click", () => setSelected(id));
      m.addTo(map);
      meta = { marker: m, kind, lastSeen: now };
      markerMeta.set(id, meta);
    } else {
      meta.lastSeen = now;
      meta.kind = kind;

      if (meta.marker.options.icon !== icon) meta.marker.setIcon(icon);

      const ll = meta.marker.getLatLng();
      if (Math.abs(ll.lat - v.lat) > 1e-7 || Math.abs(ll.lng - v.lon) > 1e-7) {
        meta.marker.setLatLng([v.lat, v.lon]);
      }
      if (!map.hasLayer(meta.marker)) meta.marker.addTo(map);
    }
  }

  // Hide markers not visible; delete stale markers to avoid memory creep
  for (const [id, meta] of markerMeta) {
    if (!shownIds.has(id)) {
      if (map.hasLayer(meta.marker)) map.removeLayer(meta.marker);
      if (now - meta.lastSeen > 120000) {
        markerMeta.delete(id);
        if (selectedId === id) selectedId = null;
      }
    }
  }

  const age = lastOkAt ? fmtAge(Date.now() - lastOkAt) : "?";
  const animLabel = CAN_ANIMATE ? (ANIM_ALL ? "anim=all" : "anim=selected") : "anim=off";
  const note = vehicles.length > visible.length ? `showing ${visible.length} in view` : `showing ${visible.length}`;
  setHud(`${vehicles.length} vehicles • ${note} • updated ${age} ago`, animLabel);
}

setHud("Loading vehicles…", "");
loop();

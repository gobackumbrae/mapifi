/* public/app.js */
/* global L */

const API_URL = "/api/vehicles";
const POLL_MS = 10_000;

const ICON_SIZE = 32;

// We keep animated emoji only for selection to avoid lag
// "selected" | "all" | "none"
const ANIM_MODE = "selected";

// Where your emoji live
const ICON_BASE_ANIM = "/emoji";
const ICON_BASE_STATIC = "/emoji/static";

// IMPORTANT:
// GTFS-RT bearing is degrees clockwise from TRUE NORTH.
// Fluent vehicle emoji art usually points to the RIGHT (EAST) by default.
// So we rotate by (bearing - 90) to align.
const ROTATION_OFFSET_DEG = -90;

// Hard cap to stop the DOM exploding on mobile
const SAFETY_MAX_MARKERS = 900;

const ICON_CACHE = new Map(); // key => L.Icon
function getIcon(kind, animated) {
  const key = `${kind}:${animated ? "anim" : "static"}`;
  const cached = ICON_CACHE.get(key);
  if (cached) return cached;

  const base = animated ? ICON_BASE_ANIM : ICON_BASE_STATIC;
  const icon = L.icon({
    iconUrl: `${base}/${kind}.png`,
    iconSize: [ICON_SIZE, ICON_SIZE],
    iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
    className: "vehicle-icon",
  });

  ICON_CACHE.set(key, icon);
  return icon;
}

function normalizeDeg(d) {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
}

function rotationFromBearing(bearing) {
  if (!Number.isFinite(bearing)) return 0;
  return normalizeDeg(bearing + ROTATION_OFFSET_DEG);
}

function setMarkerRotation(marker, rotDeg) {
  // Only works after rotatedMarker plugin is loaded.
  if (typeof marker.setRotationOrigin === "function") {
    marker.setRotationOrigin("center center");
  }
  if (typeof marker.setRotationAngle === "function") {
    marker.setRotationAngle(rotDeg);
  }
}

function isAnimatedFor(id, selectedId) {
  if (ANIM_MODE === "all") return true;
  if (ANIM_MODE === "none") return false;
  return id === selectedId; // "selected"
}

function kindForVehicle(v) {
  // MapIfi currently only has buses from TfNSW vehiclepos/buses
  // Keep it simple for now.
  return "bus";
}

let map;
let selectedId = null;
let lastData = null;

// id -> { marker, kind, lastSeen, rot }
const markerMeta = new Map();

function setHud(line1, line2 = "") {
  const a = document.getElementById("hud-line-1");
  const b = document.getElementById("hud-line-2");
  if (a) a.textContent = line1;
  if (b) b.textContent = line2;
}

function initMap() {
  map = L.map("map", {
    preferCanvas: true,
    updateWhenIdle: true,
    keepBuffer: 1,
  }).setView([-33.8688, 151.2093], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
    updateWhenIdle: true,
    keepBuffer: 2,
  }).addTo(map);

  map.on("moveend zoomend", () => {
    if (lastData?.vehicles) renderVehicles(lastData.vehicles, /*fromMove=*/true);
  });
}

async function fetchVehicles() {
  const res = await fetch(`${API_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

function pruneStale(nowTs) {
  // Remove markers not seen for ~3 polls
  const STALE_MS = POLL_MS * 3 + 2000;

  for (const [id, meta] of markerMeta.entries()) {
    if (nowTs - meta.lastSeen > STALE_MS) {
      if (map && map.hasLayer(meta.marker)) map.removeLayer(meta.marker);
      markerMeta.delete(id);
    }
  }
}

function onMarkerClick(id) {
  selectedId = id;

  // swap icons (animated for selected, static for others)
  for (const [mid, meta] of markerMeta.entries()) {
    const wantAnim = isAnimatedFor(mid, selectedId);
    meta.marker.setIcon(getIcon(meta.kind, wantAnim));

    // ensure rotation survives icon swap
    setMarkerRotation(meta.marker, meta.rot ?? 0);
  }

  const v = lastData?.vehicles?.find((x) => x.id === id);
  if (v) {
    setHud(`Selected: ${id}`, v.route_id ? `Route: ${v.route_id}` : "");
    map.setView([v.lat, v.lon], Math.max(map.getZoom(), 14), { animate: true });
  }
}

function renderVehicles(vehicles, fromMove = false) {
  const now = Date.now();

  // Cull to viewport (expanded a bit)
  const bounds = map.getBounds().pad(0.25);

  let visible = [];
  for (const v of vehicles) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    if (!bounds.contains([v.lat, v.lon])) continue;
    visible.push(v);
    if (visible.length >= SAFETY_MAX_MARKERS) break;
  }

  // If this was triggered just by move/zoom, don't rewrite the HUD noisily
  if (!fromMove) {
    setHud(
      `Vehicles in view: ${visible.length}`,
      selectedId ? `Selected: ${selectedId}` : ""
    );
  }

  const visibleIds = new Set(visible.map((v) => v.id));

  // Remove markers that are no longer visible (but keep in meta so we can re-add quickly)
  for (const [id, meta] of markerMeta.entries()) {
    if (!visibleIds.has(id) && map.hasLayer(meta.marker)) {
      map.removeLayer(meta.marker);
    }
  }

  // Upsert visible markers
  for (const v of visible) {
    const id = v.id;
    const kind = kindForVehicle(v);
    const wantAnim = isAnimatedFor(id, selectedId);
    const rot = rotationFromBearing(v.bearing);

    let meta = markerMeta.get(id);
    if (!meta) {
      const icon = getIcon(kind, wantAnim);

      const m = L.marker([v.lat, v.lon], {
        icon,
        keyboard: false,
      });

      m.on("click", () => onMarkerClick(id));
      m.addTo(map);

      meta = { marker: m, kind, lastSeen: now, rot };
      markerMeta.set(id, meta);

      setMarkerRotation(m, rot);
    } else {
      meta.lastSeen = now;

      // Update position
      meta.marker.setLatLng([v.lat, v.lon]);

      // Update icon if needed
      if (meta.kind !== kind) {
        meta.kind = kind;
        meta.marker.setIcon(getIcon(kind, wantAnim));
      } else {
        // Only swap icon if anim mode requires it
        const currentlyAnimated = isAnimatedFor(id, selectedId);
        meta.marker.setIcon(getIcon(kind, currentlyAnimated));
      }

      // Update rotation only if it changed
      if (meta.rot !== rot) {
        meta.rot = rot;
        setMarkerRotation(meta.marker, rot);
      }
    }
  }

  pruneStale(now);
}

async function loop() {
  while (true) {
    try {
      const data = await fetchVehicles();
      lastData = data;

      if (Array.isArray(data.vehicles)) {
        renderVehicles(data.vehicles);
      } else {
        setHud("No vehicles", "API returned no vehicles array");
      }
    } catch (e) {
      setHud("API error", String(e?.message || e));
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

initMap();
loop();

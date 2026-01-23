/* public/app.js */
/* global L */

const API_URL = "/api/vehicles";
const POLL_MS = 10_000;

const ICON_SIZE = 32;

// Performance knob:
//  - "selected": only the selected marker uses animated Fluent PNG (recommended)
//  - "all": all markers animated (likely VERY laggy on mobile)
//  - "none": all markers static
const ANIM_MODE = "selected";

// Emoji paths (animated in /emoji, static in /emoji/static)
const ICONS = {
  bus: { anim: "/emoji/bus.png", static: "/emoji/static/bus.png" },
  // Future-proof: add more kinds here if you introduce other modes later.
};

// Your Fluent bus art points to the RIGHT by default.
// GTFS bearing: 0=north, 90=east, 180=south, 270=west.
// When the icon is unrotated (pointing right), it corresponds to bearing=90.
const ICON_BASE_BEARING = 90;

// Keep rotation within +/-90 so it never inverts.
// If heading would require going beyond that, we flip (mirror) instead.
const MAX_ROT_DEG = 90;

// Prevent flip/unflip jitter when bearing hovers near the boundary.
// Bigger = less jitter but slightly less accurate near the boundary.
const FLIP_HYSTERESIS_DEG = 10;

// Hard cap to avoid DOM explosion on mobile.
const SAFETY_MAX_MARKERS = 400;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// Normalize degrees to (-180, 180]
function normalize180(deg) {
  let x = deg % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

function isAnimatedFor(id, selectedId) {
  if (ANIM_MODE === "all") return true;
  if (ANIM_MODE === "none") return false;
  return id === selectedId; // "selected"
}

function kindForVehicle(_v) {
  // TfNSW vehiclepos/buses feed => bus
  return "bus";
}

function iconSrc(kind, animated) {
  const info = ICONS[kind] || ICONS.bus;
  if (animated) return info.anim || info.static;
  return info.static || info.anim;
}

// Cache divIcons by kind+anim so we don't rebuild HTML strings constantly
const ICON_CACHE = new Map(); // key => L.DivIcon
function getDivIcon(kind, animated) {
  const key = `${kind}:${animated ? "anim" : "static"}`;
  const cached = ICON_CACHE.get(key);
  if (cached) return cached;

  const src = iconSrc(kind, animated);

  // Two-layer structure:
  //  - .veh-rot rotates
  //  - .veh-img flips (mirror)
  // Nested transforms guarantee order: flip first (inner) then rotate (outer)
  const html = `
    <span class="veh-rot">
      <img class="veh-img" alt="" src="${src}" decoding="async" />
    </span>
  `;

  const icon = L.divIcon({
    html,
    className: "veh-icon",
    iconSize: [ICON_SIZE, ICON_SIZE],
    iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
  });

  ICON_CACHE.set(key, icon);
  return icon;
}

// Pose = rotation + flip. Rotation always in [-90,+90].
function poseFromBearing(bearing, prevFlip) {
  if (!Number.isFinite(bearing)) {
    return { rot: 0, flip: !!prevFlip };
  }

  // Signed angle from the icon's base direction (east/right).
  // a=0 => east, a=+90 => south, a=-90 => north, a=±180 => west.
  const a = normalize180(bearing - ICON_BASE_BEARING);
  const absA = Math.abs(a);

  // Decide flip with hysteresis to avoid rapid mirror toggling near |a|≈90.
  let flip = !!prevFlip;
  if (flip) {
    // stay flipped until we're clearly back in the "east half"
    if (absA < MAX_ROT_DEG - FLIP_HYSTERESIS_DEG) flip = false;
  } else {
    // don't flip until we're clearly into the "west half"
    if (absA > MAX_ROT_DEG + FLIP_HYSTERESIS_DEG) flip = true;
  }

  // Compute rotation that matches the bearing while staying within [-90,+90].
  // If flipped, the "base" direction becomes west (±180), so we subtract/add 180.
  let rot;
  if (!flip) {
    rot = clamp(a, -MAX_ROT_DEG, MAX_ROT_DEG);
  } else {
    rot = a > 0 ? a - 180 : a + 180;
    rot = clamp(rot, -MAX_ROT_DEG, MAX_ROT_DEG);
  }

  return { rot, flip };
}

function applyPose(marker, pose) {
  const el = marker.getElement();
  if (!el) return false;

  const rotEl = el.querySelector(".veh-rot");
  const imgEl = el.querySelector(".veh-img");

  if (rotEl) {
    rotEl.style.transformOrigin = "50% 50%";
    rotEl.style.transform = `rotate(${pose.rot}deg)`;
  }
  if (imgEl) {
    imgEl.style.transformOrigin = "50% 50%";
    imgEl.style.transform = pose.flip ? "scaleX(-1)" : "scaleX(1)";
  }
  return true;
}

function applyPoseLater(marker, pose) {
  if (applyPose(marker, pose)) return;
  requestAnimationFrame(() => applyPose(marker, pose));
}

let map;
let selectedId = null;
let lastData = null;

// id -> meta
const markerMeta = new Map();
// meta: { marker, kind, lastSeen, pose:{rot,flip}, animated:boolean }

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

  // Re-apply icon choice based on selection
  for (const [mid, meta] of markerMeta.entries()) {
    const wantAnim = isAnimatedFor(mid, selectedId);
    if (meta.animated !== wantAnim) {
      meta.animated = wantAnim;
      meta.marker.setIcon(getDivIcon(meta.kind, wantAnim));
      applyPoseLater(meta.marker, meta.pose);
    }
  }

  const v = lastData?.vehicles?.find((x) => x.id === id);
  if (v) {
    setHud(`Selected: ${id}`, v.route_id ? `Route: ${v.route_id}` : "");
    map.setView([v.lat, v.lon], Math.max(map.getZoom(), 14), { animate: true });
  }
}

function renderVehicles(vehicles, fromMove = false) {
  const now = Date.now();

  // Only render markers in/near viewport to keep mobile fast
  const bounds = map.getBounds().pad(0.25);

  const visible = [];
  for (const v of vehicles) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    if (!bounds.contains([v.lat, v.lon])) continue;
    visible.push(v);
    if (visible.length >= SAFETY_MAX_MARKERS) break;
  }

  if (!fromMove) {
    setHud(
      `Vehicles in view: ${visible.length}`,
      selectedId ? `Selected: ${selectedId}` : ""
    );
  }

  const visibleIds = new Set(visible.map((v) => v.id));

  // Remove from map (DOM) when not visible, but keep metadata for quick return
  for (const [id, meta] of markerMeta.entries()) {
    if (!visibleIds.has(id) && map.hasLayer(meta.marker)) {
      map.removeLayer(meta.marker);
    }
  }

  for (const v of visible) {
    const id = v.id;
    const kind = kindForVehicle(v);
    const wantAnim = isAnimatedFor(id, selectedId);

    const existing = markerMeta.get(id);
    const prevFlip = existing?.pose?.flip ?? false;
    const pose = poseFromBearing(v.bearing, prevFlip);

    if (!existing) {
      const m = L.marker([v.lat, v.lon], {
        icon: getDivIcon(kind, wantAnim),
        keyboard: false,
      });

      m.on("click", () => onMarkerClick(id));
      m.addTo(map);

      markerMeta.set(id, {
        marker: m,
        kind,
        lastSeen: now,
        pose,
        animated: wantAnim,
      });

      applyPoseLater(m, pose);
    } else {
      existing.lastSeen = now;

      // Ensure marker is on map if visible
      if (!map.hasLayer(existing.marker)) existing.marker.addTo(map);

      // Move
      existing.marker.setLatLng([v.lat, v.lon]);

      // Icon swap only if needed
      if (existing.kind !== kind || existing.animated !== wantAnim) {
        existing.kind = kind;
        existing.animated = wantAnim;
        existing.marker.setIcon(getDivIcon(kind, wantAnim));
      }

      // Pose update (rotation+flip)
      existing.pose = pose;
      applyPoseLater(existing.marker, pose);
    }
  }

  pruneStale(now);
}

async function loop() {
  while (true) {
    try {
      const data = await fetchVehicles();
      lastData = data;
      if (Array.isArray(data.vehicles)) renderVehicles(data.vehicles);
      else setHud("No vehicles", "API returned no vehicles array");
    } catch (e) {
      setHud("API error", String(e?.message || e));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

initMap();
loop();

/* global L */

const API_URL = "/api/vehicles";
const ICON_URL = "/emoji/bus.png";

/*
  Bearing in GTFS-RT is typically degrees clockwise from North (0 = North, 90 = East).
  Most emoji artwork points "east" (to the right) when unrotated, so we default to -90deg
  so that:
    bearing 90 (east) => rot 0deg (points right)
  If your bus looks sideways or backwards, tweak this:
    - sideways: try +90 or -90
    - backwards: add 180
*/
const ICON_HEADING_OFFSET_DEG = -90;

const ICON_SIZE = 36;
const ICON_ANCHOR = ICON_SIZE / 2;

const hud1 = document.getElementById("hud-line-1");
const hud2 = document.getElementById("hud-line-2");

function setHud(a, b = "") {
  if (hud1) hud1.textContent = a;
  if (hud2) hud2.textContent = b;
}

function clampTtlSeconds(ttl) {
  const n = Number(ttl);
  if (!Number.isFinite(n)) return 10;
  return Math.max(5, Math.min(60, Math.round(n)));
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return `${m}m`;
}

// Map setup (Sydney-ish default)
const map = L.map("map", { zoomControl: true }).setView([-33.8688, 151.2093], 11);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const vehicleIcon = L.divIcon({
  className: "veh",
  html: `<div class="veh-wrap"><img class="veh-img" src="${ICON_URL}" alt="vehicle" /></div>`,
  iconSize: [ICON_SIZE, ICON_SIZE],
  iconAnchor: [ICON_ANCHOR, ICON_ANCHOR],
});

const markers = new Map(); // id -> L.Marker
let lastOkAt = 0;
let timer = null;

async function poll() {
  const started = Date.now();

  try {
    const res = await fetch(API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`API ${res.status}`);

    const data = await res.json();
    const ttl = clampTtlSeconds(data.ttl);
    const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];

    const seen = new Set();

    for (const v of vehicles) {
      if (!v) continue;

      const id = String(v.id || "");
      if (!id) continue;

      const lat = Number(v.lat);
      const lon = Number(v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      seen.add(id);

      let m = markers.get(id);
      if (!m) {
        m = L.marker([lat, lon], {
          icon: vehicleIcon,
          interactive: false,
          keyboard: false,
        }).addTo(map);

        markers.set(id, m);
      } else {
        m.setLatLng([lat, lon]);
      }

      const bearing = Number(v.bearing);
      const b = Number.isFinite(bearing) ? bearing : 0;
      const rot = b + ICON_HEADING_OFFSET_DEG;

      const el = m.getElement();
      if (el) {
        el.style.setProperty("--rot", `${rot}deg`);
      }
    }

    // Remove stale markers
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        map.removeLayer(m);
        markers.delete(id);
      }
    }

    lastOkAt = Date.now();
    const took = lastOkAt - started;

    setHud(
      `${vehicles.length} vehicles`,
      `updated ${new Date(lastOkAt).toLocaleTimeString()} • ${took}ms • ttl ${ttl}s`,
    );

    clearTimeout(timer);
    timer = setTimeout(poll, ttl * 1000);
  } catch (err) {
    const now = Date.now();
    const last = lastOkAt ? `${fmtAgo(now - lastOkAt)} ago` : "never";

    setHud("API error", `${String(err?.message || err)} • last ok: ${last}`);

    clearTimeout(timer);
    timer = setTimeout(poll, 10 * 1000);
  }
}

setHud("Loading…");
poll();

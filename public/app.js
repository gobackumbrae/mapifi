// public/app.js

const API_URL = "/api/vehicles";
const POLL_MS = 15000;

// Side-view emoji only.
const VEHICLE_EMOJI = "🚗";

const hud1 = document.getElementById("hud-line-1");
const hud2 = document.getElementById("hud-line-2");

const map = L.map("map", { zoomControl: true }).setView([0, 0], 2);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

tryCenterOnGeolocation();

const markers = new Map(); // id -> { marker, vehEl, rootEl, lastSeenMs, lastLat, lastLon }
let inFlight = false;

scheduleNextPoll(0);

function scheduleNextPoll(delay) {
  setTimeout(pollOnce, delay);
}

async function pollOnce() {
  if (inFlight) {
    scheduleNextPoll(POLL_MS);
    return;
  }
  inFlight = true;

  const started = Date.now();
  hud1.textContent = "Updating…";
  hud2.textContent = "";

  try {
    const res = await fetch(API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];

    const now = Date.now();

    for (const v of vehicles) {
      const id = String(v.id || "");
      const lat = Number(v.lat);
      const lon = Number(v.lon);

      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      let entry = markers.get(id);
      if (!entry) {
        const marker = makeEmojiMarker(lat, lon, VEHICLE_EMOJI);
        marker.addTo(map);

        entry = {
          marker,
          vehEl: null,
          rootEl: null,
          lastSeenMs: now,
          lastLat: lat,
          lastLon: lon,
        };
        markers.set(id, entry);
      } else {
        entry.marker.setLatLng([lat, lon]);
        entry.lastSeenMs = now;
      }

      let bearing = Number(v.bearing);
      if (!Number.isFinite(bearing)) {
        bearing = computeBearing(entry.lastLat, entry.lastLon, lat, lon);
      }

      applyBearing(entry, bearing);

      entry.lastLat = lat;
      entry.lastLon = lon;
    }

    const STALE_MS = 120000;
    for (const [id, entry] of markers) {
      if (now - entry.lastSeenMs > STALE_MS) {
        map.removeLayer(entry.marker);
        markers.delete(id);
      }
    }

    const dt = Date.now() - started;
    hud1.textContent = `Vehicles: ${markers.size}`;
    hud2.textContent = `Updated in ${dt}ms • next in ${Math.round(POLL_MS / 1000)}s`;
  } catch (err) {
    hud1.textContent = "Update failed";
    hud2.textContent = String(err?.message || err || "unknown error");
  } finally {
    inFlight = false;
    scheduleNextPoll(POLL_MS);
  }
}

function makeEmojiMarker(lat, lon, emoji) {
  const icon = L.divIcon({
    className: "veh-icon",
    html: `<span class="veh">${emoji}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });

  return L.marker([lat, lon], { icon });
}

function applyBearing(entry, bearingDegFromNorth) {
  if (!Number.isFinite(bearingDegFromNorth)) return;

  const root = entry.marker.getElement && entry.marker.getElement();
  if (!root) return;

  if (entry.rootEl !== root) {
    entry.rootEl = root;
    entry.vehEl = root.querySelector(".veh");
  }
  if (!entry.vehEl) return;

  // Emoji faces East by default; GTFS bearing is degrees clockwise from North.
  let rot = normalizeDegrees(bearingDegFromNorth - 90);

  // Never upside-down: keep rotation within [-90, 90] and mirror for the other half.
  let flip = 1;
  if (rot > 90) {
    rot -= 180;
    flip = -1;
  } else if (rot < -90) {
    rot += 180;
    flip = -1;
  }

  entry.vehEl.style.transform = `rotate(${rot}deg) scaleX(${flip})`;
}

function normalizeDegrees(deg) {
  let d = deg % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// Returns bearing in degrees clockwise from North (0..360)
function computeBearing(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const θ = Math.atan2(y, x);
  return (toDeg(θ) + 360) % 360;
}

function tryCenterOnGeolocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      if (Number.isFinite(lat) && Number.isFinite(lon)) map.setView([lat, lon], 13);
    },
    () => {},
    { enableHighAccuracy: false, maximumAge: 60000, timeout: 5000 },
  );
}

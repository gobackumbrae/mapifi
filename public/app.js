(() => {
  const API_URL = "/api/vehicles";

  // Fluent animated Bus faces RIGHT (East).
  // So "0 rotation" points to 270° (West).
  const BUS_ICON = {
    url: "/emoji/bus.png",
    pointsToDeg: 270,     // <-- IMPORTANT: Fluent Bus points East (right)
    sizePx: 34,
  };

  // Refresh roughly at TTL cadence (backend ttl=10s)
  const REFRESH_MS = 10_000;

  // Performance guardrails:
  // - Only render vehicles inside (viewport bounds padded a bit).
  // - If still too many, render none and tell you to zoom in (otherwise the browser dies with animated PNGs).
  const BOUNDS_PAD = 0.10;
  const MAX_VISIBLE_MARKERS = 250;

  const hud1 = document.getElementById("hud-line-1");
  const hud2 = document.getElementById("hud-line-2");

  const map = L.map("map", { zoomControl: true });
  // Default view: Sydney (fallback)
  map.setView([-33.8688, 151.2093], 12);

  // Optional: center on device location if available (no UI needed)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 14);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 5_000 },
    );
  }

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);

  const markers = new Map();  // id -> Leaflet marker
  const lastPose = new Map(); // id -> { flip: boolean }
  const lastPos = new Map();  // id -> { lat, lon }

  let lastData = null;
  let inflight = false;

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  // Normalize degrees into [-180, 180)
  function normalizeDeg(d) {
    let x = ((d % 360) + 360) % 360;
    if (x >= 180) x -= 360;
    return x;
  }

  // Compute marker pose:
  // - Rotate towards bearing
  // - If that would make it "upside down" (|rot| > 90), flip horizontally and keep rot within [-90,90]
  // - Uses hysteresis to prevent flip-flopping around the threshold
  function computePose(bearingDeg, iconPointsToDeg, prevFlip) {
    let a = normalizeDeg(bearingDeg - iconPointsToDeg); // relative angle
    let flip = !!prevFlip;

    const FLIP_ON = 100;  // enter flip mode past this
    const FLIP_OFF = 80;  // exit flip mode inside this

    if (!flip && (a > FLIP_ON || a < -FLIP_ON)) flip = true;
    else if (flip && (a < FLIP_OFF && a > -FLIP_OFF)) flip = false;

    if (flip) {
      // bring rotation back toward upright, then mirror the sprite
      a = a > 0 ? a - 180 : a + 180;
    }

    // Hard guarantee: never upside down
    a = clamp(a, -90, 90);

    return { rot: a, flip };
  }

  // If bearing is missing, estimate from movement (previous position -> current position)
  function bearingFromDelta(prev, next) {
    const toRad = (x) => (x * Math.PI) / 180;
    const toDeg = (x) => (x * 180) / Math.PI;

    const lat1 = toRad(prev.lat);
    const lat2 = toRad(next.lat);
    const dLon = toRad(next.lon - prev.lon);

    const y = Math.sin(dLon) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

    const brng = toDeg(Math.atan2(y, x));
    return ((brng % 360) + 360) % 360;
  }

  function makeMarker(lat, lon) {
    const html = `
      <div class="veh-icon" style="--s:${BUS_ICON.sizePx}px">
        <div class="veh-rot">
          <img class="veh-img" src="${BUS_ICON.url}" alt="" draggable="false" />
        </div>
      </div>
    `.trim();

    const icon = L.divIcon({
      className: "veh-marker",
      html,
      iconSize: [BUS_ICON.sizePx, BUS_ICON.sizePx],
      iconAnchor: [BUS_ICON.sizePx / 2, BUS_ICON.sizePx / 2],
    });

    return L.marker([lat, lon], {
      icon,
      interactive: false,
      keyboard: false,
    }).addTo(map);
  }

  function applyPose(marker, pose) {
    const el = marker.getElement();
    if (!el) return;

    const rotEl = el.querySelector(".veh-rot");
    const imgEl = el.querySelector(".veh-img");
    if (!rotEl || !imgEl) return;

    // Force override so no other CSS/Leaflet transform junk can beat us.
    rotEl.style.setProperty("transform", `rotate(${pose.rot}deg)`, "important");
    imgEl.style.setProperty("transform", pose.flip ? "scaleX(-1)" : "scaleX(1)", "important");
  }

  function fmtAge(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}m${r}s ago`;
  }

  function render(data) {
    if (!data || !Array.isArray(data.vehicles)) return;

    const bounds = map.getBounds().pad(BOUNDS_PAD);
    const visible = data.vehicles.filter((v) => {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return false;
      return bounds.contains([v.lat, v.lon]);
    });

    if (visible.length > MAX_VISIBLE_MARKERS) {
      hud1.textContent = `${visible.length.toLocaleString()} vehicles (zoom in)`;
      hud2.textContent = `too many to render with animated markers • updated ${fmtAge(Date.now() - data.generated_at)} • ttl ${data.ttl}s`;

      // Drop markers to keep interaction fast
      for (const [, m] of markers) map.removeLayer(m);
      markers.clear();
      lastPose.clear();
      return;
    }

    hud1.textContent = `${visible.length.toLocaleString()} vehicles`;
    hud2.textContent = `updated ${fmtAge(Date.now() - data.generated_at)} • ttl ${data.ttl}s`;

    const seen = new Set();

    for (const v of visible) {
      const id = String(v.id);
      seen.add(id);

      let m = markers.get(id);
      if (!m) {
        m = makeMarker(v.lat, v.lon);
        markers.set(id, m);
      } else {
        m.setLatLng([v.lat, v.lon]);
      }

      // Pick bearing: feed bearing first, else infer from motion
      let b = Number(v.bearing);
      if (!Number.isFinite(b)) {
        const prev = lastPos.get(id);
        if (prev) b = bearingFromDelta(prev, v);
      }
      if (!Number.isFinite(b)) b = 0;
      b = ((b % 360) + 360) % 360;

      lastPos.set(id, { lat: v.lat, lon: v.lon });

      const prevPose = lastPose.get(id);
      const pose = computePose(b, BUS_ICON.pointsToDeg, prevPose?.flip);
      lastPose.set(id, pose);

      applyPose(m, pose);
    }

    // Remove markers no longer in view (or disappeared)
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        map.removeLayer(m);
        markers.delete(id);
        lastPose.delete(id);
      }
    }
  }

  async function tick() {
    if (inflight) return;
    inflight = true;
    try {
      // cache-bust so you always get fresh JSON
      const res = await fetch(`${API_URL}?v=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      lastData = data;
      render(data);
    } catch (e) {
      hud1.textContent = "Error";
      hud2.textContent = String(e?.message || e || "unknown error");
      console.error(e);
    } finally {
      inflight = false;
    }
  }

  map.on("moveend zoomend", () => {
    if (lastData) render(lastData);
  });

  tick();
  setInterval(tick, REFRESH_MS);
})();

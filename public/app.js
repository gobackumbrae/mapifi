/* global L */
(() => {
  const hud1 = document.getElementById("hud-line-1");
  const hud2 = document.getElementById("hud-line-2");

  const qs = new URLSearchParams(location.search);
  const FEED = (qs.get("feed") || "all").trim() || "all";
  const RENDER_MODE = (qs.get("render") || "bounds").trim().toLowerCase(); // bounds|all
  const RENDER_ALL = RENDER_MODE === "all";
  const MAX_ON_MAP = clamp(qs.get("max") || 250, 50, 2000); // performance safety

  const API_VEHICLES = "/api/vehicles";

  function clamp(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function setHud(a, b) {
    if (hud1) hud1.textContent = a || "";
    if (hud2) hud2.textContent = b || "";
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // Map
  const map = L.map("map", {
    zoomControl: true,
    preferCanvas: false,
    worldCopyJump: true,
    markerZoomAnimation: false,
    fadeAnimation: false,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);

  map.setView([-33.8688, 151.2093], 12);

  // Tap near a vehicle to see a small pill with route/trip/id
  const pillPopup = L.popup({
    closeButton: false,
    autoClose: true,
    closeOnClick: true,
    className: "veh-pill-popup",
    offset: [0, -14],
  });

  // Optional: center on user
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = pos && pos.coords ? pos.coords : null;
        const lat = c ? Number(c.latitude) : NaN;
        const lon = c ? Number(c.longitude) : NaN;
        if (Number.isFinite(lat) && Number.isFinite(lon)) map.setView([lat, lon], 13);

  // Tap near a vehicle to see a small pill with route/trip/id
  const pillPopup = L.popup({
    closeButton: false,
    autoClose: true,
    closeOnClick: true,
    className: "veh-pill-popup",
    offset: [0, -14],
  });
      },
      () => {},
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 },
    );
  }

  // Icons
  const iconCache = new Map(); // iconUrl -> L.DivIcon

  // MAPIFI_DERIVED_BEARING: when GTFS bearing is missing, derive heading from GPS movement

  // Feeds where we always derive heading from movement (ignore upstream bearing)
  const FORCE_DERIVED_FEEDS = new Set(["sydneytrains","nswtrains"]);

  function deg2rad(d) { return (d * Math.PI) / 180; }

  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; /* meters */
    const p1 = deg2rad(lat1);
    const p2 = deg2rad(lat2);
    const dp = deg2rad(lat2 - lat1);
    const dl = deg2rad(lon2 - lon1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function bearingBetween(lat1, lon1, lat2, lon2) {
    const p1 = deg2rad(lat1);
    const p2 = deg2rad(lat2);
    const dl = deg2rad(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    const brng = Math.atan2(y, x) * 180 / Math.PI;
    return normalizeDeg(brng);
  }

  function getIcon(iconUrl) {
    const key = iconUrl || "/emoji/bus.png";
    const cached = iconCache.get(key);
    if (cached) return cached;

    const icon = L.divIcon({
      className: "veh",
      html: `<img class="veh-icon" src="${key}" alt="" decoding="async" loading="lazy" />`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    iconCache.set(key, icon);
    return icon;
  }

  // Feed metadata (from /api/vehicles response: data.feeds)
  let feedMeta = new Map(); // id -> {label, icon, facing}

  // Markers: id -> { marker, iconUrl, facing, seenAt, onMap }
  const markers = new Map();

  // Last payload for instant re-render on pan/zoom
  let lastVehicles = [];
  let lastErrors = [];
  let ttlSeconds = 10;
  let inFlight = false;

  function normalizeDeg(d) {
    let x = d % 360;
    if (x < 0) x += 360;
    return x;
  }

  // Convert GTFS-RT bearing (deg clockwise from NORTH) to CSS rotation for base-facing icons.
  // Fluent emoji assets are RIGHT-facing by default:
  //   bearing 90 (east) => rotate(0)
  // Then enforce "never upside-down": keep rotation within [-90, 90] by flipping horizontally.
  function transformForBearing(bearing, facing) {
    const b = Number(bearing);
    if (!Number.isFinite(b)) return "";

    const f = String(facing || "right").toLowerCase();
    let theta;
    if (f === "left") theta = normalizeDeg(b + 90);
    else if (f === "up") theta = normalizeDeg(b);
    else if (f === "down") theta = normalizeDeg(b + 180);
    else theta = normalizeDeg(b - 90); // right (default)

    let rot = theta;
    let flip = false;
    if (rot > 90 && rot < 270) {
      rot = rot - 180;
      flip = true;
    }
    return `rotate(${rot}deg)${flip ? " scaleX(-1)" : ""}`;
  }

  function applyHeading(marker, bearing, facing) {
  const el = marker && marker.getElement ? marker.getElement() : null;
  if (!el) return;

  // Prefer wrapper-based transforms (rotate wrapper, flip image). Fall back to img-only.
  const rotEl = el.querySelector(".veh-rot") || el.querySelector("img");
  const img = el.querySelector(".veh-img") || el.querySelector("img");
  if (!rotEl || !img) return;

  const b = Number(bearing);
  if (!Number.isFinite(b)) {
    rotEl.style.transform = "";
    if (img !== rotEl) img.style.transform = "";
    return;
  }

  function norm360(x) {
    x = x % 360;
    return x < 0 ? x + 360 : x;
  }
  function normSigned(x) {
    x = norm360(x);
    if (x > 180) x -= 360;
    return x;
  }
  function baseBearingFromFacing(f) {
    const key = String(f || "").trim().toLowerCase();
    const map = {
      up: 0, north: 0,
      right: 90, east: 90,
      down: 180, south: 180,
      left: 270, west: 270,

      "top-right": 45, topright: 45, upright: 45, ne: 45,
      "top-left": 315, topleft: 315, upleft: 315, nw: 315,
      "bottom-right": 135, bottomright: 135, downright: 135, se: 135,
      "bottom-left": 225, bottomleft: 225, downleft: 225, sw: 225
    };
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];

    // Allow numeric degrees as a string, e.g. "45"
    const n = Number(key);
    if (Number.isFinite(n)) return norm360(n);

    return 270; // default "left"
  }

  // Base direction the art is pointing (bearing degrees from north)
  const base = baseBearingFromFacing(facing);

  // Horizontal flip mirrors the base direction across the N-S axis
  const baseFlip = norm360(360 - base);

  // Two candidates:
  //  - rotate without flip
  //  - rotate after horizontal flip
  const rNo = normSigned(b - base);
  const rFlip = normSigned(b - baseFlip);

  // Choose a representation that keeps the sprite upright (|rotation| <= 90) if possible.
  const okNo = Math.abs(rNo) <= 90;
  const okFlip = Math.abs(rFlip) <= 90;

  let useFlip = false;
  let r = rNo;

  if (okFlip && (!okNo || Math.abs(rFlip) < Math.abs(rNo))) {
    useFlip = true;
    r = rFlip;
  }

  // Apply transforms
  if (rotEl === img) {
    img.style.transform = useFlip
      ? ("rotate(" + r + "deg) scaleX(-1)")
      : ("rotate(" + r + "deg)");
  } else {
    rotEl.style.transform = "rotate(" + r + "deg)";
    img.style.transform = useFlip ? "scaleX(-1)" : "";
  }
}

  function withinRenderBounds(lat, lon) {
    if (RENDER_ALL) return true;
    const b = map.getBounds().pad(0.2);
    return b.contains([lat, lon]);
  }

  function updateMarkers(vehicles) {
    const now = Date.now();
    const ttlMs = Math.max(5, ttlSeconds) * 1000;
    const dropAfter = Math.max(3 * ttlMs, 30000);

    const seenNow = new Set();
    let rendered = 0;

    for (const v of vehicles) {
      if (!v) continue;
      const id = String(v.id || "");
      if (!id) continue;

      const lat = Number(v.lat);
      const lon = Number(v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      seenNow.add(id);

      const fid = String(v.feed || "default");
      const meta = feedMeta.get(fid) || null;

      const iconUrl = ((v && typeof v.icon === "string" ? v.icon.trim() : "") || (feed && feed.icon) || "/emoji/bus.png");
      const facing = ((v && typeof v.facing === "string" ? v.facing.trim() : "") || (feed && feed.facing) || "left");

      let entry = markers.get(id);
      if (!entry) {
        const marker = L.marker([lat, lon], {
          icon: getIcon(iconUrl),
          interactive: false,
          keyboard: false,
        });
        entry = { marker, iconUrl, facing, seenAt: now, onMap: false };
        markers.set(id, entry);
      }

      entry.seenAt = now;
      // MAPIFI_LAST_BEARING_BLOCK: keep a stable bearing even when feed omits it
      const prevLL = entry.marker.getLatLng();
      entry.marker.setLatLng([lat, lon]);

      const forceDerived = FORCE_DERIVED_FEEDS.has(feedId);
      const b0 = forceDerived ? NaN : Number(v.bearing);
      if (Number.isFinite(b0)) {
        entry.lastBearing = b0;
      } else {
        const prevLat = prevLL && Number.isFinite(prevLL.lat) ? prevLL.lat : NaN;
        const prevLon = prevLL && Number.isFinite(prevLL.lng) ? prevLL.lng : NaN;
        if (Number.isFinite(prevLat) && Number.isFinite(prevLon)) {
          const moved = distanceMeters(prevLat, prevLon, lat, lon);
          if (moved >= 1) {
            const b1 = bearingBetween(prevLat, prevLon, lat, lon);
            if (Number.isFinite(b1)) entry.lastBearing = b1;
          }
        }
      }


      if (entry.iconUrl !== iconUrl) {
        entry.iconUrl = iconUrl;
        entry.marker.setIcon(getIcon(iconUrl));
      }
      entry.facing = facing;

      entry.meta = {
        id: id,
        label: (v && typeof v.label === "string" ? v.label : ((feed && feed.label) ? feed.label : (feedId || ""))),
        route_id: (v && v.route_id != null ? String(v.route_id) : ""),
        trip_id: (v && v.trip_id != null ? String(v.trip_id) : ""),
      };

      const inBounds = withinRenderBounds(lat, lon);
      const shouldRender = inBounds && (rendered < MAX_ON_MAP);
      if (shouldRender) rendered++;

      if (shouldRender) {
        if (!entry.onMap) {
          entry.marker.addTo(map);
          entry.onMap = true;
        }
        applyHeading(entry.marker, entry.lastBearing, facing);
      } else {
        if (entry.onMap) {
          map.removeLayer(entry.marker);
          entry.onMap = false;
        }
      }
    }

    // Cleanup stale markers
    for (const [id, entry] of markers) {
      if (now - entry.seenAt > dropAfter && !seenNow.has(id)) {
        if (entry.onMap) map.removeLayer(entry.marker);
        markers.delete(id);
      }
    }
  }

  function updateHud(data) {
    const vehicles = Array.isArray(data && data.vehicles) ? data.vehicles : [];
    const errors = Array.isArray(data && data.errors) ? data.errors : [];

    const counts = new Map();
    for (const v of vehicles) {
      const fid = String((v && v.feed) || "default");
      counts.set(fid, (counts.get(fid) || 0) + 1);
    }

    const total = vehicles.length;
    const updatedAt = Number(data && data.generated_at) || Date.now();

    const feedLabel =
      FEED === "all"
        ? "all feeds"
        : ((feedMeta.get(FEED) && feedMeta.get(FEED).label) || FEED);

    const mode = RENDER_ALL ? "render=all" : "render=bounds";

    let line1 = `${total} vehicles`;
    if (FEED === "all" && counts.size) {
      const bits = [];
      for (const [fid, n] of counts) {
        const meta = feedMeta.get(fid);
        const lbl = meta && meta.label ? meta.label : fid;
        bits.push(`${lbl}:${n}`);
      }
      line1 = `${total} vehicles (${bits.slice(0, 4).join(" · ")}${bits.length > 4 ? " · …" : ""})`;
    }

    let line2 = `${feedLabel} · ${mode} · max ${MAX_ON_MAP} · updated ${fmtTime(updatedAt)} · ttl ${ttlSeconds}s`;

    if (errors.length) {
      const short = errors
        .slice(0, 3)
        .map((e) => `${e.feed}:${String(e.error || "").replace(/^Upstream\s+/, "")}`)
        .join(", ");
      line2 += ` · errors: ${short}${errors.length > 3 ? "…" : ""}`;
    }

    setHud(line1, line2);
  }

  async function fetchVehiclesOnce() {
    if (inFlight) return;
    inFlight = true;

    try {
      const url = `${API_VEHICLES}?feed=${encodeURIComponent(FEED)}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();

      const t = Number(data && data.ttl);
      if (Number.isFinite(t)) ttlSeconds = t;

      // Update feed meta if server provides it
      if (data && Array.isArray(data.feeds)) {
        const m = new Map();
        for (const f of data.feeds) {
          if (!f) continue;
          const id = String(f.id || "").trim();
          if (!id) continue;
          m.set(id, {
            label: String(f.label || id),
            icon: String(f.icon || ""),
            facing: String(f.facing || "right"),
          });
        }
        if (m.size) feedMeta = m;
      }

      // Default meta if none
      if (!feedMeta.size) {
        feedMeta = new Map([
          ["default", { label: "Buses", icon: "/emoji/bus.png", facing: "right" }],
        ]);
      }

      lastVehicles = Array.isArray(data && data.vehicles) ? data.vehicles : [];
      lastErrors = Array.isArray(data && data.errors) ? data.errors : [];

      updateMarkers(lastVehicles);
      updateHud(data);
    } catch (err) {
      setHud("Error", String((err && err.message) || err || "fetch failed"));
    } finally {
      inFlight = false;
    }
  }

  // Instant re-render on pan/zoom using lastVehicles (no network)
  function rerender() {
    if (!lastVehicles.length) return;
    updateMarkers(lastVehicles);
  }

  function escHtml(s) {
    return String(s || "").replace(/[&<>"\x27]/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\x22": "&quot;",
      "\x27": "&#39;",
    }[c] || c));
  }

  function vehPillHtml(meta) {
    if (!meta) return "";
    const label = escHtml(meta.label || "Vehicle");
    const route = escHtml(meta.route_id || "");
    const trip  = escHtml(meta.trip_id || "");
    const vid   = escHtml(meta.id || "");

    // “Pattern information” preference order: route_id, then trip_id, then vehicle id
    let main = label;
    if (route) main += ` · ${route}`;
    else if (trip) main += ` · ${trip}`;
    else if (vid) main += ` · ${vid}`;

    // Optional second line if we have BOTH
    let sub = "";
    if (route && trip) sub = `trip ${trip}`;

    return `<div class="veh-pill"><div class="veh-pill-main">${main}</div>${sub ? `<div class="veh-pill-sub">${escHtml(sub)}</div>` : ""}</div>`;
  }

  function nearestRenderedEntry(latlng) {
    const clickPt = map.latLngToLayerPoint(latlng);
    let best = null;
    let bestD2 = Infinity;

    for (const entry of markers.values()) {
      if (!entry || !entry.onMap) continue; // only consider rendered markers (bounds mode)
      const pt = map.latLngToLayerPoint(entry.marker.getLatLng());
      const dx = pt.x - clickPt.x;
      const dy = pt.y - clickPt.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = entry;
      }
    }

    const MAX_PX = 28; // tap radius
    return best && bestD2 <= (MAX_PX * MAX_PX) ? best : null;
  }

  map.on("click", (e) => {
    const entry = nearestRenderedEntry(e.latlng);
    if (!entry) return;
    const html = vehPillHtml(entry.meta);
    if (!html) return;
    pillPopup.setLatLng(entry.marker.getLatLng()).setContent(html).openOn(map);
  });
  map.on("moveend zoomend", rerender);

  async function loop() {
    await fetchVehiclesOnce();
    setTimeout(loop, Math.max(5, ttlSeconds) * 1000);
  }

  (async () => {
    setHud("Loading…", "");
    await fetchVehiclesOnce();
    loop();
  })();
})();

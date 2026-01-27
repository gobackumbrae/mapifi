/* global L */

(() => {
  const hud1 = document.getElementById("hud-line-1");
  const hud2 = document.getElementById("hud-line-2");

  const qs = new URLSearchParams(location.search);
  const SELECTED_FEED = (qs.get("feed") || "all").trim() || "all";
  const RENDER_MODE = (qs.get("render") || "bounds").trim(); // "bounds" (default) or "all"
  const RENDER_ALL = RENDER_MODE === "all";
  const MAX_ON_MAP = Math.max(50, Math.min(2000, Number(qs.get("max") || 350)));

  const API_FEEDS = "/api/feeds";
  const API_VEHICLES = "/api/vehicles";

  const map = L.map("map", {
    zoomControl: true,
    preferCanvas: false,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);

  // Default view: Sydney CBD-ish
  map.setView([-33.8688, 151.2093], 12);

  // Optional: if user grants location permission, center on them
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords || {};
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          map.setView([latitude, longitude], 13);
        }
      },
      () => {},
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 },
    );
  }

  // Feed metadata (id -> {label, icon, facing})
  let feedMap = new Map();

  // Cache Leaflet icons by icon URL
  const iconCache = new Map();

  // id -> { marker, iconUrl, facing, seenAt, onMap }
  const markers = new Map();

  // last fetched payload, used to re-render instantly on pan/zoom
  let lastVehicles = [];
  let lastErrors = [];

  let ttlSeconds = 10;
  let inFlight = false;

  function setHud(line1, line2) {
    if (hud1) hud1.textContent = line1 || "";
    if (hud2) hud2.textContent = line2 || "";
  }

  function normalizeDeg(d) {
    let x = d % 360;
    if (x < 0) x += 360;
    return x;
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

  // Fluent transport emojis are generally drawn facing LEFT.
  // GTFS-RT bearing is degrees clockwise from NORTH.
  // We convert bearing->CSS rotation for a left-facing base icon:
  //   theta = bearing + 90  (so bearing=270 (west) => theta=0)
  // Then enforce "never upside down" by flipping when theta would exceed 90°.
  function applyHeading(marker, bearing, facing = "right") {
    const el = marker.getElement();
    if (!el) return;
    const img = el.querySelector("img");
    if (!img) return;

    img.style.transformOrigin = "50% 50%";
    img.style.willChange = "transform";
    img.style.userSelect = "none";
    img.style.pointerEvents = "none";
    img.style.display = "block";
    img.style.width = "32px";
    img.style.height = "32px";

    const b = Number(bearing);
    if (!Number.isFinite(b)) {
      img.style.transform = "";
      return;
    }

    let theta;
    switch ((facing || "right").toLowerCase()) {
      case "right":
        theta = normalizeDeg(b - 90);
        break;
      case "up":
        theta = normalizeDeg(b);
        break;
      case "down":
        theta = normalizeDeg(b + 180);
        break;
      case "left":
      default:
        theta = normalizeDeg(b + 90);
        break;
    }

    // Never upside down: keep rotation within [-90, 90] by flipping horizontally
    let rot = theta;
    let flip = false;
    if (rot > 90 && rot < 270) {
      rot = rot - 180;
      flip = true;
    }

    img.style.transform = `rotate(${rot}deg)${flip ? " scaleX(-1)" : ""}`;
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  async function loadFeeds() {
    try {
      const res = await fetch(API_FEEDS, { cache: "no-store" });
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.feeds)) {
        feedMap = new Map(
          data.feeds
            .filter((f) => f && f.id)
            .map((f) => [
              String(f.id),
              {
                id: String(f.id),
                label: String(f.label || f.id),
                icon: String(f.icon || ""),
                facing: String(f.facing || "right"),
              },
            ]),
        );
      }
    } catch {
      // ignore; we can still render with defaults
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

    // Markers we saw this tick (for cleanup hints)
    const seenNow = new Set();
    let rendered = 0;

    for (const v of vehicles) {
      if (!v) continue;
      const id = String(v.id || "");
      if (!id) continue;
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;

      const lat = v.lat;
      const lon = v.lon;

      // Bounds-based rendering to avoid 2000+ animated DOM nodes melting the phone
      const render = withinRenderBounds(lat, lon) && (rendered++ < MAX_ON_MAP);

      seenNow.add(id);

      const feedId = String(v.feed || "");
      const feed = feedMap.get(feedId);

      const iconUrl = (feed && feed.icon) ? feed.icon : "/emoji/bus.png";
      const facing = (feed const facing = (feed && feed.facing) ? feed.facing : "left";const facing = (feed && feed.facing) ? feed.facing : "left"; feed.facing) ? feed.facing : "right";

      let entry = markers.get(id);
      if (!entry) {
        const marker = L.marker([lat, lon], {
          icon: getIcon(iconUrl),
          interactive: false,
          keyboard: false,
        });

        entry = {
          marker,
          iconUrl,
          facing,
          seenAt: now,
          onMap: false,
        };
        markers.set(id, entry);
      }

      entry.seenAt = now;

      // Update position always (even if not rendering), so if user pans we can re-add immediately
      entry.marker.setLatLng([lat, lon]);

      if (entry.iconUrl !== iconUrl) {
        entry.iconUrl = iconUrl;
        entry.marker.setIcon(getIcon(iconUrl));
      }
      entry.facing = facing;

      // Add/remove from map based on render bounds
      if (render) {
        if (!entry.onMap) {
          entry.marker.addTo(map);
          entry.onMap = true;
        }
        applyHeading(entry.marker, v.bearing, facing);
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
    const vehicles = Array.isArray(data?.vehicles) ? data.vehicles : [];
    const errors = Array.isArray(data?.errors) ? data.errors : [];

    // counts per feed (even if we render only bounds)
    const counts = new Map();
    for (const v of vehicles) {
      const f = String(v?.feed || "unknown");
      counts.set(f, (counts.get(f) || 0) + 1);
    }

    const total = vehicles.length;
    const updatedAt = Number(data?.generated_at) || Date.now();

    const feedLabel =
      SELECTED_FEED === "all"
        ? "all feeds"
        : (feedMap.get(SELECTED_FEED)?.label || SELECTED_FEED);

    const modeLabel = RENDER_ALL ? "render=all" : "render=bounds";

    let line1 = `${total} vehicles`;
    let line2 = `${feedLabel} · ${modeLabel} · updated ${fmtTime(updatedAt)} · ttl ${ttlSeconds}s`;

    if (errors.length) {
      const short = errors
        .slice(0, 3)
        .map((e) => `${e.feed}:${String(e.error).replace(/^Upstream\s+/, "")}`)
        .join(", ");
      line2 += ` · errors: ${short}${errors.length > 3 ? "…" : ""}`;
    }

    // Optional: tiny per-feed summary if you're on all feeds
    if (SELECTED_FEED === "all" && counts.size) {
      const bits = [];
      for (const [fid, n] of counts) {
        const lbl = feedMap.get(fid)?.label || fid;
        bits.push(`${lbl}:${n}`);
      }
      // Keep it short-ish
      line1 = `${total} vehicles (${bits.slice(0, 4).join(" · ")}${bits.length > 4 ? " · …" : ""})`;
    }

    setHud(line1, line2);
  }

  async function fetchVehiclesOnce() {
    if (inFlight) return;
    inFlight = true;

    try {
      const feedQ = SELECTED_FEED === "all" ? "all" : SELECTED_FEED;
      const url = `${API_VEHICLES}?feed=${encodeURIComponent(feedQ)}`;

      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();

      ttlSeconds = Number(data?.ttl) || ttlSeconds;
      // mapifi-feedmeta: derive icons/labels from /api/vehicles response
      if (data && Array.isArray(data.feeds)) {
        feedMap = new Map(
          data.feeds
            .filter((f) => f && f.id)
            .map((f) => [
              String(f.id),
              {
                id: String(f.id),
                label: String(f.label || f.id),
                icon: String(f.icon || ""),
                facing: String(f.facing || "right"),
              },
            ]),
        );
      }

      lastVehicles = Array.isArray(data?.vehicles) ? data.vehicles : [];
      lastErrors = Array.isArray(data?.errors) ? data.errors : [];

      updateMarkers(lastVehicles);
      updateHud(data);
    } catch (err) {
      setHud("Error", String(err?.message || err || "fetch failed"));
    } finally {
      inFlight = false;
    }
  }

  // Re-render immediately on pan/zoom using lastVehicles (no network)
  function rerender() {
    if (!lastVehicles || !lastVehicles.length) return;
    updateMarkers(lastVehicles);
    // Keep HUD stable
    setHud(
      `${lastVehicles.length} vehicles`,
      `${SELECTED_FEED === "all" ? "all feeds" : SELECTED_FEED} · ${RENDER_ALL ? "render=all" : "render=bounds"} · ttl ${ttlSeconds}s`,
    );
  }

  map.on("moveend zoomend", () => rerender());

  async function loop() {
    await fetchVehiclesOnce();
    const waitMs = Math.max(5, ttlSeconds) * 1000;
    setTimeout(loop, waitMs);
  }

  (async () => {
    setHud("Loading…", "");
    await loadFeeds();
    await fetchVehiclesOnce();
    loop();
  })();
})();

// src/worker.js

const DECODER = new TextDecoder("utf-8");
const API_TTL_SECONDS = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,HEAD,OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, now: Date.now() }, 200, {
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
    }

    if (url.pathname === "/api/vehicles") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { "access-control-allow-origin": "*" },
        });
      }

      const cacheKey = new Request(`${url.origin}/api/vehicles`, { method: "GET" });
      const cache = caches.default;

      const cached = await cache.match(cacheKey);
      if (cached) {
        if (request.method === "HEAD") return headFrom(cached);
        return cached;
      }

      try {
        const vehicles = await fetchAndParseVehicles(env);

        const body = JSON.stringify({
          generated_at: Date.now(),
          ttl: API_TTL_SECONDS,
          vehicles,
        });

        const resp = new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${API_TTL_SECONDS}`,
            "access-control-allow-origin": "*",
          },
        });

        ctx.waitUntil(cache.put(cacheKey, resp.clone()));

        if (request.method === "HEAD") return headFrom(resp);
        return resp;
      } catch (err) {
        return json(
          { ok: false, error: String(err?.message || err || "unknown error") },
          502,
          { "cache-control": "no-store", "access-control-allow-origin": "*" },
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json(
        { ok: false, error: "Not Found" },
        404,
        { "cache-control": "no-store", "access-control-allow-origin": "*" },
      );
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};

function headFrom(resp) {
  return new Response(null, {
    status: resp.status,
    headers: resp.headers,
  });
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

async function fetchAndParseVehicles(env) {
  const upstream = buildUpstreamRequest(env);

  const res = await fetch(upstream.url, {
    method: "GET",
    headers: upstream.headers,
    cf: { cacheEverything: true, cacheTtl: API_TTL_SECONDS },
  });

  if (!res.ok) throw new Error(`Upstream error ${res.status}`);

  const buf = await res.arrayBuffer();
  return parseGtfsRtVehiclePositions(buf);
}

function buildUpstreamRequest(env) {
  let url = env.GTFS_RT_URL;
  if (!url) throw new Error("GTFS_RT_URL is not set");

  const apiKey = env.GTFS_API_KEY || "";

  if (url.includes("{{API_KEY}}")) {
    if (!apiKey) throw new Error("GTFS_API_KEY is not set");
    url = url.split("{{API_KEY}}").join(encodeURIComponent(apiKey));
    return {
      url,
      headers: {
        accept: "application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1",
      },
    };
  }

  const qpName = (env.GTFS_RT_AUTH_QUERY || "").trim();
  if (qpName && apiKey) {
    const u = new URL(url);
    u.searchParams.set(qpName, apiKey);
    return {
      url: u.toString(),
      headers: {
        accept: "application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1",
      },
    };
  }

  const headerName = (env.GTFS_RT_AUTH_HEADER || "").trim();
  const headers = {
    accept: "application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1",
  };
  if (headerName && apiKey) headers[headerName] = apiKey;

  return { url, headers };
}

/**
 * Minimal GTFS-RT VehiclePositions parser extracting:
 * FeedMessage.entity[].vehicle.position.{latitude,longitude,bearing}
 * FeedMessage.entity[].vehicle.vehicle.id (or entity.id fallback)
 * FeedMessage.entity[].vehicle.trip.route_id (optional)
 * FeedMessage.entity[].vehicle.timestamp (optional)
 */
function parseGtfsRtVehiclePositions(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  const out = [];
  let p = 0;

  while (p < bytes.length) {
    const [tag, p2] = readVarint32(bytes, p);
    p = p2;

    const field = tag >>> 3;
    const wire = tag & 7;

    if (field === 2 && wire === 2) {
      const [len, p3] = readVarint32(bytes, p);
      p = p3;
      const end = p + len;
      const v = parseFeedEntity(bytes, dv, p, end);
      if (v) out.push(v);
      p = end;
      continue;
    }

    p = skipField(bytes, p, wire);
  }

  return out;
}

function parseFeedEntity(bytes, dv, start, end) {
  let p = start;

  let entityId = "";
  let isDeleted = false;
  let vehicle = null;

  while (p < end) {
    const [tag, p2] = readVarint32(bytes, p);
    p = p2;
    const field = tag >>> 3;
    const wire = tag & 7;

    if (field === 1 && wire === 2) {
      const [s, p3] = readString(bytes, p);
      entityId = s;
      p = p3;
      continue;
    }

    if (field === 2 && wire === 0) {
      const [v, p3] = readVarint32(bytes, p);
      isDeleted = v !== 0;
      p = p3;
      continue;
    }

    if (field === 4 && wire === 2) {
      const [len, p3] = readVarint32(bytes, p);
      p = p3;
      const vend = p + len;
      vehicle = parseVehiclePosition(bytes, dv, p, vend);
      p = vend;
      continue;
    }

    p = skipField(bytes, p, wire);
  }

  if (isDeleted || !vehicle || !vehicle.position) return null;

  const id = vehicle.vehicleId || entityId || vehicle.tripId || "";
  if (!id) return null;

  const { lat, lon, bearing } = vehicle.position;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id,
    lat,
    lon,
    bearing: Number.isFinite(bearing) ? bearing : null,
    timestamp: vehicle.timestamp ?? null,
    route_id: vehicle.routeId || null,
  };
}

function parseVehiclePosition(bytes, dv, start, end) {
  let p = start;

  let position = null;
  let vehicleId = "";
  let tripId = "";
  let routeId = "";
  let timestamp = null;

  while (p < end) {
    const [tag, p2] = readVarint32(bytes, p);
    p = p2;
    const field = tag >>> 3;
    const wire = tag & 7;

    if (field === 1 && wire === 2) {
      const [len, p3] = readVarint32(bytes, p);
      p = p3;
      const tend = p + len;
      const t = parseTripDescriptor(bytes, p, tend);
      if (t.tripId) tripId = t.tripId;
      if (t.routeId) routeId = t.routeId;
      p = tend;
      continue;
    }

    if (field === 2 && wire === 2) {
      const [len, p3] = readVarint32(bytes, p);
      p = p3;
      const pend = p + len;
      position = parsePosition(bytes, dv, p, pend);
      p = pend;
      continue;
    }

    if (field === 5 && wire === 0) {
      const [v, p3] = readVarint64(bytes, p);
      timestamp = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
      p = p3;
      continue;
    }

    if (field === 8 && wire === 2) {
      const [len, p3] = readVarint32(bytes, p);
      p = p3;
      const vend = p + len;
      vehicleId = parseVehicleDescriptorId(bytes, p, vend) || vehicleId;
      p = vend;
      continue;
    }

    p = skipField(bytes, p, wire);
  }

  return { position, vehicleId, tripId, routeId, timestamp };
}

function parseTripDescriptor(bytes, start, end) {
  let p = start;
  let tripId = "";
  let routeId = "";

  while (p < end) {
    const [tag, p2] = readVarint32(bytes, p);
    p = p2;
    const field = tag >>> 3;
    const wire = tag & 7;

    if (field === 1 && wire === 2) {
      const [s, p3] = readString(bytes, p);
      tripId = s;
      p = p3;
      continue;
    }

    if (field === 5 && wire === 2) {
      const [s, p3] = readString(bytes, p);
      routeId = s;
      p = p3;
      continue;
    }

    p = skipField(bytes, p, wire);
  }

  return { tripId, routeId };
}

function parseVehicleDescriptorId(bytes, start, end) {
  let p = start;
  let id = "";

  while (p < end) {
    const [tag, p2] = readVarint32(bytes, p);
    p = p2;
    const field = tag >>> 3;
    const wire = tag & 7;

    if (field === 1 && wire === 2) {
      const [s, p3] = readString(bytes, p);
      id = s;
      p = p3;
      continue;
    }

    p = skipField(bytes, p, wire);
  }

  return id;
}

function parsePosition(bytes, dv, start, end) {
  let p = start;

  let lat = NaN;
  let lon = NaN;
  let bearing = NaN;

  while (p < end) {
    const [tag, p2] = readVarint32(bytes, p);
    p = p2;
    const field = tag >>> 3;
    const wire = tag & 7;

    if (field === 1 && wire === 5) {
      lat = dv.getFloat32(p, true);
      p += 4;
      continue;
    }

    if (field === 2 && wire === 5) {
      lon = dv.getFloat32(p, true);
      p += 4;
      continue;
    }

    if (field === 3 && wire === 5) {
      bearing = dv.getFloat32(p, true);
      p += 4;
      continue;
    }

    p = skipField(bytes, p, wire);
  }

  return { lat, lon, bearing };
}

function readString(bytes, p) {
  const [len, p2] = readVarint32(bytes, p);
  const start = p2;
  const end = start + len;
  const s = DECODER.decode(bytes.subarray(start, end));
  return [s, end];
}

function readVarint32(bytes, p) {
  let result = 0;
  let shift = 0;

  while (true) {
    if (p >= bytes.length) throw new Error("Truncated varint32");
    const b = bytes[p++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, p];
    shift += 7;
    if (shift > 35) throw new Error("Varint32 too long");
  }
}

function readVarint64(bytes, p) {
  let result = 0n;
  let shift = 0n;

  while (true) {
    if (p >= bytes.length) throw new Error("Truncated varint64");
    const b = bytes[p++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, p];
    shift += 7n;
    if (shift > 70n) throw new Error("Varint64 too long");
  }
}

function skipField(bytes, p, wire) {
  switch (wire) {
    case 0:
      while (true) {
        if (p >= bytes.length) throw new Error("Truncated skip(varint)");
        const b = bytes[p++];
        if ((b & 0x80) === 0) return p;
      }
    case 1:
      return p + 8;
    case 2: {
      const [len, p2] = readVarint32(bytes, p);
      return p2 + len;
    }
    case 5:
      return p + 4;
    default:
      throw new Error(`Unsupported wire type ${wire}`);
  }
}

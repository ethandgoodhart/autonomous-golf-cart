let MAPBOX_TOKEN = '';

const COLORS = {
  lane: '#44ff88',
  connector: '#4488ff',
  center: '#ffcc00',
  eraser: '#ff8800'
};

const FIX_COLORS = {
  4: '#44ff44',  // RTK Fix — green
  5: '#ffcc00',  // RTK Float — yellow
  2: '#ff8800',  // DGPS — orange
  1: '#ff4444',  // GPS — red
  0: '#888888',  // No fix — gray
};

const GPS_WS_URL = 'ws://localhost:8765';
const GPS_TRAIL_MAX = 3000;
const SNAP_DISTANCE_PX = 20;

let map;
let annotations = [];
let connectors = [];
let eraserPoints = [];
let activeAnnotationId = null;
let activeConnectorId = null;
let currentMode = 'lane';
let pointMarkers = [];
let connectorMarkers = [];
let eraserMarkers = [];
let lineCounter = 0;
let connectorCounter = 0;
let eraserRadius = 8;
let showConnectorCenterLines = false;
let centerLineMarkers = [];
let storedCenterLines = [];

// GPS state
let gpsMarker = null;
let gpsTrail = [];
let gpsFollowing = true;
let gpsWs = null;
let gpsHzCounter = 0;
let gpsHzValue = 0;
let gpsHzInterval = null;
let gpsPointCount = 0;

// --- Auto-save ---

let autoSaveTimer = null;

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(doAutoSave, 500);
}

async function doAutoSave() {
  const data = {
    annotations: annotations.map(ann => ({
      id: ann.id,
      name: ann.name,
      type: ann.type,
      points: ann.points.map(p => ({ lat: p.lat, lng: p.lng }))
    })),
    connectors: connectors.map(conn => ({
      id: conn.id,
      name: conn.name,
      type: conn.type,
      points: conn.points.map(p => ({ lat: p.lat, lng: p.lng }))
    })),
    eraserPoints: eraserPoints.map(ep => ({
      id: ep.id,
      lat: ep.lat,
      lng: ep.lng,
      radius: ep.radius
    })),
    metadata: {
      savedAt: new Date().toISOString(),
      campus: 'Stanford University',
      project: 'FollowRTK Self-Driving Golf Cart'
    }
  };
  try {
    await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (e) {}
}

// --- Geo math ---

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function resampleLine(points, numSamples) {
  if (points.length < 2 || numSamples < 2) return points.slice();
  const dists = [0];
  for (let i = 1; i < points.length; i++) {
    dists.push(dists[i - 1] + haversineMeters(points[i - 1], points[i]));
  }
  const totalDist = dists[dists.length - 1];
  if (totalDist === 0) return points.slice();

  const result = [];
  for (let s = 0; s < numSamples; s++) {
    const target = (s / (numSamples - 1)) * totalDist;
    let seg = 0;
    while (seg < dists.length - 2 && dists[seg + 1] < target) seg++;
    const segLen = dists[seg + 1] - dists[seg];
    const t = segLen > 0 ? (target - dists[seg]) / segLen : 0;
    result.push({
      lat: points[seg].lat + t * (points[seg + 1].lat - points[seg].lat),
      lng: points[seg].lng + t * (points[seg + 1].lng - points[seg].lng)
    });
  }
  return result;
}

function computeCenterLine(line1, line2) {
  const dSame = haversineMeters(line1[0], line2[0])
    + haversineMeters(line1[line1.length - 1], line2[line2.length - 1]);
  const dRev = haversineMeters(line1[0], line2[line2.length - 1])
    + haversineMeters(line1[line1.length - 1], line2[0]);
  const l2 = dRev < dSame ? [...line2].reverse() : line2;

  const n = Math.max(line1.length, l2.length, 20);
  const a = resampleLine(line1, n);
  const b = resampleLine(l2, n);
  return a.map((p, i) => ({
    lat: (p.lat + b[i].lat) / 2,
    lng: (p.lng + b[i].lng) / 2
  }));
}

function applyCenterLineErasure(centerPoints, erasers, defaultRadius) {
  const segments = [];
  let current = [];
  for (const pt of centerPoints) {
    let erased = false;
    for (const ep of erasers) {
      if (haversineMeters(pt, ep) < (ep.radius || defaultRadius)) {
        erased = true;
        break;
      }
    }
    if (erased) {
      if (current.length >= 2) segments.push(current);
      current = [];
    } else {
      current.push(pt);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

// --- Pair detection: group by road name, pair every 2 lanes ---

function findPairs() {
  const byName = {};
  for (const ann of annotations) {
    if (ann.type !== 'lane') continue;
    if (!byName[ann.name]) byName[ann.name] = [];
    byName[ann.name].push(ann);
  }
  const pairs = [];
  for (const name of Object.keys(byName)) {
    const lanes = byName[name];
    for (let i = 0; i + 1 < lanes.length; i += 2) {
      if (lanes[i].points.length >= 2 && lanes[i + 1].points.length >= 2) {
        pairs.push({ name, a: lanes[i], b: lanes[i + 1] });
      }
    }
  }
  return pairs;
}

function findConnectorPairs() {
  const byName = {};
  for (const conn of connectors) {
    if (!byName[conn.name]) byName[conn.name] = [];
    byName[conn.name].push(conn);
  }
  const pairs = [];
  for (const name of Object.keys(byName)) {
    const conns = byName[name];
    for (let i = 0; i + 1 < conns.length; i += 2) {
      if (conns[i].points.length >= 2 && conns[i + 1].points.length >= 2) {
        pairs.push({ name, a: conns[i], b: conns[i + 1] });
      }
    }
  }
  return pairs;
}

function nearestPointOnCenterLines(point, centerLines) {
  let best = null;
  let bestDist = Infinity;
  for (const line of centerLines) {
    for (const pt of line) {
      const d = haversineMeters(point, pt);
      if (d < bestDist) {
        bestDist = d;
        best = { lat: pt.lat, lng: pt.lng };
      }
    }
  }
  return bestDist < 100 ? best : null;
}

// --- Snap to nearest lane point ---

function snapToLanePoint(clickLngLat) {
  let bestDist = Infinity;
  let bestPoint = null;

  for (const ann of annotations) {
    for (const pt of ann.points) {
      const projected = map.project([pt.lng, pt.lat]);
      const clickProjected = map.project([clickLngLat.lng, clickLngLat.lat]);
      const dx = projected.x - clickProjected.x;
      const dy = projected.y - clickProjected.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestPoint = { lat: pt.lat, lng: pt.lng };
      }
    }
  }

  if (bestDist <= SNAP_DISTANCE_PX && bestPoint) {
    return bestPoint;
  }
  return null;
}

// --- Center line rendering ---

let centerLineSources = new Set();

function clearCenterLines() {
  for (const id of centerLineSources) {
    if (map.getLayer(`layer-center-${id}`)) map.removeLayer(`layer-center-${id}`);
    if (map.getSource(`source-center-${id}`)) map.removeSource(`source-center-${id}`);
  }
  centerLineSources.clear();
}

function clearCenterLineMarkers() {
  centerLineMarkers.forEach(m => m.remove());
  centerLineMarkers = [];
}

function addCenterLineLayer(sourceId, points) {
  centerLineSources.add(sourceId);
  const coords = points.map(p => [p.lng, p.lat]);
  const features = coords.length >= 2 ? [{
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords }
  }] : [];

  map.addSource(`source-center-${sourceId}`, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features }
  });
  map.addLayer({
    id: `layer-center-${sourceId}`,
    type: 'line',
    source: `source-center-${sourceId}`,
    paint: {
      'line-color': COLORS.center,
      'line-width': 3,
      'line-dasharray': [4, 3],
      'line-opacity': 0.85
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' }
  });
}

function updateCenterLineSource(sourceId, points) {
  const src = map.getSource(`source-center-${sourceId}`);
  if (!src) return;
  const coords = points.map(p => [p.lng, p.lat]);
  src.setData({
    type: 'FeatureCollection',
    features: coords.length >= 2 ? [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords }
    }] : []
  });
}

function addCenterLinePointMarker(point, clIndex, pointIndex) {
  const el = document.createElement('div');
  el.style.width = '10px';
  el.style.height = '10px';
  el.style.borderRadius = '50%';
  el.style.background = COLORS.center;
  el.style.border = '2px solid white';
  el.style.cursor = 'pointer';
  el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.5)';

  const marker = new mapboxgl.Marker({ element: el, draggable: true })
    .setLngLat([point.lng, point.lat])
    .addTo(map);

  marker._clIndex = clIndex;
  marker._pointIndex = pointIndex;

  marker.on('dragend', () => {
    const lngLat = marker.getLngLat();
    const cl = storedCenterLines[clIndex];
    if (cl && cl.points[marker._pointIndex]) {
      cl.points[marker._pointIndex] = { lat: lngLat.lat, lng: lngLat.lng };
      updateCenterLineSource(cl.sourceId, cl.points);
      scheduleAutoSave();
    }
  });

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const cl = storedCenterLines[clIndex];
    if (!cl || cl.points.length <= 2) return;
    cl.points.splice(pointIndex, 1);
    rebuildCenterLineMarkersForLine(clIndex);
    updateCenterLineSource(cl.sourceId, cl.points);
    scheduleAutoSave();
    setStatus(`Deleted center line point. ${cl.points.length} remaining.`);
  });

  centerLineMarkers.push(marker);
}

function rebuildCenterLineMarkersForLine(clIndex) {
  centerLineMarkers = centerLineMarkers.filter(m => {
    if (m._clIndex === clIndex) {
      m.remove();
      return false;
    }
    return true;
  });
  const cl = storedCenterLines[clIndex];
  if (cl) {
    cl.points.forEach((pt, i) => addCenterLinePointMarker(pt, clIndex, i));
  }
}

function renderCenterLines() {
  clearCenterLines();
  clearCenterLineMarkers();
  storedCenterLines = [];

  const pairs = findPairs();
  const connPairs = showConnectorCenterLines ? findConnectorPairs() : [];
  const listEl = document.getElementById('center-line-list');
  listEl.innerHTML = '';

  if (pairs.length === 0 && connPairs.length === 0) {
    listEl.innerHTML = '<p class="hint">Draw 2 lane boundaries with the same road name to auto-generate a center line.</p>';
    return;
  }

  const laneCenterLines = [];

  pairs.forEach((pair, idx) => {
    const center = computeCenterLine(pair.a.points, pair.b.points);
    laneCenterLines.push(center);
    const segments = applyCenterLineErasure(center, eraserPoints, eraserRadius);
    const allPoints = segments.flat();

    const sourceId = `pair-${idx}`;
    const clIndex = storedCenterLines.length;
    storedCenterLines.push({ sourceId, name: pair.name, points: allPoints, type: 'lane' });

    addCenterLineLayer(sourceId, allPoints);
    allPoints.forEach((pt, i) => addCenterLinePointMarker(pt, clIndex, i));

    const erasedCount = eraserPoints.filter(ep =>
      center.some(cp => haversineMeters(cp, ep) < (ep.radius || eraserRadius) + 5)
    ).length;

    const item = document.createElement('div');
    item.className = 'center-line-item';
    item.innerHTML = `
      <div class="annotation-dot center"></div>
      <div class="annotation-info">
        <div class="annotation-name">${pair.name}</div>
        <div class="annotation-meta">lane · ${allPoints.length} pts${erasedCount > 0 ? ` · ${erasedCount} eraser(s)` : ''}</div>
      </div>
    `;
    listEl.appendChild(item);
  });

  connPairs.forEach((pair, idx) => {
    const center = computeCenterLine(pair.a.points, pair.b.points);

    if (laneCenterLines.length > 0) {
      const snapFirst = nearestPointOnCenterLines(center[0], laneCenterLines);
      const snapLast = nearestPointOnCenterLines(center[center.length - 1], laneCenterLines);
      if (snapFirst) center[0] = snapFirst;
      if (snapLast) center[center.length - 1] = snapLast;
    }

    const sourceId = `conn-pair-${idx}`;
    const clIndex = storedCenterLines.length;
    storedCenterLines.push({ sourceId, name: pair.name, points: center, type: 'connector' });

    addCenterLineLayer(sourceId, center);
    center.forEach((pt, i) => addCenterLinePointMarker(pt, clIndex, i));

    const item = document.createElement('div');
    item.className = 'center-line-item';
    item.innerHTML = `
      <div class="annotation-dot center"></div>
      <div class="annotation-info">
        <div class="annotation-name">${pair.name}</div>
        <div class="annotation-meta">connector · ${center.length} pts</div>
      </div>
    `;
    listEl.appendChild(item);
  });
}

// --- Live GPS ---

function initGpsMarker() {
  const el = document.createElement('div');
  el.className = 'gps-dot';
  el.style.background = FIX_COLORS[0];
  gpsMarker = new mapboxgl.Marker({ element: el })
    .setLngLat([-122.1697, 37.4275])
    .addTo(map);
}

function initGpsTrailSource() {
  map.addSource('gps-trail', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addLayer({
    id: 'gps-trail-layer',
    type: 'line',
    source: 'gps-trail',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 3,
      'line-opacity': 0.8
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' }
  });
}

function updateGpsTrailOnMap() {
  if (!map.getSource('gps-trail')) return;
  const features = [];
  for (let i = 1; i < gpsTrail.length; i++) {
    const prev = gpsTrail[i - 1];
    const curr = gpsTrail[i];
    features.push({
      type: 'Feature',
      properties: { color: FIX_COLORS[curr.fix_code] || FIX_COLORS[0] },
      geometry: {
        type: 'LineString',
        coordinates: [[prev.lon, prev.lat], [curr.lon, curr.lat]]
      }
    });
  }
  map.getSource('gps-trail').setData({ type: 'FeatureCollection', features });
}

function onGpsPosition(data) {
  gpsHzCounter++;
  gpsPointCount++;
  document.getElementById('gps-point-count').textContent = `${gpsPointCount} points collected`;

  gpsTrail.push(data);
  if (gpsTrail.length > GPS_TRAIL_MAX) {
    gpsTrail = gpsTrail.slice(-GPS_TRAIL_MAX);
  }

  if (gpsMarker) {
    gpsMarker.setLngLat([data.lon, data.lat]);
    gpsMarker.getElement().style.background = FIX_COLORS[data.fix_code] || FIX_COLORS[0];
  }

  if (gpsFollowing && map) {
    map.easeTo({ center: [data.lon, data.lat], duration: 80 });
  }

  updateGpsTrailOnMap();
  updateGpsPanel(data);
}

function updateGpsPanel(d) {
  const badge = document.getElementById('gps-fix-badge');
  badge.textContent = d.fix;
  badge.className = 'fix-badge';
  if (d.fix_code === 4) badge.classList.add('rtk-fix');
  else if (d.fix_code === 5) badge.classList.add('rtk-float');
  else if (d.fix_code === 2) badge.classList.add('dgps');
  else if (d.fix_code >= 1) badge.classList.add('gps');

  document.getElementById('gps-lat').textContent = d.lat.toFixed(8);
  document.getElementById('gps-lon').textContent = d.lon.toFixed(8);
  document.getElementById('gps-sats').textContent = d.sats;
  document.getElementById('gps-hdop').textContent = d.hdop.toFixed(2);
  document.getElementById('gps-alt').textContent = d.alt.toFixed(1) + 'm';
  document.getElementById('gps-hz').textContent = gpsHzValue > 0 ? `${gpsHzValue} Hz` : '';
}

function connectGpsWebSocket() {
  const statusEl = document.getElementById('gps-status');

  gpsWs = new WebSocket(GPS_WS_URL);

  gpsWs.onopen = () => {
    statusEl.classList.remove('disconnected');
    setStatus('GPS connected.');

    gpsHzInterval = setInterval(() => {
      gpsHzValue = gpsHzCounter;
      gpsHzCounter = 0;
      const hzEl = document.getElementById('gps-hz');
      if (hzEl) hzEl.textContent = gpsHzValue > 0 ? `${gpsHzValue} Hz` : '';
    }, 1000);
  };

  gpsWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'position') {
      onGpsPosition(msg.data);
    } else if (msg.type === 'history') {
      for (const pt of msg.data) {
        gpsTrail.push(pt);
      }
      gpsPointCount = msg.data.length;
      document.getElementById('gps-point-count').textContent = `${gpsPointCount} points collected`;
      if (gpsTrail.length > GPS_TRAIL_MAX) {
        gpsTrail = gpsTrail.slice(-GPS_TRAIL_MAX);
      }
      updateGpsTrailOnMap();
      if (gpsTrail.length > 0) {
        const last = gpsTrail[gpsTrail.length - 1];
        if (gpsMarker) gpsMarker.setLngLat([last.lon, last.lat]);
        updateGpsPanel(last);
        if (gpsFollowing) map.flyTo({ center: [last.lon, last.lat], zoom: 19 });
      }
    } else if (msg.type === 'saved') {
      setStatus(`Saved ${msg.count} GPS points to ${msg.path.split('/').pop()}`);
    } else if (msg.type === 'cleared') {
      gpsTrail = [];
      gpsPointCount = 0;
      document.getElementById('gps-point-count').textContent = '0 points collected';
      updateGpsTrailOnMap();
      setStatus('GPS points cleared.');
    }
  };

  gpsWs.onclose = () => {
    statusEl.classList.add('disconnected');
    clearInterval(gpsHzInterval);
    gpsHzValue = 0;
    document.getElementById('gps-hz').textContent = '';
    document.getElementById('gps-fix-badge').textContent = 'OFFLINE';
    document.getElementById('gps-fix-badge').className = 'fix-badge';
    setTimeout(connectGpsWebSocket, 2000);
  };

  gpsWs.onerror = () => {
    gpsWs.close();
  };
}

function clearGpsTrail() {
  gpsTrail = [];
  updateGpsTrailOnMap();
  setStatus('GPS trail cleared.');
}

// --- Map ---

async function initMap() {
  const config = await fetch('/api/config').then(r => r.json());
  MAPBOX_TOKEN = config.mapboxToken;
  mapboxgl.accessToken = MAPBOX_TOKEN;

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/satellite-v9',
    center: [-122.1697, 37.4275],
    zoom: 16,
    maxZoom: 22
  });

  map.addControl(new mapboxgl.NavigationControl(), 'top-right');
  map.addControl(new mapboxgl.ScaleControl(), 'bottom-right');

  map.on('load', () => {
    map.on('click', onMapClick);
    initGpsMarker();
    initGpsTrailSource();
    connectGpsWebSocket();
    loadAnnotations().then(() => {
      if (annotations.length === 0) {
        setStatus('Connecting to GPS...');
      }
    });
  });

  map.on('dragstart', () => {
    gpsFollowing = false;
    document.getElementById('btn-follow').classList.remove('active');
  });
}

function onMapClick(e) {
  const point = { lat: e.lngLat.lat, lng: e.lngLat.lng };

  if (currentMode === 'eraser') {
    const ep = { id: `eraser-${Date.now()}`, lat: point.lat, lng: point.lng, radius: eraserRadius };
    eraserPoints.push(ep);
    addEraserMarker(ep);
    renderCenterLines();
    scheduleAutoSave();
    setStatus(`Placed eraser (${eraserRadius}m radius). ${eraserPoints.length} total.`);
    return;
  }

  if (currentMode === 'connector') {
    if (!activeConnectorId) {
      setStatus('Click "New Connector" first.');
      return;
    }
    const conn = connectors.find(c => c.id === activeConnectorId);
    if (!conn) return;

    const snapped = snapToLanePoint(e.lngLat);
    const addedPoint = snapped || point;
    conn.points.push(addedPoint);
    addConnectorMarker(addedPoint, conn.points.length - 1, conn.id, !!snapped);
    updateConnectorLine(conn);
    updateConnectorList();
    renderCenterLines();
    scheduleAutoSave();
    setStatus(snapped
      ? `Snapped to lane point (${conn.points.length} pts)`
      : `Added free point (${conn.points.length} pts) — no nearby lane point to snap to`);
    return;
  }

  if (!activeAnnotationId) {
    setStatus('Click "New Line" first to start a new annotation.');
    return;
  }

  const annotation = annotations.find(a => a.id === activeAnnotationId);
  if (!annotation) return;

  annotation.points.push(point);
  addPointMarker(point, annotation.points.length - 1, annotation.id);
  updateLine(annotation);
  renderCenterLines();
  updateAnnotationList();
  scheduleAutoSave();
  setStatus(`Added point ${annotation.points.length} to "${annotation.name}"`);
}

// --- Point markers ---

function addPointMarker(point, index, annotationId) {
  const el = document.createElement('div');
  el.style.width = '12px';
  el.style.height = '12px';
  el.style.borderRadius = '50%';
  el.style.background = COLORS.lane;
  el.style.border = '2px solid white';
  el.style.cursor = 'pointer';
  el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.5)';

  const marker = new mapboxgl.Marker({ element: el, draggable: true })
    .setLngLat([point.lng, point.lat])
    .addTo(map);

  marker._annotationId = annotationId;
  marker._pointIndex = index;

  marker.on('dragend', () => {
    const lngLat = marker.getLngLat();
    const ann = annotations.find(a => a.id === annotationId);
    if (ann && ann.points[marker._pointIndex]) {
      ann.points[marker._pointIndex] = { lat: lngLat.lat, lng: lngLat.lng };
      updateLine(ann);
      renderCenterLines();
      scheduleAutoSave();
    }
  });

  pointMarkers.push(marker);
}

// --- Eraser markers ---

function addEraserMarker(ep) {
  const el = document.createElement('div');
  el.style.width = '18px';
  el.style.height = '18px';
  el.style.borderRadius = '50%';
  el.style.background = 'rgba(255, 136, 0, 0.6)';
  el.style.border = '2px solid #ff8800';
  el.style.cursor = 'pointer';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.fontSize = '11px';
  el.style.fontWeight = 'bold';
  el.style.color = 'white';
  el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.5)';
  el.textContent = '×';
  el.title = `Eraser (${ep.radius}m) — click to delete`;

  const marker = new mapboxgl.Marker({ element: el, draggable: true })
    .setLngLat([ep.lng, ep.lat])
    .addTo(map);

  marker._eraserId = ep.id;

  el.addEventListener('click', (e) => {
    if (currentMode !== 'eraser') return;
    e.stopPropagation();
    deleteEraserPoint(ep.id);
  });

  marker.on('dragend', () => {
    const lngLat = marker.getLngLat();
    const point = eraserPoints.find(p => p.id === ep.id);
    if (point) {
      point.lat = lngLat.lat;
      point.lng = lngLat.lng;
      renderCenterLines();
      scheduleAutoSave();
    }
  });

  eraserMarkers.push(marker);
}

function deleteEraserPoint(id) {
  eraserPoints = eraserPoints.filter(p => p.id !== id);
  eraserMarkers = eraserMarkers.filter(m => {
    if (m._eraserId === id) {
      m.remove();
      return false;
    }
    return true;
  });
  renderCenterLines();
  scheduleAutoSave();
  setStatus(`Deleted eraser. ${eraserPoints.length} remaining.`);
}

function clearAllErasers() {
  eraserMarkers.forEach(m => m.remove());
  eraserMarkers = [];
  eraserPoints = [];
  renderCenterLines();
  scheduleAutoSave();
  setStatus('Cleared all erasers.');
}

// --- Connector markers ---

function addConnectorMarker(point, index, connectorId, snapped) {
  const el = document.createElement('div');
  el.style.width = snapped ? '14px' : '10px';
  el.style.height = snapped ? '14px' : '10px';
  el.style.borderRadius = '2px';
  el.style.background = COLORS.connector;
  el.style.border = '2px solid white';
  el.style.cursor = 'pointer';
  el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.5)';
  if (snapped) el.style.transform = 'rotate(45deg)';

  const marker = new mapboxgl.Marker({ element: el, draggable: true })
    .setLngLat([point.lng, point.lat])
    .addTo(map);

  marker._connectorId = connectorId;
  marker._pointIndex = index;

  marker.on('dragend', () => {
    const lngLat = marker.getLngLat();
    const snappedPt = snapToLanePoint(lngLat);
    const finalPt = snappedPt || { lat: lngLat.lat, lng: lngLat.lng };
    const conn = connectors.find(c => c.id === connectorId);
    if (conn && conn.points[marker._pointIndex]) {
      conn.points[marker._pointIndex] = finalPt;
      marker.setLngLat([finalPt.lng, finalPt.lat]);
      el.style.width = snappedPt ? '14px' : '10px';
      el.style.height = snappedPt ? '14px' : '10px';
      el.style.transform = snappedPt ? 'rotate(45deg)' : '';
      updateConnectorLine(conn);
      renderCenterLines();
      scheduleAutoSave();
    }
  });

  connectorMarkers.push(marker);
}

function clearConnectorMarkers(connectorId) {
  connectorMarkers = connectorMarkers.filter(m => {
    if (m._connectorId === connectorId) {
      m.remove();
      return false;
    }
    return true;
  });
}

function updateConnectorLine(conn) {
  const sourceId = `connector-${conn.id}`;

  if (conn.points.length < 2) {
    if (map.getSource(sourceId)) {
      map.getSource(sourceId).setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [] }
      });
    }
    return;
  }

  const coordinates = conn.points.map(p => [p.lng, p.lat]);
  const geojson = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates }
  };

  if (map.getSource(sourceId)) {
    map.getSource(sourceId).setData(geojson);
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: `layer-connector-${conn.id}`,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': COLORS.connector,
        'line-width': 3,
        'line-dasharray': [6, 4],
        'line-opacity': 0.9
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }
}

function removeConnectorFromMap(connectorId) {
  const layerId = `layer-connector-${connectorId}`;
  const sourceId = `connector-${connectorId}`;
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

// --- Line rendering ---

function updateLine(annotation) {
  const sourceId = `line-${annotation.id}`;

  if (annotation.points.length < 2) {
    if (map.getSource(sourceId)) {
      map.getSource(sourceId).setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [] }
      });
    }
    return;
  }

  const coordinates = annotation.points.map(p => [p.lng, p.lat]);
  const geojson = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates }
  };

  if (map.getSource(sourceId)) {
    map.getSource(sourceId).setData(geojson);
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: `layer-${annotation.id}`,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': COLORS.lane,
        'line-width': 4,
        'line-opacity': 0.9
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }
}

function removeLineFromMap(annotationId) {
  const layerId = `layer-${annotationId}`;
  const sourceId = `line-${annotationId}`;
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

// --- Marker management ---

function clearAllMarkers() {
  pointMarkers.forEach(m => m.remove());
  pointMarkers = [];
}

function clearMarkersForAnnotation(annotationId) {
  pointMarkers = pointMarkers.filter(m => {
    if (m._annotationId === annotationId) {
      m.remove();
      return false;
    }
    return true;
  });
}

function rebuildAllVisuals() {
  clearAllMarkers();
  connectorMarkers.forEach(m => m.remove());
  connectorMarkers = [];
  eraserMarkers.forEach(m => m.remove());
  eraserMarkers = [];

  annotations.forEach(ann => {
    ann.points.forEach((pt, i) => addPointMarker(pt, i, ann.id));
    updateLine(ann);
  });

  connectors.forEach(conn => {
    conn.points.forEach((pt, i) => addConnectorMarker(pt, i, conn.id, true));
    updateConnectorLine(conn);
  });

  eraserPoints.forEach(ep => addEraserMarker(ep));
  renderCenterLines();
}

// --- CRUD ---

function newLine() {
  if (currentMode === 'eraser') {
    setStatus('Switch to Lane mode to create a new line.');
    return;
  }

  const nameInput = document.getElementById('line-name');
  lineCounter++;
  const roadName = nameInput.value.trim() || `Road ${lineCounter}`;

  const annotation = {
    id: `ann-${Date.now()}-${lineCounter}`,
    name: roadName,
    type: 'lane',
    points: []
  };

  annotations.push(annotation);
  activeAnnotationId = annotation.id;
  updateAnnotationList();
  setStatus(`Started "${roadName}". Click on the map to add points.`);
}

function finishLine() {
  if (!activeAnnotationId) {
    setStatus('No active line to finish.');
    return;
  }
  const ann = annotations.find(a => a.id === activeAnnotationId);
  const name = ann ? ann.name : '';
  activeAnnotationId = null;
  updateAnnotationList();
  renderCenterLines();
  scheduleAutoSave();
  setStatus(`Finished "${name}". Click "New Line" to start another.`);
}

function undoPoint() {
  if (!activeAnnotationId) {
    setStatus('No active line selected.');
    return;
  }
  const annotation = annotations.find(a => a.id === activeAnnotationId);
  if (!annotation || annotation.points.length === 0) {
    setStatus('No points to undo.');
    return;
  }

  annotation.points.pop();
  clearMarkersForAnnotation(annotation.id);
  annotation.points.forEach((pt, i) => addPointMarker(pt, i, annotation.id));
  updateLine(annotation);
  renderCenterLines();
  updateAnnotationList();
  scheduleAutoSave();
  setStatus(`Removed last point. ${annotation.points.length} remaining.`);
}

function undoEraser() {
  if (eraserPoints.length === 0) {
    setStatus('No erasers to undo.');
    return;
  }
  const last = eraserPoints[eraserPoints.length - 1];
  deleteEraserPoint(last.id);
}

// --- Connector CRUD ---

function newConnector() {
  const nameInput = document.getElementById('connector-name');
  connectorCounter++;
  const name = nameInput.value.trim() || `Connector ${connectorCounter}`;

  const conn = {
    id: `conn-${Date.now()}-${connectorCounter}`,
    name,
    type: 'connector',
    points: []
  };

  connectors.push(conn);
  activeConnectorId = conn.id;
  updateConnectorList();
  setStatus(`Started connector "${name}". Click near lane points to snap.`);
}

function finishConnector() {
  if (!activeConnectorId) {
    setStatus('No active connector to finish.');
    return;
  }
  const conn = connectors.find(c => c.id === activeConnectorId);
  activeConnectorId = null;
  updateConnectorList();
  renderCenterLines();
  scheduleAutoSave();
  setStatus(`Finished connector "${conn ? conn.name : ''}".`);
}

function undoConnectorPoint() {
  if (!activeConnectorId) {
    setStatus('No active connector selected.');
    return;
  }
  const conn = connectors.find(c => c.id === activeConnectorId);
  if (!conn || conn.points.length === 0) {
    setStatus('No points to undo.');
    return;
  }
  conn.points.pop();
  clearConnectorMarkers(conn.id);
  conn.points.forEach((pt, i) => addConnectorMarker(pt, i, conn.id, true));
  updateConnectorLine(conn);
  updateConnectorList();
  renderCenterLines();
  scheduleAutoSave();
  setStatus(`Removed last connector point. ${conn.points.length} remaining.`);
}

function deleteConnector(id) {
  const idx = connectors.findIndex(c => c.id === id);
  if (idx === -1) return;
  const name = connectors[idx].name;
  clearConnectorMarkers(id);
  removeConnectorFromMap(id);
  connectors.splice(idx, 1);
  if (activeConnectorId === id) activeConnectorId = null;
  updateConnectorList();
  renderCenterLines();
  scheduleAutoSave();
  setStatus(`Deleted connector "${name}".`);
}

function selectConnector(id) {
  activeConnectorId = id;
  activeAnnotationId = null;
  currentMode = 'connector';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-mode="connector"]').classList.add('active');
  toggleModeUI();
  const conn = connectors.find(c => c.id === id);
  if (conn) {
    document.getElementById('connector-name').value = conn.name;
    setStatus(`Selected connector "${conn.name}" for editing.`);
  }
  updateConnectorList();
  updateAnnotationList();
}

function updateConnectorList() {
  const list = document.getElementById('connector-list');
  const count = document.getElementById('connector-count');
  count.textContent = connectors.length;

  list.innerHTML = '';
  if (connectors.length === 0) {
    list.innerHTML = '<p class="hint">Use Connector mode to draw connections between lanes.</p>';
    return;
  }
  connectors.forEach(conn => {
    const item = document.createElement('div');
    item.className = `annotation-item${conn.id === activeConnectorId ? ' selected' : ''}`;
    item.innerHTML = `
      <div class="annotation-dot connector"></div>
      <div class="annotation-info" title="${conn.name}">
        <div class="annotation-name">${conn.name}</div>
        <div class="annotation-meta">${conn.points.length} pts</div>
      </div>
      <button class="annotation-delete-btn" title="Delete">&times;</button>
    `;
    item.querySelector('.annotation-info').addEventListener('click', () => selectConnector(conn.id));
    item.querySelector('.annotation-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConnector(conn.id);
    });
    list.appendChild(item);
  });
}

function deleteAnnotation(id) {
  const idx = annotations.findIndex(a => a.id === id);
  if (idx === -1) return;

  const name = annotations[idx].name;
  clearMarkersForAnnotation(id);
  removeLineFromMap(id);
  annotations.splice(idx, 1);

  if (activeAnnotationId === id) activeAnnotationId = null;

  updateAnnotationList();
  renderCenterLines();
  scheduleAutoSave();
  setStatus(`Deleted "${name}".`);
}

function selectAnnotation(id) {
  activeAnnotationId = id;
  activeConnectorId = null;
  const ann = annotations.find(a => a.id === id);
  if (ann) {
    currentMode = 'lane';
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-mode="lane"]').classList.add('active');
    toggleModeUI();
    document.getElementById('line-name').value = ann.name;
    setStatus(`Selected "${ann.name}" for editing. Click to add more points.`);
  }
  updateAnnotationList();
  updateConnectorList();
}

function updateAnnotationList() {
  const list = document.getElementById('annotation-list');
  const count = document.getElementById('annotation-count');
  count.textContent = annotations.length;

  list.innerHTML = '';
  annotations.forEach(ann => {
    const item = document.createElement('div');
    item.className = `annotation-item${ann.id === activeAnnotationId ? ' selected' : ''}`;

    item.innerHTML = `
      <div class="annotation-dot lane"></div>
      <div class="annotation-info" title="${ann.name}">
        <div class="annotation-name">${ann.name}</div>
        <div class="annotation-meta">${ann.points.length} pts</div>
      </div>
      <button class="annotation-delete-btn" title="Delete">&times;</button>
    `;

    item.querySelector('.annotation-info').addEventListener('click', () => selectAnnotation(ann.id));
    item.querySelector('.annotation-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAnnotation(ann.id);
    });

    list.appendChild(item);
  });
}

// --- Save / Load ---

async function saveAnnotations() {
  const data = {
    annotations: annotations.map(ann => ({
      id: ann.id,
      name: ann.name,
      type: ann.type,
      points: ann.points.map(p => ({ lat: p.lat, lng: p.lng }))
    })),
    connectors: connectors.map(conn => ({
      id: conn.id,
      name: conn.name,
      type: conn.type,
      points: conn.points.map(p => ({ lat: p.lat, lng: p.lng }))
    })),
    eraserPoints: eraserPoints.map(ep => ({
      id: ep.id,
      lat: ep.lat,
      lng: ep.lng,
      radius: ep.radius
    })),
    metadata: {
      savedAt: new Date().toISOString(),
      campus: 'Stanford University',
      project: 'FollowRTK Self-Driving Golf Cart'
    }
  };

  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json();
    if (result.success) {
      setStatus(`Saved ${result.count} lane(s), ${connectors.length} connector(s), ${eraserPoints.length} eraser(s)`);
    } else {
      setStatus(`Save failed: ${result.error}`);
    }
  } catch (err) {
    setStatus(`Save error: ${err.message}`);
  }
}

async function loadAnnotations() {
  try {
    const res = await fetch('/api/load');
    const data = await res.json();

    annotations.forEach(ann => {
      clearMarkersForAnnotation(ann.id);
      removeLineFromMap(ann.id);
    });
    connectors.forEach(conn => {
      clearConnectorMarkers(conn.id);
      removeConnectorFromMap(conn.id);
    });
    clearCenterLines();
    clearCenterLineMarkers();
    eraserMarkers.forEach(m => m.remove());
    eraserMarkers = [];

    annotations = data.annotations || [];
    connectors = data.connectors || [];
    eraserPoints = data.eraserPoints || [];
    activeAnnotationId = null;
    activeConnectorId = null;

    rebuildAllVisuals();
    updateAnnotationList();
    updateConnectorList();
    setStatus(`Loaded ${annotations.length} lane(s), ${connectors.length} connector(s), ${eraserPoints.length} eraser(s)`);
  } catch (err) {
    setStatus(`Load error: ${err.message}`);
  }
}

// --- UI ---

function toggleModeUI() {
  const laneControls = document.getElementById('lane-controls');
  const connectorControls = document.getElementById('connector-controls');
  const eraserControls = document.getElementById('eraser-controls');
  laneControls.classList.add('hidden');
  connectorControls.classList.add('hidden');
  eraserControls.classList.add('hidden');

  if (currentMode === 'lane') laneControls.classList.remove('hidden');
  else if (currentMode === 'connector') connectorControls.classList.remove('hidden');
  else if (currentMode === 'eraser') eraserControls.classList.remove('hidden');
}

function setStatus(msg) {
  document.getElementById('status-bar').textContent = msg;
}

// --- Event listeners ---

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    toggleModeUI();
    if (currentMode === 'eraser') {
      activeAnnotationId = null;
      activeConnectorId = null;
      updateAnnotationList();
      updateConnectorList();
      setStatus('Eraser mode: click near a center line to erase a section.');
    } else if (currentMode === 'connector') {
      activeAnnotationId = null;
      updateAnnotationList();
      setStatus('Connector mode: click "New Connector" then click near lane points to snap.');
    } else {
      activeConnectorId = null;
      updateConnectorList();
      setStatus('Lane mode: click "New Line" to start drawing a lane boundary.');
    }
  });
});

document.getElementById('chk-connector-centers').addEventListener('change', (e) => {
  showConnectorCenterLines = e.target.checked;
  renderCenterLines();
});

document.getElementById('eraser-radius').addEventListener('input', (e) => {
  eraserRadius = parseInt(e.target.value);
  document.getElementById('eraser-radius-val').textContent = `${eraserRadius}m`;
});

document.getElementById('line-name').addEventListener('input', (e) => {
  if (!activeAnnotationId) return;
  const ann = annotations.find(a => a.id === activeAnnotationId);
  if (ann) {
    ann.name = e.target.value.trim() || ann.name;
    updateAnnotationList();
    renderCenterLines();
    scheduleAutoSave();
  }
});

document.getElementById('connector-name').addEventListener('input', (e) => {
  if (!activeConnectorId) return;
  const conn = connectors.find(c => c.id === activeConnectorId);
  if (conn) {
    conn.name = e.target.value.trim() || conn.name;
    updateConnectorList();
    scheduleAutoSave();
  }
});

document.getElementById('btn-new').addEventListener('click', newLine);
document.getElementById('btn-finish').addEventListener('click', finishLine);
document.getElementById('btn-undo').addEventListener('click', undoPoint);
document.getElementById('btn-delete').addEventListener('click', () => {
  if (activeAnnotationId) {
    deleteAnnotation(activeAnnotationId);
  } else {
    setStatus('No line selected to delete.');
  }
});
document.getElementById('btn-new-connector').addEventListener('click', newConnector);
document.getElementById('btn-finish-connector').addEventListener('click', finishConnector);
document.getElementById('btn-undo-connector').addEventListener('click', undoConnectorPoint);
document.getElementById('btn-delete-connector').addEventListener('click', () => {
  if (activeConnectorId) {
    deleteConnector(activeConnectorId);
  } else {
    setStatus('No connector selected to delete.');
  }
});
document.getElementById('btn-undo-eraser').addEventListener('click', undoEraser);
document.getElementById('btn-clear-erasers').addEventListener('click', clearAllErasers);
document.getElementById('btn-save').addEventListener('click', saveAnnotations);
document.getElementById('btn-load').addEventListener('click', loadAnnotations);

document.getElementById('btn-save-gps').addEventListener('click', () => {
  if (gpsWs && gpsWs.readyState === WebSocket.OPEN) {
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    gpsWs.send(JSON.stringify({ type: 'save', filename: `lane_points_${ts}.json` }));
  } else {
    setStatus('GPS not connected.');
  }
});

document.getElementById('btn-clear-gps').addEventListener('click', () => {
  if (gpsWs && gpsWs.readyState === WebSocket.OPEN) {
    gpsWs.send(JSON.stringify({ type: 'clear' }));
  }
});

document.getElementById('btn-follow').addEventListener('click', () => {
  gpsFollowing = !gpsFollowing;
  document.getElementById('btn-follow').classList.toggle('active', gpsFollowing);
  if (gpsFollowing && gpsTrail.length > 0) {
    const last = gpsTrail[gpsTrail.length - 1];
    map.flyTo({ center: [last.lon, last.lat], zoom: 19 });
  }
  setStatus(gpsFollowing ? 'Following GPS. Drag map to stop.' : 'GPS follow off.');
});

document.getElementById('btn-clear-trail').addEventListener('click', clearGpsTrail);

initMap();

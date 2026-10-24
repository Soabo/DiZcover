/* DiZcover – Fog-of-War-Karte (PWA, Version 0.1)
 *
 * Datenmodell (localStorage "dizcover.v1"):
 *   { area: [[lat,lng], ...] | null,   // das verschleierte Polygon
 *     points: [[lat,lng], ...] }       // Positionen, an denen aufgedeckt wurde
 *
 * Fortschritt: Das Polygon wird in ein metrisches Raster (ca. 3–10 m Zellen) zerlegt.
 * Jede Zelle innerhalb von 15 m um einen GPS-Punkt gilt als aufgedeckt.
 * Prozent = aufgedeckte Zellen im Polygon / alle Zellen im Polygon.
 */
(() => {
  'use strict';

  const STORE_KEY = 'dizcover.v1';
  const REVEAL_RADIUS_M = 15;   // Aufdeck-Radius
  const MIN_STEP_M = 5;         // neuen Punkt erst nach 5 m Bewegung speichern
  const MAX_ACCURACY_M = 40;    // ungenauere GPS-Fixes ignorieren
  const START_BOX_M = 1000;     // Start-Ausschnitt ca. 1 km × 1 km
  const MAX_GRID_CELLS = 1_500_000;
  const SOUL_COUNT = 8;
  const PICKUP_M = 5;           // Seele aufnehmen: höchstens 5 m entfernt
  const GRAVE_M = 10;           // Seelen abgeben: höchstens 10 m vom Friedhof

  const sim = new URLSearchParams(location.search).has('sim');

  // ---------- Zustand ----------
  let state = load();
  let grid = state.area ? buildGrid(state.area) : null;
  const pointKeys = new Set();
  let lastPos = null;          // L.LatLng
  let firstFix = true;
  let drawing = null;          // Array<L.LatLng> während des Zeichnens
  let drawClosed = false;

  if (grid) for (const p of state.points) applyPoint(p[0], p[1], false);

  // ---------- Karte ----------
  const map = L.map('map', {
    zoomControl: false,
    zoomAnimation: false,      // Nebel-Overlay bleibt beim Zoomen exakt deckungsgleich
    worldCopyJump: true,
    minZoom: 2
  }).setView([25, 10], 2);   // Start: ganze Welt

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  const accuracyCircle = L.circle([0, 0], { radius: 1, color: '#a3201c', weight: 1, opacity: 0.6, fillOpacity: 0.08, interactive: false });
  const meMarker = L.circleMarker([0, 0], { radius: 8, color: '#efe3c8', weight: 3, fillColor: '#a3201c', fillOpacity: 1, interactive: false });
  const drawLayer = L.layerGroup().addTo(map);

  // ---------- Nebel-Canvas ----------
  const fog = document.getElementById('fog');
  const ctx = fog.getContext('2d');
  const mask = document.createElement('canvas');
  const mctx = mask.getContext('2d');
  const fogTile = makeFogTile(256);
  const fogPattern = ctx.createPattern(fogTile, 'repeat');
  let fogQueued = false;

  function queueFog() {
    if (fogQueued) return;
    fogQueued = true;
    requestAnimationFrame(() => { fogQueued = false; drawFog(); renderPOIs(); });
  }

  function drawFog() {
    const dpr = window.devicePixelRatio || 1;
    const size = map.getSize();
    const W = Math.round(size.x * dpr), H = Math.round(size.y * dpr);
    if (fog.width !== W || fog.height !== H) {
      fog.width = W; fog.height = H; mask.width = W; mask.height = H;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!state.area) return;

    // 1) Polygon mit Nebel füllen
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    state.area.forEach((p, i) => {
      const pt = map.latLngToContainerPoint(p);
      i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y);
    });
    ctx.closePath();
    // Muster mit der Karte mitwandern lassen
    const tl = map.containerPointToLayerPoint([0, 0]).add(map.getPixelOrigin());
    if (fogPattern.setTransform) {
      fogPattern.setTransform(new DOMMatrix().translate(-mod(tl.x, 256), -mod(tl.y, 256)));
    }
    ctx.fillStyle = fogPattern;
    ctx.fill('evenodd');
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(163,32,28,0.85)';
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2) Aufgedeckte Kreise herausschneiden
    if (!state.points.length) return;
    const rPx = REVEAL_RADIUS_M / metersPerPixel(map.getCenter().lat, map.getZoom());
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.clearRect(0, 0, W, H);
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.fillStyle = '#fff';
    mctx.beginPath();
    const pad = rPx + 20;
    for (const p of state.points) {
      const pt = map.latLngToContainerPoint(p);
      if (pt.x < -pad || pt.y < -pad || pt.x > size.x + pad || pt.y > size.y + pad) continue;
      mctx.moveTo(pt.x + rPx, pt.y);
      mctx.arc(pt.x, pt.y, rPx, 0, Math.PI * 2);
    }
    mctx.fill();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    const blur = Math.min(14, Math.max(1.5, rPx * 0.22)) * dpr;
    if ('filter' in ctx) ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(mask, 0, 0);
    if ('filter' in ctx) ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
  }

  map.on('move zoom viewreset resize', queueFog);
  window.addEventListener('resize', queueFog);

  // ---------- GPS ----------
  const statusEl = document.getElementById('status');

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.classList.toggle('ok', !!ok);
  }

  function onPosition(lat, lng, acc) {
    const ll = L.latLng(lat, lng);
    lastPos = ll;
    meMarker.setLatLng(ll).addTo(map);
    accuracyCircle.setLatLng(ll).setRadius(acc || 5).addTo(map);
    setStatus('', true);

    if (firstFix) {
      firstFix = false;
      map.flyToBounds(ll.toBounds(START_BOX_M), { duration: 2.2 });
    }
    checkProximity();
    if (acc && acc > MAX_ACCURACY_M) {
      setStatus(`GPS ungenau (±${Math.round(acc)} m) – noch kein Aufdecken`, false);
      return;
    }
    if (grid && applyPoint(lat, lng, true)) {
      save();
      updateProgress();
      queueFog();
    }
  }

  if (sim) {
    document.getElementById('simBanner').hidden = false;
    setStatus('Testmodus aktiv', false);
  } else if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
      pos => onPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      err => setStatus(err.code === 1 ? 'Standortzugriff verweigert – bitte in den Einstellungen erlauben' : 'Kein GPS-Signal', false),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  } else {
    setStatus('Dieses Gerät liefert keinen Standort', false);
  }

  document.getElementById('btnLocate').addEventListener('click', () => {
    if (lastPos) map.flyTo(lastPos, Math.max(map.getZoom(), 16), { duration: 0.8 });
  });

  // ---------- Verschleiern / Zeichnen ----------
  const el = id => document.getElementById(id);
  const btnVeil = el('btnVeil'), btnOk = el('btnOk'), btnUndo = el('btnUndo');

  btnVeil.addEventListener('click', () => {
    if (state.area && !window.confirm('Neues Gebiet zeichnen? Das bisherige Gebiet, sein Fortschritt und eine laufende Seelenrunde werden verworfen.')) return;
    startDrawing();
  });
  el('btnCancel').addEventListener('click', stopDrawing);
  btnUndo.addEventListener('click', () => {
    if (!drawing) return;
    if (drawClosed) drawClosed = false; else drawing.pop();
    renderDrawing();
  });
  btnOk.addEventListener('click', () => {
    if (!drawing || drawing.length < 3) return;
    const poly = drawing.map(p => [round6(p.lat), round6(p.lng)]);
    state = { area: poly, points: [], game: null };
    clearPOIs();
    pointKeys.clear();
    grid = buildGrid(poly);
    if (lastPos) applyPoint(lastPos.lat, lastPos.lng, true); // Standort sofort aufdecken
    save();
    stopDrawing();
    updateProgress();
    queueFog();
    askSoulRound();
  });

  function startDrawing() {
    drawing = [];
    drawClosed = false;
    map.doubleClickZoom.disable();
    el('dockMain').hidden = true;
    el('dockDraw').hidden = false;
    el('drawHint').hidden = false;
    el('progress').hidden = true;
    fog.style.opacity = '0.25';
    renderDrawing();
  }

  function stopDrawing() {
    drawing = null;
    drawLayer.clearLayers();
    map.doubleClickZoom.enable();
    el('dockMain').hidden = false;
    el('dockDraw').hidden = true;
    el('drawHint').hidden = true;
    fog.style.opacity = '';
    btnVeil.textContent = state.area ? 'Neues Gebiet' : 'Verschleiern';
    updateProgress();
  }

  map.on('click', e => {
    if (drawing) {
      if (drawClosed) return;
      if (drawing.length >= 3) {
        const a = map.latLngToContainerPoint(drawing[0]);
        const b = map.latLngToContainerPoint(e.latlng);
        if (a.distanceTo(b) < 24) { drawClosed = true; renderDrawing(); return; }
      }
      drawing.push(e.latlng);
      renderDrawing();
    } else if (sim) {
      onPosition(e.latlng.lat, e.latlng.lng, 5);
    }
  });

  function renderDrawing() {
    drawLayer.clearLayers();
    if (!drawing) return;
    const style = { color: '#a3201c', weight: 3, interactive: false };
    if (drawing.length >= 2) {
      if (drawClosed) L.polygon(drawing, { ...style, fillOpacity: 0.25, fillColor: '#1a1613' }).addTo(drawLayer);
      else L.polyline(drawing, { ...style, dashArray: '6 6' }).addTo(drawLayer);
    }
    drawing.forEach((p, i) => {
      const first = i === 0 && drawing.length >= 3 && !drawClosed;
      L.circleMarker(p, {
        radius: first ? 11 : 6, color: '#1a1613', weight: 2,
        fillColor: first ? '#efe3c8' : '#a3201c', fillOpacity: 1, interactive: false
      }).addTo(drawLayer);
    });
    btnUndo.disabled = drawing.length === 0;
    btnOk.disabled = drawing.length < 3;
    el('drawHint').textContent = drawClosed
      ? 'Gebiet geschlossen. Mit OK verschleiern.'
      : drawing.length < 3
        ? 'Tippe Eckpunkte auf die Karte (mindestens 3).'
        : 'Weiter tippen, oder auf den ersten Punkt tippen bzw. OK drücken, um zu schließen.';
  }


  // ---------- Seelenrunde ----------
  const poiLayer = document.getElementById('poi');
  let poiEls = [];             // { el, lat, lng, kind, i }
  let action = null;           // 'pickup' | 'deliver' | null
  let actionSoul = -1;
  const btnAction = el('btnAction');

  function distM(lat1, lng1, lat2, lng2) {
    const dx = (lng2 - lng1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    const dy = (lat2 - lat1) * 110540;
    return Math.hypot(dx, dy);
  }

  function askSoulRound() {
    showModal({
      title: 'Seelenrunde?',
      text: `In deinem Gebiet irren ${SOUL_COUNT} verlorene Seelen umher. Sammle sie alle ein und bring sie zum Seelenfriedhof, damit sie Ruhe finden.`,
      buttons: [
        { label: 'Nur erkunden' },
        { label: 'Seelenrunde starten', primary: true, onClick: startSoulRound }
      ]
    });
  }

  function startSoulRound() {
    const pts = placePoints(SOUL_COUNT + 1);
    if (!pts) {
      showModal({ title: 'Gebiet zu klein', text: 'Für eine Seelenrunde braucht es ein größeres Gebiet.', buttons: [{ label: 'OK', primary: true }] });
      return;
    }
    const [grave, ...souls] = pts;
    state.game = {
      grave: { lat: grave[0], lng: grave[1] },
      souls: souls.map(p => ({ lat: p[0], lng: p[1], taken: false })),
      startedAt: Date.now(), doneAt: null
    };
    save();
    buildPOIs();
    updateProgress();
    checkProximity();
    queueFog();
  }

  // Zufällige, gut verteilte Punkte im Polygon (Abstand zueinander, zum Rand und zum Spieler)
  function placePoints(n) {
    const g = grid;
    if (!g || g.total < n * 4) return null;
    let spacing = Math.max(12, 0.5 * Math.sqrt(g.areaM2 / (n + 1)));
    let edgeMin = Math.min(15, spacing / 3);
    let playerMin = Math.min(40, spacing);
    const me = lastPos ? [(lastPos.lng - g.lng0) * g.kx, (lastPos.lat - g.lat0) * g.ky] : null;

    for (let round = 0; round < 12; round++) {
      const out = [];
      let tries = 0;
      while (out.length < n && tries < 4000) {
        tries++;
        const idx = Math.floor(Math.random() * g.W * g.H);
        if (!g.inside[idx]) continue;
        const i = idx % g.W, j = (idx / g.W) | 0;
        const x = g.minX + (i + Math.random()) * g.cell;
        const y = g.minY + (j + Math.random()) * g.cell;
        if (edgeDist(g.xy, x, y) < edgeMin) continue;
        if (me && Math.hypot(x - me[0], y - me[1]) < playerMin) continue;
        if (out.some(o => Math.hypot(o[0] - x, o[1] - y) < spacing)) continue;
        out.push([x, y]);
      }
      if (out.length === n) return out.map(([x, y]) => [round6(y / g.ky + g.lat0), round6(x / g.kx + g.lng0)]);
      spacing *= 0.8; edgeMin *= 0.8; playerMin *= 0.8;
    }
    return null;
  }

  function edgeDist(xy, x, y) {
    let best = Infinity;
    for (let k = 0, n = xy.length; k < n; k++) {
      const [x1, y1] = xy[k], [x2, y2] = xy[(k + 1) % n];
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
    }
    return best;
  }

  const SOUL_SVG = '<svg viewBox="0 0 40 52" width="34" height="44" aria-hidden="true"><defs><radialGradient id="sg" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#fffdf4"/><stop offset=".55" stop-color="#cfe3df"/><stop offset="1" stop-color="#7fa59f" stop-opacity="0"/></radialGradient></defs><path d="M20 3c9 0 15 7 15 16 0 7-2 11-2 17 0 4 2 7 4 10-4 1-7-1-9-3-1 3-4 5-8 5s-7-2-8-5c-2 2-5 4-9 3 2-3 4-6 4-10 0-6-2-10-2-17C5 10 11 3 20 3z" fill="url(#sg)"/><circle cx="15" cy="19" r="2.4" fill="#1a1613"/><circle cx="25" cy="19" r="2.4" fill="#1a1613"/><ellipse cx="20" cy="27" rx="2.6" ry="3.4" fill="#1a1613" opacity=".8"/></svg>';
  const GRAVE_SVG = '<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><ellipse cx="32" cy="58" rx="26" ry="5" fill="#000" opacity=".35"/><path d="M10 58V30c0-6 5-10 11-10h22c6 0 11 4 11 10v28z" fill="#5d5750" stroke="#2a221c" stroke-width="2"/><path d="M16 58V34c0-4 3-7 7-7h18c4 0 7 3 7 7v24z" fill="#7a736a"/><rect x="29.5" y="6" width="5" height="22" rx="1" fill="#b8924a" stroke="#2a221c" stroke-width="1.5"/><rect x="23" y="11" width="18" height="5" rx="1" fill="#b8924a" stroke="#2a221c" stroke-width="1.5"/><path d="M22 41h20M22 47h20" stroke="#2a221c" stroke-width="2" opacity=".55"/></svg>';

  function clearPOIs() {
    poiLayer.innerHTML = '';
    poiEls = [];
    setAction(null);
  }

  function buildPOIs() {
    clearPOIs();
    const g = state.game;
    if (!g) return;
    const ge = document.createElement('div');
    ge.className = 'poi grave';
    ge.innerHTML = GRAVE_SVG + '<span class="poi-label">Seelenfriedhof</span>';
    poiLayer.appendChild(ge);
    poiEls.push({ el: ge, lat: g.grave.lat, lng: g.grave.lng, kind: 'grave' });
    g.souls.forEach((s, i) => {
      if (s.taken) return;
      const e = document.createElement('div');
      e.className = 'poi soul';
      e.style.animationDelay = (-i * 0.7) + 's';
      e.innerHTML = SOUL_SVG;
      poiLayer.appendChild(e);
      poiEls.push({ el: e, lat: s.lat, lng: s.lng, kind: 'soul', i });
    });
  }

  function isRevealed(lat, lng) {
    const g = grid;
    if (!g) return true;
    const i = Math.floor(((lng - g.lng0) * g.kx - g.minX) / g.cell);
    const j = Math.floor(((lat - g.lat0) * g.ky - g.minY) / g.cell);
    if (i < 0 || j < 0 || i >= g.W || j >= g.H) return true;
    const idx = j * g.W + i;
    return !g.inside[idx] || !!g.revealed[idx];
  }

  function renderPOIs() {
    if (!poiEls.length) return;
    const size = map.getSize();
    const g = state.game;
    for (const p of poiEls) {
      const pt = map.latLngToContainerPoint([p.lat, p.lng]);
      const off = pt.x < -60 || pt.y < -60 || pt.x > size.x + 60 || pt.y > size.y + 60;
      p.el.style.display = off ? 'none' : '';
      if (off) continue;
      p.el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
      p.el.classList.toggle('veiled', !isRevealed(p.lat, p.lng));
      if (p.kind === 'grave') {
        const n = g.souls.filter(s => s.taken).length;
        p.el.classList.toggle('ready', n === SOUL_COUNT && !g.doneAt);
        p.el.classList.toggle('done', !!g.doneAt);
      }
    }
  }

  function checkProximity() {
    const g = state.game;
    if (!g || g.doneAt || !lastPos || drawing) { setAction(null); return; }
    const { lat, lng } = lastPos;
    let best = -1, bestD = Infinity;
    g.souls.forEach((s, i) => {
      if (s.taken) return;
      const d = distM(lat, lng, s.lat, s.lng);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0 && bestD <= PICKUP_M) { actionSoul = best; setAction('pickup'); return; }
    const all = g.souls.every(s => s.taken);
    const dGrave = distM(lat, lng, g.grave.lat, g.grave.lng);
    if (dGrave <= GRAVE_M) {
      if (all) { setAction('deliver'); return; }
      const left = g.souls.filter(s => !s.taken).length;
      setAction(null);
      setStatus(`Am Friedhof – es fehlen noch ${left} Seele${left === 1 ? '' : 'n'}`, false);
      return;
    }
    setAction(null);
  }

  function setAction(kind) {
    action = kind;
    if (!btnAction) return;
    btnAction.hidden = !kind;
    btnVeil.hidden = !!kind;
    if (kind === 'pickup') btnAction.textContent = 'Seele aufnehmen';
    if (kind === 'deliver') btnAction.textContent = 'Seelen abgeben';
    btnAction.classList.toggle('pulse', !!kind);
  }

  btnAction.addEventListener('click', () => {
    const g = state.game;
    if (!g || !lastPos) return;
    if (action === 'pickup') {
      const s = g.souls[actionSoul];
      if (!s || s.taken || distM(lastPos.lat, lastPos.lng, s.lat, s.lng) > PICKUP_M) { checkProximity(); return; }
      s.taken = true;
      save();
      const pe = poiEls.find(p => p.kind === 'soul' && p.i === actionSoul);
      if (pe) {
        pe.el.classList.add('caught');
        setTimeout(() => { pe.el.remove(); poiEls = poiEls.filter(p => p !== pe); }, 700);
      }
      if (navigator.vibrate) navigator.vibrate(60);
      updateProgress();
      const n = g.souls.filter(x => x.taken).length;
      if (n === SOUL_COUNT) {
        showModal({ title: 'Alle Seelen gefunden', text: 'Bring die acht Seelen jetzt zum Seelenfriedhof, damit sie Ruhe finden.', buttons: [{ label: 'Los geht’s', primary: true }] });
      }
      checkProximity();
      queueFog();
    } else if (action === 'deliver') {
      if (!g.souls.every(s => s.taken) || distM(lastPos.lat, lastPos.lng, g.grave.lat, g.grave.lng) > GRAVE_M) { checkProximity(); return; }
      g.doneAt = Date.now();
      save();
      if (navigator.vibrate) navigator.vibrate([80, 60, 160]);
      updateProgress();
      setAction(null);
      queueFog();
      const mins = Math.max(1, Math.round((g.doneAt - g.startedAt) / 60000));
      const dur = mins < 60 ? `${mins} Minute${mins === 1 ? '' : 'n'}` : `${Math.floor(mins / 60)} Std. ${mins % 60} Min.`;
      const pct = grid && grid.total ? (grid.count / grid.total * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '0';
      showModal({
        title: 'Geschafft!',
        text: `Alle ${SOUL_COUNT} Seelen ruhen nun auf dem Friedhof.\nDauer: ${dur} · Aufgedeckt: ${pct} %`,
        buttons: [{ label: 'Weiter erkunden', primary: true }],
        win: true
      });
    }
  });

  // ---------- Dialog ----------
  function showModal({ title, text, buttons, win }) {
    const m = el('modal');
    el('modalTitle').textContent = title;
    el('modalText').textContent = text;
    m.classList.toggle('win', !!win);
    const box = el('modalButtons');
    box.innerHTML = '';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ' + (b.primary ? 'primary' : 'ghost');
      btn.textContent = b.label;
      btn.addEventListener('click', () => { m.hidden = true; if (b.onClick) b.onClick(); });
      box.appendChild(btn);
    }
    m.hidden = false;
    box.lastChild && box.lastChild.focus();
  }

  // ---------- Raster & Fortschritt ----------
  function buildGrid(poly) {
    const lat0 = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const lng0 = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180);
    const ky = 110540;
    const xy = poly.map(p => [(p[1] - lng0) * kx, (p[0] - lat0) * ky]);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of xy) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const bboxArea = (maxX - minX) * (maxY - minY);
    const cell = Math.max(3, Math.sqrt(bboxArea / MAX_GRID_CELLS));
    const W = Math.max(1, Math.ceil((maxX - minX) / cell));
    const H = Math.max(1, Math.ceil((maxY - minY) / cell));
    const inside = new Uint8Array(W * H);
    let total = 0;

    // Scanline-Füllung (even-odd), Zellmittelpunkte
    for (let j = 0; j < H; j++) {
      const y = minY + (j + 0.5) * cell;
      const xs = [];
      for (let k = 0, n = xy.length; k < n; k++) {
        const [x1, y1] = xy[k], [x2, y2] = xy[(k + 1) % n];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const i0 = Math.max(0, Math.ceil((xs[m] - minX) / cell - 0.5));
        const i1 = Math.min(W - 1, Math.floor((xs[m + 1] - minX) / cell - 0.5));
        for (let i = i0; i <= i1; i++) { inside[j * W + i] = 1; total++; }
      }
    }
    return { lat0, lng0, kx, ky, xy, minX, minY, cell, W, H, inside, total, revealed: new Uint8Array(W * H), count: 0, areaM2: total * cell * cell };
  }

  // Deckt das Raster um (lat,lng) auf. Gibt true zurück, wenn ein neuer Punkt gespeichert wurde.
  function applyPoint(lat, lng, store) {
    const g = grid;
    const x = (lng - g.lng0) * g.kx, y = (lat - g.lat0) * g.ky;
    const R = REVEAL_RADIUS_M;
    // Nur Punkte in Reichweite des Gebiets
    if (x < g.minX - R || y < g.minY - R || x > g.minX + g.W * g.cell + R || y > g.minY + g.H * g.cell + R) return false;
    const key = Math.round(x / MIN_STEP_M) + ':' + Math.round(y / MIN_STEP_M);
    if (pointKeys.has(key)) return false;
    pointKeys.add(key);
    if (store) state.points.push([round6(lat), round6(lng)]);

    const i0 = Math.max(0, Math.floor((x - R - g.minX) / g.cell));
    const i1 = Math.min(g.W - 1, Math.floor((x + R - g.minX) / g.cell));
    const j0 = Math.max(0, Math.floor((y - R - g.minY) / g.cell));
    const j1 = Math.min(g.H - 1, Math.floor((y + R - g.minY) / g.cell));
    const R2 = R * R;
    for (let j = j0; j <= j1; j++) {
      const cy = g.minY + (j + 0.5) * g.cell - y;
      for (let i = i0; i <= i1; i++) {
        const idx = j * g.W + i;
        if (!g.inside[idx] || g.revealed[idx]) continue;
        const cx = g.minX + (i + 0.5) * g.cell - x;
        if (cx * cx + cy * cy <= R2) { g.revealed[idx] = 1; g.count++; }
      }
    }
    return true;
  }

  function updateProgress() {
    const box = el('progress');
    if (!grid || drawing) { box.hidden = true; return; }
    box.hidden = false;
    const pct = grid.total ? grid.count / grid.total * 100 : 0;
    el('pct').textContent = pct.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
    el('pctBar').style.width = Math.min(100, pct) + '%';
    const km2 = grid.areaM2 / 1e6;
    el('pctLabel').textContent = 'von ' + (km2 >= 0.1
      ? km2.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' km²'
      : Math.round(grid.areaM2).toLocaleString('de-DE') + ' m²');
    const soulsEl = el('souls');
    const g = state.game;
    soulsEl.hidden = !g;
    if (g) {
      const n = g.souls.filter(x => x.taken).length;
      soulsEl.textContent = g.doneAt ? 'Alle Seelen erlöst'
        : n === SOUL_COUNT ? 'Alle 8 Seelen! Ab zum Friedhof'
        : `Seelen ${n} / ${SOUL_COUNT}`;
      soulsEl.classList.toggle('ready', n === SOUL_COUNT && !g.doneAt);
    }
  }

  // ---------- Hilfsfunktionen ----------
  function metersPerPixel(lat, zoom) {
    return 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom + 8);
  }
  function mod(a, n) { return ((a % n) + n) % n; }
  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  function makeFogTile(s) {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(38,40,38,0.94)';
    g.fillRect(0, 0, s, s);
    // weiche Nebelschwaden, kachelbar (an den Rändern gespiegelt gezeichnet)
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 0; n < 40; n++) {
      const x = rnd() * s, y = rnd() * s, r = 20 + rnd() * 60;
      const light = rnd() > 0.5;
      for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) {
        const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        grd.addColorStop(0, light ? 'rgba(170,175,165,0.12)' : 'rgba(10,10,8,0.16)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
    return c;
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && Array.isArray(s.points)) { s.game = s.game || null; return s; }
    } catch (_) { /* leer */ }
    return { area: null, points: [], game: null };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* Speicher voll/gesperrt */ }
  }

  // Bildschirm wachhalten, solange ein Gebiet aktiv ist (Browser deckt sonst im Hintergrund nicht auf)
  let wakeLock = null;
  async function keepAwake() {
    if (!state.area || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { /* nicht erlaubt */ }
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('click', () => { if (!wakeLock) keepAwake(); }, { once: true });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Start
  btnVeil.textContent = state.area ? 'Neues Gebiet' : 'Verschleiern';
  buildPOIs();
  updateProgress();
  queueFog();
  if (sim) {
    // Testmodus: Start in Deggendorf-Mitte
    setTimeout(() => onPosition(48.8346, 12.9622, 5), 400);
  }
})();

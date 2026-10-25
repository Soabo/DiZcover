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
  // Nachtportier
  const PORTER_CATCH_M = 8;            // so nah = erwischt
  const PORTER_SENSE_BASE_M = 30;      // Spürweite ohne Seelen …
  const PORTER_SENSE_PER_SOUL_M = 10;  // … plus pro getragener Seele (Seelenlast)
  const PORTER_WANDER_SPEED = 0.5;     // m/s beim Patrouillieren
  const PORTER_HUNT_SPEED = 0.9;       // m/s beim Verfolgen …
  const PORTER_HUNT_PER_SOUL = 0.04;   // … plus pro Seele (max. ~1,2 m/s, langsamer als Gehen)
  const PORTER_COOLDOWN_MS = 45000;    // Rückzug nach einem Fang
  // Seelenkompass
  const COMPASS_START = 1;
  const COMPASS_SHOW_MS = 12000;

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
  // Eigene Position: eigenes Element über dem Nebel (nicht als Leaflet-Marker darunter)
  const meEl = document.createElement('div');
  meEl.className = 'me';
  meEl.hidden = true;
  meEl.innerHTML = '<div class="me-arrow" hidden><svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true"><path d="M22 0 L29.5 11 L14.5 11 Z" fill="#a3201c" stroke="#efe3c8" stroke-width="2" stroke-linejoin="round"/></svg></div><div class="me-compass" hidden><svg viewBox="0 0 140 140" width="140" height="140" aria-hidden="true"><line x1="70" y1="62" x2="70" y2="20" stroke="#d4b06a" stroke-width="2" stroke-dasharray="3 4" opacity=".8"/><path d="M70 2 L79 22 L70 17 L61 22 Z" fill="#d4b06a" stroke="#1a1613" stroke-width="1.5" stroke-linejoin="round"/></svg></div><div class="me-dot"></div>';
  document.body.appendChild(meEl);
  let heading = null;          // Bewegungsrichtung in Grad (0 = Nord)
  let headingFrom = null;      // letzter Punkt für eigene Richtungsberechnung
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
    requestAnimationFrame(() => { fogQueued = false; drawFog(); renderPOIs(); renderMe(); });
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

  function onPosition(lat, lng, acc, gpsHeading, speed) {
    const ll = L.latLng(lat, lng);
    lastPos = ll;
    updateHeading(lat, lng, gpsHeading, speed);
    meEl.hidden = false;
    applyHeading();
    queueFog();
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
      checkCompassEarn();
      queueFog();
    }
  }

  if (sim) {
    document.getElementById('simBanner').hidden = false;
    setStatus('Testmodus aktiv', false);
  } else if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
      pos => onPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.heading, pos.coords.speed),
      err => {
        if (err.code === 1) { setStatus('Standort nicht freigegeben', false); showLocationHelp(); }
        else setStatus('Kein GPS-Signal – bitte draußen versuchen', false);
      },
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
    const g = state.game;
    if (g && g.aborted) { resetToStart(); return; }               // "Weiter"
    if (g && !g.doneAt) {                                         // laufende Jagd
      showModal({
        title: 'Seelenjagd beenden?',
        text: 'Alle Seelen werden auf der Karte aufgedeckt. Danach kannst du ein neues Gebiet zeichnen.',
        buttons: [
          { label: 'Nein' },
          { label: 'Ja, beenden', primary: true, onClick: abortHunt }
        ]
      });
      return;
    }
    if (state.area) {
      showModal({
        title: 'Neues Gebiet?',
        text: 'Das bisherige Gebiet und sein Fortschritt werden verworfen.',
        buttons: [
          { label: 'Nein' },
          { label: 'Neues Gebiet', primary: true, onClick: startDrawing }
        ]
      });
      return;
    }
    startDrawing();
  });

  function setMainLabel() {
    btnVeil.textContent = mainLabel();
    btnVeil.classList.toggle('long', btnVeil.textContent.length > 14);
  }

  function mainLabel() {
    const g = state.game;
    if (g && g.aborted) return 'Weiter';
    if (g && !g.doneAt) return 'Beenden & Seelen aufdecken';
    return state.area ? 'Neues Gebiet' : 'Verschleiern';
  }

  function abortHunt() {
    const g = state.game;
    if (!g) return;
    g.aborted = true;
    save();
    setAction(null);
    setDanger(0);
    updateCompassButton();
    setMainLabel();
    buildPOIs();
    updateProgress();
    if (grid) map.flyToBounds(L.polygon(state.area).getBounds().pad(0.1), { duration: 1 });
    queueFog();
  }

  function resetToStart() {
    state = { area: null, points: [], game: null };
    grid = null;
    pointKeys.clear();
    save();
    clearPOIs();
    setMainLabel();
    setDanger(0);
    updateCompassButton();
    updateProgress();
    queueFog();
    if (lastPos) map.flyToBounds(lastPos.toBounds(START_BOX_M), { duration: 1 });
  }
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
    setMainLabel();
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

  let pendingPlan = null;

  function askSoulRound() {
    pendingPlan = preparePlan();     // Platzierung + Prüfung laufen schon, während der Dialog offen ist
    ensureNav();                     // Straßennetz für den Portier ebenfalls im Hintergrund
    showModal({
      title: 'Seelenrunde?',
      text: `In deinem Gebiet irren ${SOUL_COUNT} verlorene Seelen umher. Sammle sie alle ein und bring sie zum Seelenfriedhof, damit sie Ruhe finden.`,
      list: [
        'Der Nachtportier streift unsichtbar durch den Nebel. Bemerkt er dich, folgt er dir langsam – das Handy pocht und der Rand färbt sich rot. Erwischt er dich, flieht eine deiner Seelen.',
        'Seelenlast: Je mehr Seelen du trägst, desto weiter spürt er dich.',
        'Seelenkompass: zeigt kurz die Richtung zur nächsten Seele. Für je 10 % aufgedecktes Gebiet gibt es eine neue Ladung.'
      ],
      buttons: [
        { label: 'Nur erkunden' },
        { label: 'Seelenrunde starten', primary: true, onClick: startSoulRound }
      ]
    });
  }

  // Würfelt Positionen aus und startet im Hintergrund die Gebäude-/Wasserprüfung
  function preparePlan() {
    const pts = placePoints(SOUL_COUNT + 2);
    if (!pts) return null;
    // Der Punkt am weitesten vom Spieler wird zum Startpunkt des Portiers
    let pi = 0;
    if (lastPos) {
      let best = -1;
      pts.forEach((p, i) => { const d = distM(lastPos.lat, lastPos.lng, p[0], p[1]); if (d > best) { best = d; pi = i; } });
    }
    const porter = pts.splice(pi, 1)[0];
    const [grave, ...souls] = pts;
    const plan = {
      grave: { lat: grave[0], lng: grave[1], ok: false },
      souls: souls.map(p => ({ lat: p[0], lng: p[1], taken: false, ok: false })),
      porter: { lat: porter[0], lng: porter[1], mode: 'wander', target: null, cooldownUntil: 0 }
    };
    validatePlan(plan);
    return plan;
  }

  function startSoulRound() {
    const plan = pendingPlan || preparePlan();
    pendingPlan = null;
    if (!plan) {
      showModal({ title: 'Gebiet zu klein', text: 'Für eine Seelenrunde braucht es ein größeres Gebiet.', buttons: [{ label: 'OK', primary: true }] });
      return;
    }
    // Sofort starten. Was noch nicht geprüft ist, wird im Hintergrund weitergeprüft
    // (dieselben Objekte, Umsetzungen wirken also direkt im Spiel).
    state.game = {
      grave: plan.grave,
      souls: plan.souls,
      porter: plan.porter,
      compass: COMPASS_START,
      compassEarned: grid && grid.total ? Math.floor(grid.count / grid.total * 10) : 0,
      caught: 0,
      startedAt: Date.now(), doneAt: null
    };
    compassUntil = 0;
    snapPorterToRoad();          // falls das Straßennetz schon fertig ist
    save();
    setMainLabel();
    buildPOIs();
    updateProgress();
    updateCompassButton();
    checkProximity();
    queueFog();
  }

  // ---------- Gebäude & Wasser per Kartenfarbe erkennen ----------
  // Die OSM-Karte malt Gebäude und Wasser in festen Farben. Wir lesen das Kartenbild
  // an der Stelle aus (Zoom 18, ca. 0,4 m pro Pixel). Keine Zusatzdaten, kein Fremdserver.
  const CHECK_Z = 18;
  const BLOCK_COLORS = [
    [217, 208, 201],   // Gebäude (#d9d0c9)
    [196, 182, 171],   // große Gebäude: Kirchen, Bahnhöfe … (darken 10 %)
    [185, 169, 156],   // Gebäude-Umriss (darken 15 %)
    [170, 211, 223]    // Wasser (#aad3df)
  ];
  const COLOR_TOL = 14;
  const tileCache = new Map();
  let tileCheckBroken = false;   // Server erlaubt kein Auslesen -> Prüfung still aus

  function tileOf(lat, lng) {
    const n = 2 ** CHECK_Z;
    const x = (lng + 180) / 360 * n;
    const r = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
    const tx = Math.floor(x), ty = Math.floor(y);
    return { tx, ty, px: Math.floor((x - tx) * 256), py: Math.floor((y - ty) * 256) };
  }

  function loadTile(tx, ty) { return loadTileZ(CHECK_Z, tx, ty); }

  function loadTileZ(z, tx, ty) {
    const key = z + '/' + tx + '/' + ty;
    if (!tileCache.has(key)) {
      const job = (async () => {
        if (tileCheckBroken) return null;
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 8000);
          const res = await fetch(`https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`, { mode: 'cors', signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) return null;
          const bmp = await createImageBitmap(await res.blob());
          const c = document.createElement('canvas');
          c.width = c.height = 256;
          const cx = c.getContext('2d', { willReadFrequently: true });
          cx.drawImage(bmp, 0, 0);
          return cx.getImageData(0, 0, 256, 256).data;
        } catch (e) {
          if (e && (e.name === 'TypeError' || e.name === 'SecurityError')) tileCheckBroken = true;
          return null;
        }
      })();
      tileCache.set(key, job);
    }
    return tileCache.get(key);
  }

  // true = Gebäude/Wasser, false = frei, null = unbekannt
  async function isBlockedAt(lat, lng) {
    const { tx, ty, px, py } = tileOf(lat, lng);
    const data = await loadTile(tx, ty);
    if (!data) return null;
    let hits = 0, total = 0;
    for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) {
      const x = Math.min(255, Math.max(0, px + dx)), y = Math.min(255, Math.max(0, py + dy));
      const o = (y * 256 + x) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      total++;
      if (BLOCK_COLORS.some(c => Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b) <= COLOR_TOL * 2)) hits++;
    }
    return hits >= total * 0.4;     // Beschriftungen auf Gebäuden stören so nicht
  }

  function isLive(plan) { return !!(state.game && state.game.souls === plan.souls); }

  // Neuer zufälliger Punkt mit Abstand zu den anderen und zum Spieler
  function rerollPoint(others) {
    const g = grid;
    if (!g) return null;
    const minOther = Math.max(12, 0.3 * Math.sqrt(g.areaM2 / (SOUL_COUNT + 2)));
    for (let t = 0; t < 600; t++) {
      const p = randomInside(30, true);
      if (!p) return null;
      if (others.every(o => distM(p[0], p[1], o.lat, o.lng) >= minOther * (t < 300 ? 1 : 0.5))) return p;
    }
    return null;
  }

  async function validatePlan(plan) {
    const items = [plan.grave, ...plan.souls];
    // alle benötigten Kacheln parallel vorladen
    await Promise.all(items.filter(it => !it.ok).map(it => { const t = tileOf(it.lat, it.lng); return loadTile(t.tx, t.ty); }));
    for (const it of items) {
      if (it.ok) continue;
      let moved = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (it.taken || tileCheckBroken) break;
        const blocked = await isBlockedAt(it.lat, it.lng);
        if (blocked !== true) break;
        // Eine Seele, die der Spieler schon gesehen hat, bleibt, wo sie ist
        if (it !== plan.grave && isLive(plan) && isRevealed(it.lat, it.lng)) break;
        const np = rerollPoint(items.filter(o => o !== it));
        if (!np) break;
        it.lat = np[0]; it.lng = np[1];
        moved = true;
      }
      it.ok = true;
      if (isLive(plan)) { save(); if (moved) { buildPOIs(); checkProximity(); } }
    }
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
      const shown = g.aborted || isRevealed(s.lat, s.lng);
      e.className = 'poi soul' + (shown ? '' : ' veiled');
      e.style.animationDelay = (-i * 0.7) + 's';
      e.innerHTML = SOUL_SVG;
      poiLayer.appendChild(e);
      if (g.aborted) e.classList.add('missed');
      poiEls.push({ el: e, lat: s.lat, lng: s.lng, kind: 'soul', i, seen: shown });
    });
    if (g.porter) {
      const pe = document.createElement('div');
      pe.className = 'poi porter';
      pe.innerHTML = PORTER_SVG;
      poiLayer.appendChild(pe);
      poiEls.push({ el: pe, lat: g.porter.lat, lng: g.porter.lng, kind: 'porter' });
    }
    renderPOIs();
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
      if (p.kind === 'porter') {
        p.lat = g.porter.lat; p.lng = g.porter.lng;
        p.el.classList.toggle('hunting', g.porter.mode === 'hunt' && !g.doneAt && !g.aborted);
      }
      const pt = map.latLngToContainerPoint([p.lat, p.lng]);
      const off = pt.x < -60 || pt.y < -60 || pt.x > size.x + 60 || pt.y > size.y + 60;
      p.el.style.display = off ? 'none' : '';
      if (off) continue;
      p.el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
      const revealed = (g && g.aborted) || isRevealed(p.lat, p.lng);
      p.el.classList.toggle('veiled', !revealed);
      if (p.kind === 'soul' && revealed && !p.seen) { p.seen = true; buzz(120); }
      if (p.kind === 'grave') {
        const n = g.souls.filter(s => s.taken).length;
        p.el.classList.toggle('ready', n === SOUL_COUNT && !g.doneAt);
        p.el.classList.toggle('done', !!g.doneAt);
      }
    }
  }

  function checkProximity() {
    const g = state.game;
    if (!g || g.doneAt || g.aborted || !lastPos || drawing) { setAction(null); return; }
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
    if (kind && kind !== action) buzz(kind === 'pickup' ? [40, 60, 40] : [60, 60, 60]);
    action = kind;
    if (!btnAction) return;
    btnAction.hidden = !kind;
    btnVeil.hidden = !!kind;
    if (kind === 'pickup') btnAction.textContent = 'Seele aufnehmen';
    if (kind === 'deliver') btnAction.textContent = 'Seelen abgeben';
    btnAction.classList.toggle('dance', !!kind);
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
      buzz(60);
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
      buzz([80, 60, 160]);
      updateProgress();
      setAction(null);
      setMainLabel();
      setDanger(0);
      updateCompassButton();
      queueFog();
      const mins = Math.max(1, Math.round((g.doneAt - g.startedAt) / 60000));
      const dur = mins < 60 ? `${mins} Minute${mins === 1 ? '' : 'n'}` : `${Math.floor(mins / 60)} Std. ${mins % 60} Min.`;
      const pct = grid && grid.total ? (grid.count / grid.total * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '0';
      showModal({
        title: 'Geschafft!',
        text: `Alle ${SOUL_COUNT} Seelen ruhen nun auf dem Friedhof.\nDauer: ${dur} · Aufgedeckt: ${pct} %\n${g.caught ? `Vom Nachtportier erwischt: ${g.caught}×` : 'Der Nachtportier hat dich nie erwischt.'}`,
        buttons: [{ label: 'Neues Gebiet', primary: true, onClick: () => { resetToStart(); startDrawing(); } }],
        win: true
      });
    }
  });


  // ---------- Nachtportier ----------
  const PORTER_SVG = '<svg viewBox="0 0 48 66" width="42" height="58" aria-hidden="true"><defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1714"/><stop offset=".75" stop-color="#1c1714"/><stop offset="1" stop-color="#1c1714" stop-opacity="0"/></linearGradient></defs><path d="M12 30c0-4 5-7 12-7s12 3 12 7l4 34H8z" fill="url(#pg)"/><circle cx="24" cy="31" r="1.6" fill="#b8924a"/><circle cx="24" cy="38" r="1.6" fill="#b8924a"/><circle cx="24" cy="45" r="1.6" fill="#b8924a"/><ellipse cx="24" cy="16" rx="8.5" ry="9.5" fill="#2a221c"/><rect x="13" y="3" width="22" height="7" rx="1.5" fill="#1c1714" stroke="#b8924a" stroke-width="1.2"/><rect x="11" y="9" width="26" height="3" rx="1" fill="#1c1714"/><circle class="eye" cx="20.5" cy="17" r="1.8" fill="#ff3b2f"/><circle class="eye" cx="27.5" cy="17" r="1.8" fill="#ff3b2f"/></svg>';
  const dangerEl = document.getElementById('danger');
  let lastTick = 0, nextBeat = 0;

  function carried(g) { return g.souls.filter(s => s.taken).length; }
  function senseRadius(g) { return PORTER_SENSE_BASE_M + PORTER_SENSE_PER_SOUL_M * carried(g); }
  function toXY(lat, lng) { return [(lng - grid.lng0) * grid.kx, (lat - grid.lat0) * grid.ky]; }
  function toLatLng(x, y) { return [round6(y / grid.ky + grid.lat0), round6(x / grid.kx + grid.lng0)]; }
  function insideXY(x, y) {
    const i = Math.floor((x - grid.minX) / grid.cell), j = Math.floor((y - grid.minY) / grid.cell);
    return i >= 0 && j >= 0 && i < grid.W && j < grid.H && !!grid.inside[j * grid.W + i];
  }

  // Zufälliger Punkt im Gebiet, bevorzugt im Nebel und mit Mindestabstand zum Spieler
  function randomInside(minFromPlayer, preferVeiled) {
    const g = grid;
    const me = lastPos ? toXY(lastPos.lat, lastPos.lng) : null;
    for (let pass = 0; pass < 3; pass++) {
      const minD = pass === 2 ? 0 : minFromPlayer;
      for (let t = 0; t < 3000; t++) {
        const idx = Math.floor(Math.random() * g.W * g.H);
        if (!g.inside[idx]) continue;
        if (preferVeiled && pass === 0 && g.revealed[idx]) continue;
        const x = g.minX + ((idx % g.W) + Math.random()) * g.cell;
        const y = g.minY + (((idx / g.W) | 0) + Math.random()) * g.cell;
        if (me && minD && Math.hypot(x - me[0], y - me[1]) < minD) continue;
        return toLatLng(x, y);
      }
    }
    return null;
  }

  function setDanger(v) {
    if (!dangerEl) return;
    dangerEl.style.opacity = v.toFixed(2);
    dangerEl.classList.toggle('beat', v > 0);
  }

  function gameTick() {
    const now = Date.now();
    const dt = lastTick ? Math.min(3, (now - lastTick) / 1000) : 0;
    lastTick = now;
    const g = state.game;
    if (!g || !g.porter || g.doneAt || g.aborted || !grid || drawing) { setDanger(0); return; }
    const P = g.porter;
    if (P.cooldownUntil && now < P.cooldownUntil) { setDanger(0); return; }

    let [px, py] = toXY(P.lat, P.lng);
    const me = lastPos ? toXY(lastPos.lat, lastPos.lng) : null;
    const sense = senseRadius(g);
    let dMe = me ? Math.hypot(me[0] - px, me[1] - py) : Infinity;

    if (P.mode !== 'hunt' && dMe <= sense) {
      P.mode = 'hunt';
      buzz([200, 80, 200]);
      setStatus('Der Nachtportier hat dich bemerkt!', false);
    } else if (P.mode === 'hunt' && dMe > sense * 1.5) {
      P.mode = 'wander';
      P.target = null;
      setStatus('Der Nachtportier hat deine Spur verloren', false);
    }

    const speed = P.mode === 'hunt'
      ? PORTER_HUNT_SPEED + PORTER_HUNT_PER_SOUL * carried(g)
      : PORTER_WANDER_SPEED;
    if (nav && nav.area === state.area) {
      [px, py] = navStep(P, px, py, me, speed * dt);   // nur auf Straßen und Wegen
    } else {
      // Fallback ohne Straßennetz: Luftlinie
      let tx, ty;
      if (P.mode === 'hunt') {
        [tx, ty] = me;
      } else {
        if (!P.target) P.target = randomInside(0, false);
        if (!P.target) return;
        [tx, ty] = toXY(P.target[0], P.target[1]);
      }
      const dist = Math.hypot(tx - px, ty - py);
      if (dist > 0.05) {
        const step = Math.min(dist, speed * dt);
        const nx = px + (tx - px) / dist * step, ny = py + (ty - py) / dist * step;
        if (insideXY(nx, ny)) { px = nx; py = ny; }       // der Portier verlässt das Gebiet nie
        else if (P.mode === 'wander') P.target = null;
      }
      if (P.mode === 'wander' && dist < 3) P.target = null;
    }
    [P.lat, P.lng] = toLatLng(px, py);

    if (me) {
      dMe = Math.hypot(me[0] - px, me[1] - py);
      if (dMe <= PORTER_CATCH_M) { porterCaught(); return; }
    }

    if (P.mode === 'hunt') {
      const k = Math.max(0, Math.min(1, 1 - (dMe - PORTER_CATCH_M) / (sense * 1.5 - PORTER_CATCH_M)));
      setDanger(0.2 + 0.65 * k);
      if (now >= nextBeat) { buzz([35, 90, 35]); nextBeat = now + 700 + 2800 * (1 - k); }
    } else {
      setDanger(0);
    }
    if (now - (P.savedAt || 0) > 5000) { P.savedAt = now; save(); }
    queueFog();
  }
  setInterval(gameTick, 500);


  // ---------- Straßennetz für den Nachtportier ----------
  // Die Kartenkacheln des Gebiets werden eingelesen; Pixel in Straßen-/Wegfarben
  // (laut openstreetmap-carto) ergeben ein Raster begehbarer Zellen. Der Portier
  // folgt darauf einem Wegfeld (Breitensuche) – wie ein Navi.
  const ROAD_COLORS = [
    [[255, 255, 255], 8],   // Wohn-, Neben-, Tertiärstraßen, Wegränder
    [[247, 250, 191], 14],  // Sekundärstraße
    [[252, 214, 164], 14],  // Primärstraße
    [[249, 178, 156], 14],  // Bundesstraße (trunk)
    [[237, 237, 237], 5],   // verkehrsberuhigt
    [[221, 221, 232], 6],   // Fußgängerzone
    [[250, 128, 114], 30],  // Fußweg, Pfad, Treppe (salmon)
    [[0, 0, 255], 60],      // Radweg
    [[0, 128, 0], 50],      // Reitweg
    [[153, 102, 0], 40]     // Feld-/Wirtschaftsweg
  ];
  const NAV_MAX_TILES = 80;
  let nav = null;            // { area, cell, W, H, ox, oy, main: Uint8Array, nearest: Int32Array, fields }
  let navBuilding = null;

  function isRoadColor(r, g, b) {
    for (const [c, tol] of ROAD_COLORS) {
      if (Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b) <= tol) return true;
    }
    return false;
  }

  function ensureNav() {
    if (!state.area || !grid) return;
    if (nav && nav.area === state.area) return;
    if (navBuilding && navBuilding.area === state.area) return;
    const area = state.area;
    navBuilding = { area };
    buildNav(area).then(n => {
      if (navBuilding && navBuilding.area === area) navBuilding = null;
      if (n && state.area === area) { nav = n; snapPorterToRoad(); }
    });
  }

  async function buildNav(area) {
    const g = grid;
    if (!g || tileCheckBroken) return null;
    const lats = area.map(p => p[0]), lngs = area.map(p => p[1]);
    const latMin = Math.min(...lats), latMax = Math.max(...lats), lngMin = Math.min(...lngs), lngMax = Math.max(...lngs);

    // Zoomstufe wählen, sodass höchstens NAV_MAX_TILES Kacheln nötig sind
    const gpx = (lat, lng, z) => {
      const n = 2 ** z * 256, r = lat * Math.PI / 180;
      return [(lng + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
    };
    let z = 17, t0, t1;
    for (; z >= 16; z--) {
      const a = gpx(latMax, lngMin, z), b = gpx(latMin, lngMax, z);
      t0 = [Math.floor(a[0] / 256), Math.floor(a[1] / 256)];
      t1 = [Math.floor(b[0] / 256), Math.floor(b[1] / 256)];
      if ((t1[0] - t0[0] + 1) * (t1[1] - t0[1] + 1) <= NAV_MAX_TILES) break;
    }
    if (z < 16) return null;

    // Kacheln laden (max. 6 gleichzeitig)
    const tiles = new Map();
    const list = [];
    for (let tx = t0[0]; tx <= t1[0]; tx++) for (let ty = t0[1]; ty <= t1[1]; ty++) list.push([tx, ty]);
    let fails = 0;
    const worker = async () => {
      while (list.length) {
        const [tx, ty] = list.pop();
        const d = await loadTileZ(z, tx, ty);
        if (d) tiles.set(tx + '/' + ty, d); else fails++;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (state.area !== area || tileCheckBroken || fails > tiles.size * 0.25) return null;

    // Navigationsraster über das Gebiet
    const gw = g.W * g.cell, gh = g.H * g.cell;
    const cell = Math.max(2.5, Math.sqrt(gw * gh / 200000));
    const W = Math.ceil(gw / cell), H = Math.ceil(gh / cell), N = W * H;
    const ox = g.minX, oy = g.minY;
    const road = new Uint8Array(N);
    const sampleRoad = (x, y) => {
      const lat = y / g.ky + g.lat0, lng = x / g.kx + g.lng0;
      const [px, py] = gpx(lat, lng, z);
      const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
      const d = tiles.get(tx + '/' + ty);
      if (!d) return false;
      const o = ((Math.floor(py) - ty * 256) * 256 + (Math.floor(px) - tx * 256)) * 4;
      return isRoadColor(d[o], d[o + 1], d[o + 2]);
    };
    const inside = new Uint8Array(N);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const cx = ox + (i + 0.5) * cell, cy = oy + (j + 0.5) * cell;
      if (!insideXY(cx, cy)) continue;
      inside[j * W + i] = 1;
      let hits = 0;
      for (let a = -1; a <= 1 && hits < 2; a++) for (let b = -1; b <= 1 && hits < 2; b++) {
        if (sampleRoad(cx + a * cell / 3, cy + b * cell / 3)) hits++;
      }
      if (hits >= 2) road[j * W + i] = 1;
    }
    // Lücken (gestrichelte Wege, Beschriftungen) schließen: einmal ausdehnen
    const walk = new Uint8Array(N);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (!inside[k]) continue;
      let on = road[k];
      for (let dj = -1; dj <= 1 && !on; dj++) for (let di = -1; di <= 1 && !on; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < W && jj < H && road[jj * W + ii]) on = 1;
      }
      walk[k] = on;
    }
    // Größtes zusammenhängendes Netz behalten
    const comp = new Int32Array(N).fill(-1);
    const q = new Int32Array(N);
    let bestId = -1, bestSize = 0, id = 0;
    for (let k = 0; k < N; k++) {
      if (!walk[k] || comp[k] >= 0) continue;
      let h = 0, t = 0, size = 0;
      q[t++] = k; comp[k] = id;
      while (h < t) {
        const c = q[h++]; size++;
        const ci = c % W, cj = (c / W) | 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
          const nk = jj * W + ii;
          if (walk[nk] && comp[nk] < 0) { comp[nk] = id; q[t++] = nk; }
        }
      }
      if (size > bestSize) { bestSize = size; bestId = id; }
      id++;
    }
    // Kachel-Pixel werden nicht mehr gebraucht: Speicher freigeben
    for (const key of tiles.keys()) tileCache.delete(z + '/' + key);
    tiles.clear();
    if (bestSize < 40) return null;
    const main = new Uint8Array(N);
    for (let k = 0; k < N; k++) if (comp[k] === bestId) main[k] = 1;

    // Für jede Zelle: nächste Straßenzelle (Mehrquellen-Breitensuche)
    const nearest = new Int32Array(N).fill(-1);
    let h = 0, t = 0;
    for (let k = 0; k < N; k++) if (main[k]) { nearest[k] = k; q[t++] = k; }
    while (h < t) {
      const c = q[h++];
      const ci = c % W, cj = (c / W) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = ci + di, jj = cj + dj;
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
        const nk = jj * W + ii;
        if (nearest[nk] < 0) { nearest[nk] = nearest[c]; q[t++] = nk; }
      }
    }
    return { area, cell, W, H, ox, oy, main, nearest, q, size: bestSize, hunt: null, wander: null };
  }

  function navCellOf(x, y) {
    const i = Math.min(nav.W - 1, Math.max(0, Math.floor((x - nav.ox) / nav.cell)));
    const j = Math.min(nav.H - 1, Math.max(0, Math.floor((y - nav.oy) / nav.cell)));
    return j * nav.W + i;
  }
  function navCenter(k) { return [nav.ox + ((k % nav.W) + 0.5) * nav.cell, nav.oy + (((k / nav.W) | 0) + 0.5) * nav.cell]; }

  // Breitensuche vom Ziel aus: jede Straßenzelle kennt ihren Abstand zum Ziel
  function navField(goal) {
    const { W, H, main, q } = nav;
    const f = new Int32Array(W * H).fill(-1);
    let h = 0, t = 0;
    f[goal] = 0; q[t++] = goal;
    while (h < t) {
      const c = q[h++];
      const ci = c % W, cj = (c / W) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = ci + di, jj = cj + dj;
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
        const nk = jj * W + ii;
        if (main[nk] && f[nk] < 0) { f[nk] = f[c] + 1; q[t++] = nk; }
      }
    }
    return { goal, f };
  }

  function randomRoadCell() {
    for (let t = 0; t < 5000; t++) {
      const k = Math.floor(Math.random() * nav.W * nav.H);
      if (nav.main[k]) return k;
    }
    return -1;
  }

  // Unsichtbarer Portier wird beim Fertigwerden des Netzes auf die nächste Straße gesetzt
  function snapPorterToRoad() {
    const g = state.game;
    if (!nav || !g || !g.porter || !grid) return;
    const [x, y] = toXY(g.porter.lat, g.porter.lng);
    const k = navCellOf(x, y);
    if (nav.main[k] || isRevealed(g.porter.lat, g.porter.lng)) return;
    const r = nav.nearest[k];
    if (r < 0) return;
    const [cx, cy] = navCenter(r);
    [g.porter.lat, g.porter.lng] = toLatLng(cx, cy);
    save();
  }

  // Bewegt den Portier um "budget" Meter entlang des Straßennetzes
  function navStep(P, px, py, me, budget) {
    let field;
    if (P.mode === 'hunt' && me) {
      const goal = nav.nearest[navCellOf(me[0], me[1])];
      if (goal < 0) return [px, py];
      if (!nav.hunt || nav.hunt.goal !== goal) nav.hunt = navField(goal);
      field = nav.hunt;
    } else {
      let k = navCellOf(px, py);
      if (!nav.wander || nav.wander.f[k] === 0 || nav.wander.f[nav.nearest[k]] < 0) {
        const goal = randomRoadCell();
        if (goal < 0) return [px, py];
        nav.wander = navField(goal);
      }
      field = nav.wander;
    }
    const { W, H, main } = nav;
    for (let guard = 0; guard < 50 && budget > 0.01; guard++) {
      const c = navCellOf(px, py);
      let tk;
      if (!main[c]) {
        tk = nav.nearest[c];                     // erst zurück auf die Straße
      } else {
        const fc = field.f[c];
        let best = c, bestF = fc;
        const ci = c % W, cj = (c / W) | 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
          const nk = jj * W + ii;
          if (main[nk] && field.f[nk] >= 0 && field.f[nk] < bestF) { bestF = field.f[nk]; best = nk; }
        }
        tk = best;
      }
      if (tk < 0) break;
      const [tx, ty] = navCenter(tk);
      const d = Math.hypot(tx - px, ty - py);
      if (d < 0.01) break;                       // am Ziel angekommen
      if (d <= budget) { px = tx; py = ty; budget -= d; }
      else { px += (tx - px) / d * budget; py += (ty - py) / d * budget; budget = 0; }
    }
    return [px, py];
  }

  function porterCaught() {
    const g = state.game, P = g.porter;
    P.mode = 'wander';
    P.target = null;
    P.cooldownUntil = Date.now() + PORTER_COOLDOWN_MS;
    g.caught = (g.caught || 0) + 1;
    const away = randomInside(90, false);
    if (away) [P.lat, P.lng] = away;

    const held = g.souls.map((s, i) => s.taken ? i : -1).filter(i => i >= 0);
    let text;
    if (held.length) {
      const i = held[Math.floor(Math.random() * held.length)];
      const spot = randomInside(40, true) || [g.souls[i].lat, g.souls[i].lng];
      g.souls[i] = { lat: spot[0], lng: spot[1], taken: false };
      text = 'Der Nachtportier hat dir eine Seele entrissen. Sie ist zurück in den Nebel geflohen.';
    } else {
      text = 'Der Nachtportier hat dich erwischt. Zum Glück trugst du keine Seele bei dir.';
    }
    save();
    buzz([400, 120, 400]);
    setDanger(0);
    buildPOIs();
    updateProgress();
    checkProximity();
    queueFog();
    showModal({ title: 'Erwischt!', text: text + '\nEr zieht sich für einen Moment zurück.', buttons: [{ label: 'Weiter', primary: true }] });
  }

  // ---------- Seelenkompass ----------
  const btnCompass = el('btnCompass');
  const needleEl = meEl.querySelector('.me-compass');
  let compassUntil = 0, compassTimer = null;

  function updateCompassButton() {
    const g = state.game;
    const active = !!(g && g.porter && !g.doneAt && !g.aborted);
    btnCompass.hidden = !active;
    if (!active) { hideNeedle(); return; }
    el('compassCount').textContent = g.compass || 0;
    btnCompass.disabled = !(g.compass > 0) || Date.now() < compassUntil;
  }

  function checkCompassEarn() {
    const g = state.game;
    if (!g || !g.porter || g.doneAt || g.aborted || !grid || !grid.total) return;
    const tens = Math.floor(grid.count / grid.total * 10);
    if (tens > (g.compassEarned || 0)) {
      const add = tens - (g.compassEarned || 0);
      g.compassEarned = tens;
      g.compass = (g.compass || 0) + add;
      save();
      updateCompassButton();
      btnCompass.classList.remove('charged'); void btnCompass.offsetWidth; btnCompass.classList.add('charged');
      buzz([40, 40, 40]);
    }
  }

  function compassTarget() {
    const g = state.game;
    if (!g || !lastPos) return null;
    let best = null, bestD = Infinity;
    for (const s of g.souls) {
      if (s.taken) continue;
      const d = distM(lastPos.lat, lastPos.lng, s.lat, s.lng);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best || g.grave;      // alle getragen: zum Friedhof
  }

  btnCompass.addEventListener('click', () => {
    const g = state.game;
    if (!g || !(g.compass > 0) || !lastPos || Date.now() < compassUntil) return;
    g.compass--;
    save();
    compassUntil = Date.now() + COMPASS_SHOW_MS;
    needleEl.hidden = false;
    needleEl.classList.remove('fade'); void needleEl.offsetWidth; needleEl.classList.add('fade');
    updateCompassNeedle();
    updateCompassButton();
    buzz(30);
    clearTimeout(compassTimer);
    compassTimer = setTimeout(() => { hideNeedle(); updateCompassButton(); }, COMPASS_SHOW_MS);
  });

  function hideNeedle() {
    compassUntil = 0;
    if (needleEl) needleEl.hidden = true;
  }

  function updateCompassNeedle() {
    if (!needleEl || needleEl.hidden || !lastPos) return;
    const t = compassTarget();
    if (!t) { hideNeedle(); return; }
    const dx = (t.lng - lastPos.lng) * 111320 * Math.cos(lastPos.lat * Math.PI / 180);
    const dy = (t.lat - lastPos.lat) * 110540;
    needleEl.style.transform = `rotate(${Math.atan2(dx, dy) * 180 / Math.PI}deg)`;
  }

  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* nicht unterstützt */ }
  }


  // ---------- Bewegungsrichtung ----------
  function updateHeading(lat, lng, gpsHeading, speed) {
    if (gpsHeading != null && !isNaN(gpsHeading) && (speed == null || speed > 0.4)) {
      heading = gpsHeading;
      headingFrom = [lat, lng];
      return;
    }
    // Eigene Berechnung aus den letzten Positionen (ab 4 m Bewegung)
    if (!headingFrom) { headingFrom = [lat, lng]; return; }
    const dx = (lng - headingFrom[1]) * 111320 * Math.cos(lat * Math.PI / 180);
    const dy = (lat - headingFrom[0]) * 110540;
    if (Math.hypot(dx, dy) >= 4) {
      heading = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      headingFrom = [lat, lng];
    }
  }

  function applyHeading() {
    const arrow = meEl.querySelector('.me-arrow');
    arrow.hidden = heading == null;
    if (heading != null) arrow.style.transform = `rotate(${heading}deg)`;
  }

  function renderMe() {
    if (!lastPos || meEl.hidden) return;
    const pt = map.latLngToContainerPoint(lastPos);
    meEl.style.transform = `translate(${pt.x - 22}px, ${pt.y - 22}px)`;
    updateCompassNeedle();
  }

  // ---------- Hilfe bei verweigertem Standort ----------
  function showLocationHelp() {
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const steps = ios ? [
      'iPhone-Einstellungen öffnen → Datenschutz & Sicherheit → Ortungsdienste: einschalten.',
      'Weiter unten „Safari-Websites“ (bzw. „Chrome“) antippen → „Beim Verwenden der App“ wählen und „Genauer Standort“ aktivieren.',
      'In Safari auf „aA“ links in der Adressleiste tippen → Website-Einstellungen → Standort: „Erlauben“.',
      'Zurück zu DiZcover und „Neu laden“ tippen.'
    ] : [
      'Am Handy den Standort einschalten (Schnelleinstellungen oben herunterziehen → „Standort“).',
      'In Chrome links neben der Adresse auf das Symbol tippen → Berechtigungen → Standort: „Zulassen“.',
      'Falls dort nichts geht: Android-Einstellungen → Apps → Chrome → Berechtigungen → Standort: „Nur während der Nutzung zulassen“ und „Genauen Standort verwenden“.',
      'Zurück zu DiZcover und „Neu laden“ tippen.'
    ];
    showModal({
      title: 'Standort freigeben',
      text: 'DiZcover braucht deinen Standort, um den Nebel aufzudecken. Der Zugriff ist auf diesem Gerät gerade gesperrt.',
      list: steps,
      hint: 'Tipp: Wurde der Link in WhatsApp, Instagram o. Ä. geöffnet, ihn bitte direkt im Browser öffnen (⋮ bzw. Teilen → „Im Browser öffnen“).',
      buttons: [
        { label: 'Später' },
        { label: 'Neu laden', primary: true, onClick: () => location.reload() }
      ]
    });
  }

  // ---------- Dialog ----------
  function showModal({ title, text, buttons, win, list, hint }) {
    const m = el('modal');
    el('modalTitle').textContent = title;
    el('modalText').textContent = text;
    m.classList.toggle('win', !!win);
    const card = m.querySelector('.modal-card');
    card.querySelectorAll('ol, .hint').forEach(n => n.remove());
    const box0 = el('modalButtons');
    if (list) {
      const ol = document.createElement('ol');
      for (const t of list) { const li = document.createElement('li'); li.textContent = t; ol.appendChild(li); }
      card.insertBefore(ol, box0);
    }
    if (hint) {
      const h = document.createElement('p');
      h.className = 'hint'; h.textContent = hint;
      card.insertBefore(h, box0);
    }
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
      soulsEl.textContent = g.aborted ? `Jagd beendet · ${n} / ${SOUL_COUNT}`
        : g.doneAt ? 'Alle Seelen erlöst'
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
  setMainLabel();
  buildPOIs();
  updateProgress();
  updateCompassButton();
  if (state.game && !state.game.doneAt && !state.game.aborted && grid) { validatePlan(state.game); if (state.game.porter) ensureNav(); }
  queueFog();
  if (sim) {
    // Testmodus: Start in Deggendorf-Mitte
    setTimeout(() => onPosition(48.8346, 12.9622, 5), 400);
  }
})();

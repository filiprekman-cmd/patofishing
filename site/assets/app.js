/* patofishing: views (Start, Jeziora, lake page), depth maps on canvas and search. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ helpers
  const $ = (selector, root) => (root || document).querySelector(selector);
  const collator = new Intl.Collator("pl", { sensitivity: "base", numeric: true });
  const numberFmt = new Intl.NumberFormat("pl-PL");
  const MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia",
    "września", "października", "listopada", "grudnia"];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? "" : value);
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-" + name);
    svg.append(use);
    return svg;
  }

  function fold(text) {
    return String(text).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l");
  }

  function formatDate(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    if (!match) return "";
    return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
  }

  function plural(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (n === 1) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const wikiUrl = (title) => "https://pl.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_"));
  const osmUrl = (lat, lon) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`;
  const formatCoord = (lat, lon) => `${lat.toFixed(4).replace(".", ",")}° N, ${lon.toFixed(4).replace(".", ",")}° E`;
  const narrow = () => window.matchMedia("(max-width: 900px)").matches;

  const DEPTH_BINS = [
    { max: 5, label: "poniżej 5 m", token: "--d1" },
    { max: 10, label: "5 do 10 m", token: "--d2" },
    { max: 20, label: "10 do 20 m", token: "--d3" },
    { max: 40, label: "20 do 40 m", token: "--d4" },
    { max: Infinity, label: "40 m i więcej", token: "--d5" },
  ];
  const depthToken = (depth) => (typeof depth === "number" ? DEPTH_BINS.find((b) => depth < b.max).token : null);
  const ACCENTS = ["--sky", "--aqua", "--amber", "--coral", "--reed", "--sand"];

  function legendItems() {
    return [
      ...DEPTH_BINS.map((bin) => h("span", null, h("i", { class: "dot", style: `background: var(${bin.token})`, "aria-hidden": "true" }), bin.label)),
      h("span", null, h("i", { class: "dot none", "aria-hidden": "true" }), "brak danych"),
    ];
  }

  // ------------------------------------------------------------------ state and public API
  const state = {
    data: null, lakes: [], byId: new Map(), speciesByKey: new Map(),
    filtered: [], selected: null, shown: 40, maxDepth: null,
    q: "", voiv: "", kind: "", fish: "", onlyFish: false, sort: "name",
  };
  const PAGE = 40;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const lakeListeners = [];

  window.patofishing = {
    ready, state, fold, formatDate, plural, h, icon, numberFmt, collator,
    onLakeSelected: (fn) => lakeListeners.push(fn),
    showView: (name) => showView(name),
    applyHash: () => applyHash(),
    catchesEnabled: false,
  };

  // ------------------------------------------------------------------ canvas map
  function createMap(box, canvas, tooltip, options) {
    const LON0 = 19.2, LAT0 = 52.0, COS = Math.cos((52 * Math.PI) / 180);
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, dpr = 1, fitScale = 1, userMoved = false, ready = false;
    const view = { cx: 0, cy: 0, scale: 1 };
    let poland = [], neighbours = [], points = [], polandBounds = null;
    let matchSet = null, selected = null, hover = null, colors = {};
    let reveal = 1, pingStart = 0, pingFrame = 0;

    const project = (lon, lat) => [(lon - LON0) * COS, -(lat - LAT0)];
    const toScreen = (x, y) => [(x - view.cx) * view.scale + width / 2, (y - view.cy) * view.scale + height / 2];
    const toWorld = (sx, sy) => [(sx - width / 2) / view.scale + view.cx, (sy - height / 2) / view.scale + view.cy];

    function readColors() {
      colors = {
        sea: cssVar("--map-sea"), land: cssVar("--map-land"), neighbour: cssVar("--map-neighbour"),
        line: "rgba(160, 205, 230, 0.16)", coast: "rgba(160, 205, 230, 0.38)", mark: cssVar("--coral"),
        dnone: cssVar("--dnone"), faint: "rgba(160, 205, 230, 0.18)",
        d: Object.fromEntries(DEPTH_BINS.map((b) => [b.token, cssVar(b.token)])),
      };
    }

    function bounds(list) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of list) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      return { minX, minY, maxX, maxY };
    }
    function fitTo(b, minSpan, pad) {
      const spanX = Math.max(b.maxX - b.minX, minSpan), spanY = Math.max(b.maxY - b.minY, minSpan);
      view.cx = (b.minX + b.maxX) / 2;
      view.cy = (b.minY + b.maxY) / 2;
      view.scale = Math.min(width / spanX, height / spanY) * (pad || 0.9);
    }
    function fitPoland() {
      fitTo(polandBounds, 0, options.pad);
      fitScale = view.scale;
      userMoved = false;
    }

    function setup(outline, lakes) {
      poland = outline.poland.map((ring) => ring.map(([lon, lat]) => project(lon, lat)));
      neighbours = outline.neighbours.map((ring) => ring.map(([lon, lat]) => project(lon, lat)));
      polandBounds = bounds(poland.flat());
      points = lakes.filter((l) => typeof l.lat === "number").map((lake) => {
        const [x, y] = project(lake.lon, lake.lat);
        return { lake, x, y };
      });
      const minX = polandBounds.minX, spanX = polandBounds.maxX - polandBounds.minX;
      for (const p of points) p.delay = (p.x - minX) / spanX;  // west to east sweep
      readColors();
      ready = true;
      resize();
    }

    function resize() {
      if (!ready) return;
      const rect = box.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const keep = view.scale / (fitScale || 1);
      const center = [view.cx, view.cy];
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      fitTo(polandBounds, 0, options.pad);
      fitScale = view.scale;
      if (userMoved) { view.scale = fitScale * keep; [view.cx, view.cy] = center; }
      if (options.focusOnSelected && selected) focus(selected);
      draw();
    }

    function path(ring) {
      ctx.beginPath();
      ring.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(x, y);
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
    }

    function draw(now) {
      if (!ready || !width) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.sea;
      ctx.fillRect(0, 0, width, height);
      ctx.lineJoin = "round";
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.neighbour;
      ctx.strokeStyle = colors.line;
      for (const ring of neighbours) { path(ring); ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = colors.land;
      ctx.strokeStyle = colors.coast;
      for (const ring of poland) { path(ring); ctx.fill("evenodd"); ctx.stroke(); }

      const zoom = view.scale / fitScale;
      const radius = Math.min((options.radius || 3.2) + (zoom - 1) * 0.5, 7);
      const visible = (sx, sy) => sx > -12 && sy > -12 && sx < width + 12 && sy < height + 12;

      if (matchSet) {
        ctx.fillStyle = colors.faint;
        for (const p of points) {
          if (matchSet.has(p.lake)) continue;
          const [sx, sy] = toScreen(p.x, p.y);
          if (!visible(sx, sy)) continue;
          ctx.beginPath(); ctx.arc(sx, sy, 1.4, 0, Math.PI * 2); ctx.fill();
        }
      }
      for (const p of points) {
        if (matchSet && !matchSet.has(p.lake)) continue;
        const alpha = reveal >= 1 ? 1 : Math.max(0, Math.min(1, (reveal * 1.6 - p.delay * 0.6) / 0.4));
        if (alpha <= 0) continue;
        const [sx, sy] = toScreen(p.x, p.y);
        if (!visible(sx, sy)) continue;
        const token = depthToken(p.lake.dmax);
        ctx.globalAlpha = alpha;
        if (token) {
          ctx.fillStyle = colors.d[token];
          if (options.glow && (token === "--d4" || token === "--d5")) {
            ctx.globalAlpha = alpha * 0.22;
            ctx.beginPath(); ctx.arc(sx, sy, radius + 3.5, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = alpha;
          }
          ctx.beginPath(); ctx.arc(sx, sy, radius, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.beginPath(); ctx.arc(sx, sy, radius - 0.6, 0, Math.PI * 2);
          ctx.lineWidth = 1.3; ctx.strokeStyle = colors.dnone; ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      for (const p of [hover, selected]) {
        if (!p) continue;
        const [sx, sy] = toScreen(p.x, p.y);
        ctx.beginPath(); ctx.arc(sx, sy, radius + 5, 0, Math.PI * 2);
        ctx.lineWidth = 2.5; ctx.strokeStyle = colors.mark; ctx.stroke();
      }
      if (options.ping && selected && now) {
        const t = ((now - pingStart) % 2400) / 2400;
        const [sx, sy] = toScreen(selected.x, selected.y);
        ctx.beginPath(); ctx.arc(sx, sy, radius + 5 + t * 26, 0, Math.PI * 2);
        ctx.globalAlpha = 1 - t; ctx.lineWidth = 2; ctx.strokeStyle = colors.mark; ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    function animateReveal() {
      if (reducedMotion.matches) { reveal = 1; draw(); return; }
      const start = performance.now();
      const step = (now) => {
        reveal = Math.min(1, (now - start) / 1600);
        draw();
        if (reveal < 1) requestAnimationFrame(step);
      };
      reveal = 0;
      requestAnimationFrame(step);
    }

    function startPing() {
      cancelAnimationFrame(pingFrame);
      if (!options.ping || reducedMotion.matches) { draw(); return; }
      pingStart = performance.now();
      const step = (now) => {
        if (box.offsetParent === null) return;  // view hidden: stop until shown again
        draw(now);
        pingFrame = requestAnimationFrame(step);
      };
      pingFrame = requestAnimationFrame(step);
    }

    function nearest(sx, sy, maxDistance) {
      let best = null, bestDistance = maxDistance * maxDistance;
      for (const p of points) {
        if (matchSet && !matchSet.has(p.lake)) continue;
        const [px, py] = toScreen(p.x, p.y);
        const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
        if (d < bestDistance) { best = p; bestDistance = d; }
      }
      return best;
    }

    function focus(p) {
      view.scale = fitScale * (options.focusZoom || 1);
      view.cx = p.x; view.cy = p.y;
      if (options.focusZoom === 1) { view.cx = (polandBounds.minX + polandBounds.maxX) / 2; view.cy = (polandBounds.minY + polandBounds.maxY) / 2; }
    }

    function setMatches(lakes, refit, regionFit) {
      matchSet = lakes ? new Set(lakes) : null;
      if (refit && ready) {
        const subset = points.filter((p) => !matchSet || matchSet.has(p.lake));
        if (regionFit && subset.length) { fitTo(bounds(subset.map((p) => [p.x, p.y])), 0.6); userMoved = true; }
        else fitPoland();
      }
      draw();
    }

    function setSelected(lake) {
      selected = lake ? points.find((p) => p.lake === lake) || null : null;
      if (options.focusOnSelected) {
        if (selected) focus(selected); else fitPoland();
        startPing();
      } else {
        draw();
      }
    }

    function zoomAt(factor, sx, sy) {
      const [wx, wy] = toWorld(sx, sy);
      view.scale = Math.min(Math.max(view.scale * factor, fitScale * 0.8), fitScale * 40);
      view.cx = wx - (sx - width / 2) / view.scale;
      view.cy = wy - (sy - height / 2) / view.scale;
      userMoved = true;
      draw();
    }

    function showTooltip(p, sx, sy) {
      if (!tooltip) return;
      if (!p) { tooltip.hidden = true; return; }
      const lake = p.lake;
      tooltip.replaceChildren(h("b", { text: lake.n }), h("br"),
        lake.dmaxT ? `Głębokość maks. ${lake.dmaxT} m` : "Głębokość: brak danych");
      tooltip.hidden = false;
      const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
      let left = sx + 14, top = sy - th - 10;
      if (left + tw > width - 6) left = sx - tw - 14;
      if (top < 6) top = sy + 14;
      tooltip.style.left = `${Math.max(6, left)}px`;
      tooltip.style.top = `${top}px`;
    }

    if (options.interactive) {
      const pointers = new Map();
      let drag = null, pinch = null;
      box.addEventListener("pointerdown", (event) => {
        if (event.target.closest("button")) return;
        box.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
        if (pointers.size === 1) drag = { x: event.offsetX, y: event.offsetY, cx: view.cx, cy: view.cy, moved: false };
        else if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
          drag = null;
        }
      });
      box.addEventListener("pointermove", (event) => {
        if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
        if (pinch && pointers.size === 2 && options.pannable) {
          const [a, b] = [...pointers.values()];
          const factor = Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance;
          zoomAt((pinch.scale * factor) / view.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
          return;
        }
        if (drag && options.pannable) {
          const dx = event.offsetX - drag.x, dy = event.offsetY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
          if (drag.moved) {
            box.classList.add("dragging");
            view.cx = drag.cx - dx / view.scale;
            view.cy = drag.cy - dy / view.scale;
            userMoved = true;
            showTooltip(null);
            draw();
          }
          return;
        }
        if (event.pointerType === "mouse") {
          const p = nearest(event.offsetX, event.offsetY, 10);
          if (p !== hover) { hover = p; draw(); }
          showTooltip(p, event.offsetX, event.offsetY);
          box.style.cursor = p ? "pointer" : "";
        }
      });
      const end = (event) => {
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinch = null;
        if (drag && !drag.moved && event.type === "pointerup") {
          const p = nearest(event.offsetX, event.offsetY, event.pointerType === "mouse" ? 10 : 18);
          if (p && options.onPick) options.onPick(p.lake);
        }
        if (pointers.size === 0) { drag = null; box.classList.remove("dragging"); }
      };
      box.addEventListener("pointerup", end);
      box.addEventListener("pointercancel", end);
      box.addEventListener("pointerleave", () => { if (hover) { hover = null; draw(); } showTooltip(null); });
    }

    if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(box);
    else window.addEventListener("resize", resize);

    return { setup, resize, setMatches, setSelected, zoomAt, animateReveal, startPing,
      reset: () => { fitPoland(); draw(); }, size: () => [width, height] };
  }

  const goToLake = (lake) => { location.hash = "j" + lake.id; };

  const heroMap = createMap($("#hero-map").parentElement, $("#hero-map"), $("#hero-tooltip"),
    { interactive: true, pannable: false, glow: true, radius: 2.6, pad: 0.94, onPick: goToLake });
  const exploreMap = createMap($("#canvas-box"), $("#map"), $("#tooltip"),
    { interactive: true, pannable: true, glow: true, radius: 3.2, onPick: goToLake });
  let locatorMap = null;

  // ------------------------------------------------------------------ routing
  let currentView = null;
  let exploreScroll = 0;

  function showView(name) {
    if (currentView === "jeziora") exploreScroll = window.scrollY;
    const ids = { start: "#view-start", jeziora: "#view-explore", jezioro: "#view-lake", polowy: "#view-catches" };
    for (const [key, id] of Object.entries(ids)) $(id).hidden = key !== name;
    document.querySelectorAll("[data-nav]").forEach((link) => {
      const active = link.dataset.nav === name || (name === "jezioro" && link.dataset.nav === "jeziora");
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
    const previous = currentView;
    currentView = name;
    if (name === "jeziora") {
      exploreMap.resize();
      window.scrollTo(0, previous === "jezioro" ? exploreScroll : 0);
    } else {
      window.scrollTo(0, 0);
    }
    if (name === "start") heroMap.resize();
  }

  function applyHash() {
    if (!state.data) return;
    const hash = location.hash.replace(/^#/, "");
    const lakeMatch = /^j(\d+)$/.exec(hash);
    if (lakeMatch && state.byId.has(Number(lakeMatch[1]))) {
      showView("jezioro");
      renderLake(state.byId.get(Number(lakeMatch[1])));
      return;
    }
    if (hash === "jeziora") { showView("jeziora"); return; }
    if (hash === "polowy" && window.patofishing.catchesEnabled) { showView("polowy"); return; }
    showView("start");
  }

  // ------------------------------------------------------------------ loading
  async function load() {
    try {
      const [lakesResponse, mapResponse] = await Promise.all([fetch("data/lakes.json"), fetch("data/poland.json")]);
      if (!lakesResponse.ok || !mapResponse.ok) throw new Error("HTTP");
      init(await lakesResponse.json(), await mapResponse.json());
    } catch (error) {
      $("#facts").replaceChildren(h("p", { class: "muted", text: "Nie udało się wczytać danych o jeziorach. Sprawdź połączenie z internetem i odśwież stronę." }));
    }
  }

  function init(data, outline) {
    state.data = data;
    for (const species of data.species) state.speciesByKey.set(species.key, species);
    state.lakes = data.lakes.map((lake) => {
      lake.search = fold(lake.n + " " + lake.t);
      lake.voivNames = (lake.w || []).map((i) => data.voivodeships[i]);
      return lake;
    });
    for (const lake of state.lakes) state.byId.set(lake.id, lake);
    state.maxDepth = state.lakes.filter((l) => typeof l.dmax === "number").sort((a, b) => b.dmax - a.dmax)[0] || null;
    state.outline = outline;

    renderStart(data);
    buildFilters(data);
    heroMap.setup(outline, state.lakes);
    exploreMap.setup(outline, state.lakes);
    applyFilters({ refit: true });
    $("#legend-items").replaceChildren(...legendItems());

    window.addEventListener("hashchange", applyHash);
    applyHash();
    if (currentView === "start") heroMap.animateReveal();
    resolveReady();
  }

  // ------------------------------------------------------------------ start view
  function renderStart(data) {
    const stats = data.stats;
    $("#hero-count").textContent = `${numberFmt.format(stats.lakes)} jezior i zbiorników`;
    $("#facts").replaceChildren(
      h("div", { class: "fact" }, h("b", { class: "num", text: numberFmt.format(stats.with_depth) }), h("span", { text: "z podaną głębokością" })),
      h("div", { class: "fact" }, h("b", { class: "num", text: numberFmt.format(stats.with_fish) }), h("span", { text: "z rybami w artykule" })),
      h("div", { class: "fact" }, h("b", { class: "num", text: String(data.species.filter((s) => s.count > 0 && !/\(bez podania/.test(s.name)).length) }), h("span", { text: "rozpoznanych gatunków" })));
    $("#updated").textContent = `Stan danych: ${formatDate(data.generated)}` +
      (data.next_update ? `. Następna aktualizacja: ${formatDate(data.next_update)}.` : ".");
    $("#hero-legend").replaceChildren(...legendItems());

    const top = (list, field, n) => list.filter((l) => typeof l[field] === "number").sort((a, b) => b[field] - a[field]).slice(0, n);
    const byFish = state.lakes.filter((l) => l.fish && l.fish.length)
      .sort((a, b) => b.fish.length - a.fish.length || collator.compare(a.n, b.n)).slice(0, 5);
    const rankings = [
      { accent: "--sky", eyebrow: "Głębokość maksymalna", title: "Najgłębsze", sort: "depth",
        rows: top(state.lakes, "dmax", 5).map((l) => [l, `${l.dmaxT} m`]) },
      { accent: "--aqua", eyebrow: "Powierzchnia", title: "Największe", sort: "area",
        rows: top(state.lakes, "area", 5).map((l) => [l, l.areaT]) },
      { accent: "--amber", eyebrow: "Gatunki wymienione w artykule", title: "Najwięcej ryb", sort: "fish",
        rows: byFish.map((l) => [l, `${l.fish.length} ${plural(l.fish.length, "gatunek", "gatunki", "gatunków")}`]) },
    ];
    $("#rankings").replaceChildren(...rankings.map((r) => h("article", { class: "card ranking", style: `--accent: var(${r.accent})` },
      h("div", null, h("p", { class: "eyebrow", text: r.eyebrow }), h("h3", { text: r.title })),
      h("ol", null, ...r.rows.map(([lake, value], i) => h("li", null, h("button", { type: "button", onclick: () => goToLake(lake) },
        h("span", { class: "rank num", text: String(i + 1) }),
        h("span", { class: "r-name", text: lake.n }),
        h("span", { class: "r-value num", text: value }))))),
      h("button", { type: "button", class: "linklike more-link", onclick: () => openExplorer({ sort: r.sort }) },
        "Zobacz pełną listę"))));

    const species = data.species.filter((s) => s.count > 0 && !/\(bez podania/.test(s.name))
      .sort((a, b) => b.count - a.count).slice(0, 8);
    $("#species-grid").replaceChildren(...species.map((s, i) => h("button", {
      type: "button", class: "species-tile", style: `--accent: var(${ACCENTS[i % ACCENTS.length]})`,
      onclick: () => openExplorer({ fish: s.key }),
    },
    h("span", { class: "sp-name", text: s.name }),
    h("span", { class: "sp-latin", text: s.latin }),
    h("span", { class: "sp-count" }, "w artykułach o ", h("b", { class: "num", text: numberFmt.format(s.count) }), ` ${plural(s.count, "akwenie", "akwenach", "akwenach")}`))));

    setupHeroSearch();
  }

  function searchLakes(query, limit) {
    const q = fold(query.trim());
    if (!q) return [];
    const starts = [], contains = [];
    for (const lake of state.lakes) {
      const name = fold(lake.n);
      if (name.startsWith(q)) starts.push(lake);
      else if (lake.search.includes(q)) contains.push(lake);
    }
    const order = (a, b) => (b.dmax || 0) - (a.dmax || 0) || collator.compare(a.n, b.n);
    return { total: starts.length + contains.length, items: starts.sort(order).concat(contains.sort(order)).slice(0, limit) };
  }

  function setupHeroSearch() {
    const input = $("#hero-q");
    const list = $("#hero-suggest");
    let items = [], active = -1;
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
    const choose = (index) => {
      const item = items[index];
      if (!item) return;
      if (item.all) openExplorer({ q: input.value });
      else goToLake(item.lake);
      close();
    };
    const render = () => {
      const result = searchLakes(input.value, 6);
      if (!result.items || !input.value.trim()) { close(); return; }
      items = result.items.map((lake) => ({ lake }));
      if (result.total > result.items.length || !result.items.length) items.push({ all: true, total: result.total });
      list.replaceChildren(...items.map((item, i) => h("li", { role: "presentation" }, h("button", {
        type: "button", role: "option", id: "sg-" + i, "aria-selected": i === active ? "true" : "false",
        onmousedown: (e) => e.preventDefault(), onclick: () => choose(i),
      }, item.all
        ? h("span", { class: "s-all", text: item.total ? `Pokaż wszystkie wyniki (${item.total})` : "Brak jeziora o tej nazwie" })
        : [h("span", { class: "s-name", text: item.lake.n }),
          h("span", { class: "s-meta", text: [item.lake.voivNames.join(", "), item.lake.dmaxT ? `${item.lake.dmaxT} m` : ""].filter(Boolean).join(" · ") })]))));
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };
    input.addEventListener("input", () => { active = -1; render(); });
    input.addEventListener("focus", () => { if (input.value.trim()) render(); });
    input.addEventListener("blur", () => setTimeout(close, 120));
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (list.hidden) render();
        event.preventDefault();
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        render();
        input.setAttribute("aria-activedescendant", "sg-" + active);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (active >= 0) choose(active);
        else if (input.value.trim()) { openExplorer({ q: input.value }); close(); }
      } else if (event.key === "Escape") {
        close();
      }
    });
  }

  // ------------------------------------------------------------------ explorer
  function buildFilters(data) {
    const voivSelect = $("#f-voiv");
    data.voivodeships.map((name, index) => ({ name, index }))
      .sort((a, b) => collator.compare(a.name, b.name))
      .forEach(({ name, index }) => voivSelect.append(h("option", { value: String(index), text: name })));
    const fishSelect = $("#f-fish");
    data.species.filter((s) => s.count > 0).sort((a, b) => collator.compare(a.name, b.name))
      .forEach((s) => fishSelect.append(h("option", { value: s.key, text: `${s.name} (${s.count})` })));

    let timer = null;
    $("#f-q").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = fold(e.target.value.trim()); applyFilters(); }, 120); });
    $("#f-voiv").addEventListener("change", (e) => { state.voiv = e.target.value; applyFilters({ refit: true }); });
    $("#f-kind").addEventListener("change", (e) => { state.kind = e.target.value; applyFilters(); });
    $("#f-fish").addEventListener("change", (e) => { state.fish = e.target.value; applyFilters(); });
    $("#f-onlyfish").addEventListener("change", (e) => { state.onlyFish = e.target.checked; applyFilters(); });
    $("#f-sort").addEventListener("change", (e) => { state.sort = e.target.value; applyFilters(); });
    $("#clear-filters").addEventListener("click", () => openExplorer({}));
    $("#more-btn").addEventListener("click", () => { state.shown += PAGE; renderList(); });
    $("#zoom-in").addEventListener("click", () => { const [w, hgt] = exploreMap.size(); exploreMap.zoomAt(1.6, w / 2, hgt / 2); });
    $("#zoom-out").addEventListener("click", () => { const [w, hgt] = exploreMap.size(); exploreMap.zoomAt(1 / 1.6, w / 2, hgt / 2); });
    $("#zoom-reset").addEventListener("click", () => exploreMap.reset());
    const setMode = (mode) => {
      $("#explore-grid").dataset.mode = mode;
      $("#mode-list").setAttribute("aria-pressed", String(mode === "list"));
      $("#mode-map").setAttribute("aria-pressed", String(mode === "map"));
      if (mode === "map") exploreMap.resize();
    };
    $("#mode-list").addEventListener("click", () => setMode("list"));
    $("#mode-map").addEventListener("click", () => setMode("map"));
  }

  function openExplorer(preset) {
    const q = preset.q || "";
    Object.assign(state, { q: fold(q.trim()), voiv: "", kind: "", fish: preset.fish || "", onlyFish: false, sort: preset.sort || "name" });
    $("#f-q").value = q;
    $("#f-voiv").value = "";
    $("#f-kind").value = "";
    $("#f-fish").value = state.fish;
    $("#f-onlyfish").checked = false;
    $("#f-sort").value = state.sort;
    applyFilters({ refit: true });
    if (location.hash === "#jeziora") showView("jeziora");
    else { currentView = null; location.hash = "jeziora"; }
  }

  function applyFilters(options) {
    const voiv = state.voiv === "" ? null : Number(state.voiv);
    state.filtered = state.lakes.filter((lake) =>
      (!state.q || lake.search.includes(state.q)) &&
      (voiv === null || (lake.w || []).includes(voiv)) &&
      (!state.kind || lake.k.includes(state.kind)) &&
      (!state.fish || (lake.fish || []).includes(state.fish)) &&
      (!state.onlyFish || (lake.fish && lake.fish.length)));
    const byName = (a, b) => collator.compare(a.n, b.n) || collator.compare(a.t, b.t);
    const desc = (field) => (a, b) => {
      const av = a[field], bv = b[field];
      if (av === undefined && bv === undefined) return byName(a, b);
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return bv - av || byName(a, b);
    };
    const sorters = { name: byName, depth: desc("dmax"), area: desc("area"),
      fish: (a, b) => ((b.fish || []).length - (a.fish || []).length) || byName(a, b) };
    state.filtered.sort(sorters[state.sort] || byName);
    state.shown = PAGE;
    renderList();
    exploreMap.setMatches(state.filtered, options && options.refit, state.voiv !== "");
  }

  function lakeCard(lake) {
    const token = depthToken(lake.dmax);
    const kind = lake.k.includes("j") ? "jezioro" : "zbiornik sztuczny";
    const fishCount = (lake.fish || []).length;
    const tags = [];
    if (fishCount) tags.push(h("span", { class: "tag", style: "--tag: var(--amber)" }, h("i"), `${fishCount} ${plural(fishCount, "gatunek ryb", "gatunki ryb", "gatunków ryb")}`));
    if (lake.areaT && lake.area !== undefined) tags.push(h("span", { class: "tag", style: "--tag: var(--aqua)" }, h("i"), lake.areaT));
    if (lake.ftype) tags.push(h("span", { class: "tag", style: "--tag: var(--sand)" }, h("i"), `typ ${lake.ftype[0]}`));
    return h("li", null, h("button", { type: "button", class: "lake-card", onclick: () => goToLake(lake) },
      h("div", null, h("div", { class: "lc-name", text: lake.n }), h("div", { class: "lc-sub", text: `${kind} · ${lake.voivNames.join(", ")}` })),
      h("div", { class: "lc-depth" },
        h("b", { class: "num" }, h("i", { class: token ? "dot" : "dot none", style: token ? `background: var(${token})` : null, "aria-hidden": "true" }), lake.dmaxT ? `${lake.dmaxT} m` : "brak"),
        h("span", { text: "GŁĘB. MAKS." })),
      tags.length ? h("div", { class: "lc-tags" }, ...tags) : null));
  }

  function renderList() {
    const total = state.filtered.length;
    $("#result-count").textContent = `${numberFmt.format(total)} ${plural(total, "akwen", "akweny", "akwenów")}`;
    $("#clear-filters").hidden = !(state.q || state.voiv || state.kind || state.fish || state.onlyFish);
    if (!total) {
      $("#results").replaceChildren(h("li", { class: "card empty" },
        h("p", { text: "Żaden akwen nie spełnia tych warunków. Zmień filtr albo wyczyść wyszukiwanie." }),
        h("button", { class: "btn", type: "button", onclick: () => openExplorer({}), text: "Wyczyść filtry" })));
      $("#more").hidden = true;
      return;
    }
    $("#results").replaceChildren(...state.filtered.slice(0, state.shown).map(lakeCard));
    $("#more").hidden = state.shown >= total;
    if (!$("#more").hidden) $("#more-btn").textContent = `Pokaż kolejne ${Math.min(PAGE, total - state.shown)}`;
  }

  // ------------------------------------------------------------------ lake page
  function stat(label, accent, value, unit, note) {
    return h("div", { class: "stat", style: `--accent: var(${accent})` },
      h("span", { class: "st-label" }, h("i", { "aria-hidden": "true" }), label),
      value ? h("span", { class: "st-value num" }, value, unit ? h("small", { text: unit }) : null)
        : h("span", { class: "st-value none", text: "brak danych" }),
      note ? h("span", { class: "st-note", text: note }) : null);
  }

  const quote = (text, footer, extra) => h("blockquote", { class: "quote" + (extra ? " " + extra : "") },
    h("p", { text: `„${text}”` }), footer ? h("footer", { text: footer }) : null);

  function renderLake(lake) {
    state.selected = lake;
    document.title = `${lake.n} · patofishing`;
    const kind = lake.k.includes("j") && lake.k.includes("z") ? "Jezioro i zbiornik sztuczny"
      : lake.k.includes("j") ? "Jezioro" : "Zbiornik sztuczny";
    const voiv = lake.voivNames.length > 1 ? `Województwa ${lake.voivNames.join(" i ")}` : `Województwo ${lake.voivNames[0] || ""}`;

    const locator = h("figure", { class: "locator", "aria-label": "Położenie jeziora na mapie Polski" }, h("canvas", { role: "img", "aria-label": `Położenie: ${lake.n}` }));
    $("#lake-hero").replaceChildren(
      h("div", { class: "rise" },
        h("a", { class: "back", href: "#jeziora" }, icon("back"), "Wszystkie jeziora"),
        h("p", { class: "eyebrow", text: kind }),
        h("h1", { text: lake.n }),
        h("p", { class: "lh-sub", text: voiv }),
        lake.t !== lake.n ? h("p", { class: "lh-title", text: `Artykuł: ${lake.t}` }) : null),
      typeof lake.lat === "number" ? locator : h("div"));

    const blocks = [];
    blocks.push(h("div", { class: "stats rise" },
      stat("Głębokość maks.", "--sky", lake.dmaxT, "m", lake.dmaxQ ? "z treści artykułu" : null),
      stat("Głębokość średnia", "--aqua", lake.dmeanT, "m", lake.dmeanQ ? "z treści artykułu" : null),
      stat("Powierzchnia", "--reed", lake.areaT, null, lake.areaT && lake.area === undefined ? "źródło nie podaje jednostki" : null),
      stat("Lustro wody", "--amber", lake.elevT, "m n.p.m.")));

    if (lake.warn) {
      blocks.push(h("div", { class: "warn" }, h("b", { text: "Uwaga na dane" }), ...lake.warn.map((w) => h("p", { text: w }))));
    }

    // left column: fish
    const species = (lake.fish || []).map((key) => state.speciesByKey.get(key)).filter(Boolean)
      .sort((a, b) => collator.compare(a.name, b.name));
    const fishCard = h("article", { class: "card panel-pad" });
    const head = h("div", { class: "panel-head" }, h("h2", { text: species.length ? `Ryby (${species.length})` : "Ryby" }));
    if (lake.ftype) head.append(h("span", { class: "ftype", text: `Typ rybacki: ${lake.ftype.join(", ")}` }));
    fishCard.append(head);
    if (species.length) {
      fishCard.append(
        h("p", { class: "muted", text: "Gatunki wymienione w artykule w Wikipedii." }),
        h("ul", { class: "species" }, ...species.map((s) => h("li", null, h("b", { text: s.name }), s.latin ? h("i", { text: s.latin }) : null))),
        h("details", null, h("summary", { text: `Skąd to wiemy: ${lake.ev.length} ${plural(lake.ev.length, "zdanie", "zdania", "zdań")} z artykułu` }),
          ...lake.ev.map((e) => {
            const names = e.sp.map((key) => (state.speciesByKey.get(key) || {}).name).filter(Boolean).join(", ");
            return quote(e.s, `${e.h ? `Sekcja „${e.h}” · ` : ""}wymienione: ${names}`);
          })));
    } else {
      fishCard.append(h("p", { class: "muted", text: "Artykuł w Wikipedii nie wymienia ryb żyjących w tym akwenie. O rybostan zapytaj użytkownika rybackiego tej wody, na przykład okręg PZW albo gospodarstwo rybackie." }));
    }
    if (lake.ftypeQ && !species.length) {
      fishCard.append(h("details", null, h("summary", { text: "Skąd jest typ rybacki" }), ...lake.ftypeQ.map((q) => quote(q))));
    } else if (lake.ftypeQ) {
      fishCard.append(h("details", null, h("summary", { text: "Skąd jest typ rybacki" }), ...lake.ftypeQ.map((q) => quote(q))));
    }
    if (lake.notes) {
      fishCard.append(h("details", null,
        h("summary", { text: `Wzmianki, których nie liczymy (${lake.notes.length})` }),
        h("p", { class: "muted", text: "Te zdania mówią o przeszłości, o nieudanym zarybieniu, o przepisach albo o innych wodach, więc nie wynika z nich, że ryba żyje tu dziś." }),
        ...lake.notes.map((n) => quote(n, null, "note"))));
    }
    const catchesBox = h("article", { class: "card panel-pad", id: "lake-catches", hidden: true });

    // right column: depth gauge and sources
    const right = [];
    if (typeof lake.dmax === "number" && state.maxDepth) {
      const max = state.maxDepth.dmax;
      const width = Math.min(100, (lake.dmax / max) * 100);
      const meanPos = typeof lake.dmean === "number" ? Math.min(100, (lake.dmean / max) * 100) : null;
      const gauge = h("article", { class: "card panel-pad gauge" },
        h("h2", { text: "Głębokość" }),
        h("p", { class: "muted", text: `Na tle najgłębszego akwenu w bazie: ${state.maxDepth.n}, ${state.maxDepth.dmaxT} m.` }),
        h("div", { class: "gauge-track", role: "img", "aria-label": `Głębokość maksymalna ${lake.dmaxT} m${lake.dmeanT ? `, średnia ${lake.dmeanT} m` : ""}` },
          h("div", { class: "gauge-fill", style: `--w: ${width}%` }),
          meanPos !== null ? h("div", { class: "gauge-mean", style: `--m: calc(${meanPos}% - 1px)` }) : null),
        h("div", { class: "gauge-scale num" }, h("span", { text: "0 m" }), h("span", { text: `${state.maxDepth.dmaxT} m` })),
        h("div", { class: "gauge-keys" },
          h("span", null, h("i", { style: "background: var(--d4)" }), `maksymalna: ${lake.dmaxT} m`),
          meanPos !== null ? h("span", null, h("i", { style: "background: var(--amber)" }), `średnia: ${lake.dmeanT} m`) : null));
      const depthQuotes = [...new Set([lake.dmaxQ, lake.dmeanQ].filter(Boolean))];
      if (depthQuotes.length) gauge.append(h("details", null, h("summary", { text: "Zdanie, z którego pochodzi głębokość" }), ...depthQuotes.map((q) => quote(q))));
      right.push(gauge);
    }
    right.push(h("article", { class: "card panel-pad" },
      h("h2", { text: "Źródła" }),
      typeof lake.lat === "number" ? h("p", { class: "coords num", text: formatCoord(lake.lat, lake.lon) }) : null,
      h("div", { class: "source-links" },
        h("a", { class: "btn btn-small", href: wikiUrl(lake.t), target: "_blank", rel: "noopener" }, "Artykuł w Wikipedii", icon("out")),
        typeof lake.lat === "number" ? h("a", { class: "btn btn-small", href: osmUrl(lake.lat, lake.lon), target: "_blank", rel: "noopener" }, "OpenStreetMap", icon("out")) : null),
      h("p", { class: "source-line", text: `Dane z artykułu „${lake.t}” w polskiej Wikipedii${lake.rev ? ` (wersja z ${formatDate(lake.rev)})` : ""}, licencja CC BY-SA 4.0.` })));

    blocks.push(h("div", { class: "lake-columns" },
      h("div", { class: "rise" }, fishCard, catchesBox),
      h("div", { class: "rise" }, ...right)));
    $("#lake-body").replaceChildren(...blocks);

    if (typeof lake.lat === "number") {
      const canvas = locator.querySelector("canvas");
      locatorMap = createMap(locator, canvas, null, { interactive: false, focusOnSelected: true, focusZoom: 1, radius: 2, ping: true, pad: 0.92 });
      locatorMap.setup(state.outline, state.lakes);
      locatorMap.setMatches([], false);
      locatorMap.setSelected(lake);
    }
    lakeListeners.forEach((fn) => { try { fn(lake); } catch (error) { /* a listener must not break the page */ } });
  }

  load();
})();

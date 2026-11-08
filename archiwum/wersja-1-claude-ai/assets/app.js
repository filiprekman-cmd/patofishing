/* patofishing: lake finder, depth chart of Poland and lake record sheet. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ helpers
  const $ = (selector, root) => (root || document).querySelector(selector);
  const collator = new Intl.Collator("pl", { sensitivity: "base", numeric: true });
  const numberFmt = new Intl.NumberFormat("pl-PL");
  const MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia",
    "września", "października", "listopada", "grudnia"];

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
        else if (key === "style") el.setAttribute("style", value);
        else el.setAttribute(key, value === true ? "" : value);
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
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

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function wikiUrl(title) {
    return "https://pl.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_"));
  }

  function osmUrl(lat, lon) {
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`;
  }

  function formatCoord(lat, lon) {
    const f = (v) => v.toFixed(4).replace(".", ",");
    return `${f(lat)}° N, ${f(lon)}° E`;
  }

  const DEPTH_BINS = [
    { max: 5, label: "poniżej 5 m", token: "--d1" },
    { max: 10, label: "5 do 10 m", token: "--d2" },
    { max: 20, label: "10 do 20 m", token: "--d3" },
    { max: 40, label: "20 do 40 m", token: "--d4" },
    { max: Infinity, label: "40 m i więcej", token: "--d5" },
  ];
  function depthToken(depth) {
    if (typeof depth !== "number") return null;
    return DEPTH_BINS.find((bin) => depth < bin.max).token;
  }

  // ------------------------------------------------------------------ state
  const state = {
    data: null,
    lakes: [],
    byId: new Map(),
    speciesByKey: new Map(),
    filtered: [],
    selected: null,
    shown: 100,
    q: "",
    voiv: "",
    kind: "",
    fish: "",
    onlyFish: false,
    sort: "name",
  };
  const PAGE = 100;

  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const lakeListeners = [];

  window.patofishing = {
    ready,
    state,
    fold,
    formatDate,
    plural,
    h,
    numberFmt,
    collator,
    selectLake: (id, options) => selectLake(state.byId.get(Number(id)) || null, options),
    onLakeSelected: (fn) => lakeListeners.push(fn),
    showView,
    applyHash: () => applyHash(),
    catchesEnabled: false,
  };

  // ------------------------------------------------------------------ views (hash routing)
  function showView(name) {
    const catches = name === "polowy";
    $("#view-lakes").hidden = catches;
    $("#view-catches").hidden = !catches;
    $("#intro").hidden = catches;
    document.querySelectorAll("[data-nav]").forEach((link) => {
      if (link.dataset.nav === (catches ? "polowy" : "jeziora")) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    if (!catches) map.resize();
  }

  function applyHash() {
    const hash = location.hash.replace(/^#/, "");
    if (hash === "polowy" && window.patofishing.catchesEnabled) {
      showView("polowy");
      window.scrollTo(0, 0);
      return;
    }
    showView("jeziora");
    const match = /^j(\d+)$/.exec(hash);
    if (match && state.byId.has(Number(match[1]))) {
      const lake = state.byId.get(Number(match[1]));
      if (lake !== state.selected) selectLake(lake, { fromHash: true, center: true });
    }
  }

  // ------------------------------------------------------------------ data loading
  async function load() {
    try {
      const [lakesResponse, mapResponse] = await Promise.all([fetch("data/lakes.json"), fetch("data/poland.json")]);
      if (!lakesResponse.ok || !mapResponse.ok) throw new Error("HTTP");
      const data = await lakesResponse.json();
      const outline = await mapResponse.json();
      init(data, outline);
    } catch (error) {
      const message = "Nie udało się wczytać danych o jeziorach. Sprawdź połączenie z internetem i odśwież stronę.";
      $("#results").replaceChildren(h("li", { class: "empty", text: message }));
      $("#result-count").textContent = "";
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

    renderIntro(data);
    buildFilters(data);
    map.setup(outline, state.lakes);
    applyFilters({ refit: true });

    window.addEventListener("hashchange", applyHash);
    const hash = location.hash.replace(/^#/, "");
    if (/^j\d+$/.test(hash) || hash === "polowy") {
      applyHash();
    } else {
      // Open on the deepest lake in the data, so the record sheet shows real content at rest.
      const deepest = state.lakes.filter((l) => typeof l.dmax === "number").sort((a, b) => b.dmax - a.dmax)[0];
      if (deepest) selectLake(deepest, { silent: true });
    }
    resolveReady();
  }

  function renderIntro(data) {
    const stats = data.stats;
    const facts = $("#facts");
    facts.replaceChildren(
      h("span", null, h("b", { class: "num", text: numberFmt.format(stats.lakes) }), "jezior i zbiorników"),
      h("span", null, h("b", { class: "num", text: numberFmt.format(stats.with_depth) }), "z podaną głębokością"),
      h("span", null, h("b", { class: "num", text: numberFmt.format(stats.with_fish) }), "z informacją o rybach"),
      h("span", null, "Stan danych: ", h("strong", { text: formatDate(data.generated) })),
      data.next_update ? h("span", null, "Następna aktualizacja: ", h("strong", { text: formatDate(data.next_update) })) : null,
    );
  }

  // ------------------------------------------------------------------ filters and list
  function buildFilters(data) {
    const voivSelect = $("#f-voiv");
    data.voivodeships
      .map((name, index) => ({ name, index }))
      .sort((a, b) => collator.compare(a.name, b.name))
      .forEach(({ name, index }) => voivSelect.append(h("option", { value: String(index), text: name })));

    const fishSelect = $("#f-fish");
    data.species
      .filter((s) => s.count > 0)
      .sort((a, b) => collator.compare(a.name, b.name))
      .forEach((s) => fishSelect.append(h("option", { value: s.key, text: `${s.name} (${s.count})` })));

    let searchTimer = null;
    $("#f-q").addEventListener("input", (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = fold(event.target.value.trim()); applyFilters(); }, 120);
    });
    $("#f-voiv").addEventListener("change", (event) => { state.voiv = event.target.value; applyFilters({ refit: true }); });
    $("#f-kind").addEventListener("change", (event) => { state.kind = event.target.value; applyFilters(); });
    $("#f-fish").addEventListener("change", (event) => { state.fish = event.target.value; applyFilters(); });
    $("#f-onlyfish").addEventListener("change", (event) => { state.onlyFish = event.target.checked; applyFilters(); });
    $("#f-sort").addEventListener("change", (event) => { state.sort = event.target.value; applyFilters(); });
    $("#clear-filters").addEventListener("click", clearFilters);
  }

  function clearFilters() {
    $("#f-q").value = "";
    $("#f-voiv").value = "";
    $("#f-kind").value = "";
    $("#f-fish").value = "";
    $("#f-onlyfish").checked = false;
    Object.assign(state, { q: "", voiv: "", kind: "", fish: "", onlyFish: false });
    applyFilters({ refit: true });
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
    const sorters = {
      name: byName,
      depth: desc("dmax"),
      area: desc("area"),
      fish: (a, b) => ((b.fish || []).length - (a.fish || []).length) || byName(a, b),
    };
    state.filtered.sort(sorters[state.sort] || byName);
    state.shown = PAGE;
    renderList();
    map.setMatches(state.filtered, options && options.refit);
  }

  function lakeSubline(lake) {
    const kind = lake.k.includes("j") ? "jezioro" : "zbiornik sztuczny";
    const parts = [kind, lake.voivNames.join(", ")];
    const fishCount = (lake.fish || []).length;
    if (fishCount) parts.push(`${fishCount} ${plural(fishCount, "gatunek ryb", "gatunki ryb", "gatunków ryb")}`);
    return parts.join(" · ");
  }

  function renderList() {
    const list = $("#results");
    const total = state.filtered.length;
    $("#result-count").textContent = `${numberFmt.format(total)} ${plural(total, "akwen", "akweny", "akwenów")}`;
    $("#clear-filters").hidden = !(state.q || state.voiv || state.kind || state.fish || state.onlyFish);

    if (!total) {
      list.replaceChildren(h("li", { class: "empty" },
        h("p", { text: "Żaden akwen nie spełnia tych warunków. Zmień filtr albo wyczyść wyszukiwanie." }),
        h("button", { class: "btn", type: "button", onclick: clearFilters, text: "Wyczyść filtry" })));
      $("#more").hidden = true;
      return;
    }
    const rows = state.filtered.slice(0, state.shown).map((lake) => {
      const token = depthToken(lake.dmax);
      const dot = h("i", { class: token ? "dot" : "dot none", style: token ? `background: var(${token})` : null, "aria-hidden": "true" });
      return h("li", null, h("button", {
        class: "lake-row",
        type: "button",
        "data-id": String(lake.id),
        "aria-current": state.selected === lake ? "true" : null,
        onclick: () => selectLake(lake, { center: true, scroll: window.matchMedia("(max-width: 900px)").matches }),
      },
      h("span", { class: "name", text: lake.n }),
      h("span", { class: "sub", text: lakeSubline(lake) }),
      h("span", { class: "depth num" }, dot, lake.dmaxT ? `${lake.dmaxT} m` : "brak",
        h("small", { text: "głęb. maks." }))));
    });
    list.replaceChildren(...rows);
    const more = $("#more");
    more.hidden = state.shown >= total;
    if (!more.hidden) {
      const next = Math.min(PAGE, total - state.shown);
      $("#more-btn").textContent = `Pokaż kolejne ${next}`;
    }
  }

  $("#more-btn").addEventListener("click", () => { state.shown += PAGE; renderList(); });

  // ------------------------------------------------------------------ selection and record sheet
  function selectLake(lake, options) {
    options = options || {};
    state.selected = lake;
    document.querySelectorAll(".lake-row[aria-current]").forEach((row) => row.removeAttribute("aria-current"));
    if (lake) {
      const row = document.querySelector(`.lake-row[data-id="${lake.id}"]`);
      if (row) row.setAttribute("aria-current", "true");
    }
    renderSheet(lake);
    map.setSelected(lake, options.center);
    if (lake && !options.silent && !options.fromHash) {
      const hash = "j" + lake.id;
      if (location.hash.replace(/^#/, "") !== hash) {
        try { history.replaceState(null, "", "#" + hash); } catch (error) { /* some embedded views refuse it */ }
      }
    }
    if (lake && options.scroll) $("#sheet").scrollIntoView({ behavior: "smooth", block: "start" });
    lakeListeners.forEach((fn) => { try { fn(lake); } catch (error) { /* a listener must not break the page */ } });
  }

  function measure(label, value, note, small) {
    return h("div", null,
      h("dt", { text: label }),
      h("dd", { class: small ? "small" : null }, value || "brak danych", note ? h("span", { class: "src", text: " " + note }) : null));
  }

  function quote(text, footer) {
    return h("blockquote", { class: "quote" }, h("p", { text: `„${text}”` }), footer ? h("footer", { text: footer }) : null);
  }

  function renderSheet(lake) {
    const sheet = $("#sheet");
    if (!lake) {
      sheet.replaceChildren(h("p", { class: "sheet-placeholder", text: "Wybierz akwen z listy albo kliknij punkt na mapie, żeby zobaczyć jego głębokość i ryby." }));
      return;
    }
    const species = (lake.fish || []).map((key) => state.speciesByKey.get(key)).filter(Boolean)
      .sort((a, b) => collator.compare(a.name, b.name));
    const kind = lake.k.includes("j") && lake.k.includes("z") ? "Jezioro i zbiornik sztuczny"
      : lake.k.includes("j") ? "Jezioro" : "Zbiornik sztuczny";
    const voiv = lake.voivNames.length > 1 ? `województwa ${lake.voivNames.join(" i ")}` : `województwo ${lake.voivNames[0] || ""}`;

    const head = h("div", { class: "sheet-head" },
      h("h2", { id: "sheet-title", text: lake.n }),
      h("p", { text: `${kind} · ${voiv}` }));

    const measures = h("dl", { class: "measures" },
      measure("Głębokość maksymalna", lake.dmaxT ? `${lake.dmaxT} m` : null, lake.dmaxQ ? "(z treści artykułu)" : null),
      measure("Głębokość średnia", lake.dmeanT ? `${lake.dmeanT} m` : null, lake.dmeanQ ? "(z treści artykułu)" : null),
      measure("Powierzchnia", lake.areaT ? lake.areaT : null, lake.areaT && lake.area === undefined ? "(źródło nie podaje jednostki)" : null),
      measure("Lustro wody", lake.elevT ? `${lake.elevT} m n.p.m.` : null, null, true),
      measure("Współrzędne", typeof lake.lat === "number" ? formatCoord(lake.lat, lake.lon) : null, null, true));

    const blocks = [head, measures];

    const depthQuotes = [lake.dmaxQ, lake.dmeanQ].filter(Boolean);
    if (depthQuotes.length) {
      blocks.push(h("details", null, h("summary", { text: "Zdanie z artykułu, z którego pochodzi głębokość" }),
        ...[...new Set(depthQuotes)].map((q) => quote(q))));
    }
    if (lake.warn) {
      blocks.push(h("div", { class: "section" }, ...lake.warn.map((w) => h("p", { class: "muted", text: "Uwaga: " + w }))));
    }

    if (lake.ftype) {
      blocks.push(h("div", { class: "section" },
        h("h3", { text: `Typ rybacki: ${lake.ftype.join(", ")}` }),
        ...lake.ftypeQ.map((q) => quote(q))));
    }

    const fishSection = h("div", { class: "section" });
    if (species.length) {
      fishSection.append(
        h("h3", { text: `Ryby wymienione w artykule (${species.length})` }),
        h("ul", { class: "species" }, ...species.map((s) => h("li", null, s.name, s.latin ? h("i", { text: s.latin }) : null))),
        h("p", { class: "muted", text: "Skąd to wiemy: zdania z artykułu, w których padają te gatunki." }),
        ...lake.ev.map((e) => {
          const names = e.sp.map((key) => (state.speciesByKey.get(key) || {}).name).filter(Boolean).join(", ");
          const where = e.h ? `Sekcja „${e.h}” · ` : "";
          return quote(e.s, `${where}wymienione: ${names}`);
        }));
    } else {
      fishSection.append(
        h("h3", { text: "Ryby" }),
        h("p", { class: "muted", text: "Artykuł w Wikipedii nie wymienia ryb żyjących w tym akwenie. O rybostan zapytaj użytkownika rybackiego tej wody, na przykład okręg PZW albo gospodarstwo rybackie." }));
    }
    blocks.push(fishSection);

    if (lake.notes) {
      blocks.push(h("details", null,
        h("summary", { text: `Wzmianki o rybach, których nie liczymy (${lake.notes.length})` }),
        h("p", { class: "muted", text: "Te zdania mówią o przeszłości, o nieudanym zarybieniu, o przepisach albo o innych wodach, więc nie wynika z nich, że ryba żyje w tym akwenie dziś." }),
        ...lake.notes.map((n) => quote(n))));
    }

    blocks.push(h("div", { id: "sheet-catches", class: "section", hidden: true }));

    const links = h("div", { class: "links" },
      h("a", { href: wikiUrl(lake.t), target: "_blank", rel: "noopener", text: "Artykuł w Wikipedii" }),
      typeof lake.lat === "number" ? h("a", { href: osmUrl(lake.lat, lake.lon), target: "_blank", rel: "noopener", text: "Mapa OpenStreetMap" }) : null);
    blocks.push(links);
    blocks.push(h("p", { class: "source-line", text: `Dane z artykułu „${lake.t}” w polskiej Wikipedii${lake.rev ? ` (wersja z ${formatDate(lake.rev)})` : ""}, licencja CC BY-SA 4.0.` }));

    sheet.replaceChildren(...blocks);
  }

  // ------------------------------------------------------------------ depth chart (canvas)
  const map = (function () {
    const LON0 = 19.2, LAT0 = 52.0, COS = Math.cos((52 * Math.PI) / 180);
    const box = $("#canvas-box");
    const canvas = $("#map");
    const ctx = canvas.getContext("2d");
    const tooltip = $("#tooltip");
    let width = 0, height = 0, dpr = 1;
    let view = { cx: 0, cy: 0, scale: 1 };
    let fitScale = 1;
    let userMoved = false;
    let poland = [], neighbours = [], points = [], matchSet = new Set(), selected = null, hover = null;
    let colors = {};
    let ready = false;

    const project = (lon, lat) => [(lon - LON0) * COS, -(lat - LAT0)];
    const toScreen = (x, y) => [(x - view.cx) * view.scale + width / 2, (y - view.cy) * view.scale + height / 2];
    const toWorld = (sx, sy) => [(sx - width / 2) / view.scale + view.cx, (sy - height / 2) / view.scale + view.cy];

    function readColors() {
      colors = {
        sea: cssVar("--sea"), land: cssVar("--land"), neighbour: cssVar("--neighbour"), rule: cssVar("--rule"),
        ink3: cssVar("--ink-3"), mark: cssVar("--mark"), dnone: cssVar("--dnone"),
        d: { "--d1": cssVar("--d1"), "--d2": cssVar("--d2"), "--d3": cssVar("--d3"), "--d4": cssVar("--d4"), "--d5": cssVar("--d5") },
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

    function fitTo(b, minSpan) {
      const spanX = Math.max(b.maxX - b.minX, minSpan), spanY = Math.max(b.maxY - b.minY, minSpan);
      view.cx = (b.minX + b.maxX) / 2;
      view.cy = (b.minY + b.maxY) / 2;
      view.scale = Math.min(width / spanX, height / spanY) * 0.9;
    }

    let polandBounds = null;
    function fitPoland() {
      fitTo(polandBounds, 0);
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
      readColors();
      ready = true;
      resize();
      fitPoland();
      draw();
    }

    function resize() {
      if (!ready) return;
      const rect = box.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const oldFit = fitScale;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      if (polandBounds) {
        const keep = view.scale / (oldFit || 1);
        const center = [view.cx, view.cy];
        fitTo(polandBounds, 0);
        fitScale = view.scale;
        if (userMoved) { view.scale = fitScale * keep; [view.cx, view.cy] = center; }
      }
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

    function draw() {
      if (!ready || !width) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.sea;
      ctx.fillRect(0, 0, width, height);
      ctx.lineJoin = "round";
      ctx.fillStyle = colors.neighbour;
      ctx.strokeStyle = colors.rule;
      ctx.lineWidth = 1;
      for (const ring of neighbours) { path(ring); ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = colors.land;
      ctx.strokeStyle = colors.ink3;
      for (const ring of poland) { path(ring); ctx.fill("evenodd"); ctx.stroke(); }

      const zoom = view.scale / fitScale;
      const radius = Math.min(4 + (zoom - 1) * 0.6, 7);
      // lakes outside the filter: small context marks
      ctx.fillStyle = colors.rule;
      for (const p of points) {
        if (matchSet.has(p.lake)) continue;
        const [sx, sy] = toScreen(p.x, p.y);
        if (sx < -10 || sy < -10 || sx > width + 10 || sy > height + 10) continue;
        ctx.beginPath(); ctx.arc(sx, sy, 1.5, 0, Math.PI * 2); ctx.fill();
      }
      // lakes in the filter: coloured by maximum depth, with a ring in the land colour
      for (const p of points) {
        if (!matchSet.has(p.lake)) continue;
        const [sx, sy] = toScreen(p.x, p.y);
        if (sx < -10 || sy < -10 || sx > width + 10 || sy > height + 10) continue;
        const token = depthToken(p.lake.dmax);
        ctx.beginPath(); ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        if (token) {
          ctx.fillStyle = colors.d[token]; ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = colors.land; ctx.stroke();
        } else {
          ctx.fillStyle = colors.land; ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = colors.dnone; ctx.stroke();
        }
      }
      for (const p of [hover, selected]) {
        if (!p) continue;
        const [sx, sy] = toScreen(p.x, p.y);
        ctx.beginPath(); ctx.arc(sx, sy, radius + 5, 0, Math.PI * 2);
        ctx.lineWidth = 2.5; ctx.strokeStyle = colors.mark; ctx.stroke();
      }
    }

    function nearest(sx, sy, maxDistance) {
      let best = null, bestDistance = maxDistance * maxDistance;
      for (const p of points) {
        if (!matchSet.has(p.lake)) continue;
        const [px, py] = toScreen(p.x, p.y);
        const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
        if (d < bestDistance) { best = p; bestDistance = d; }
      }
      return best;
    }

    function setMatches(lakes, refit) {
      matchSet = new Set(lakes);
      if (refit && ready) {
        const subset = points.filter((p) => matchSet.has(p.lake));
        if (state.voiv !== "" && subset.length) {
          fitTo(bounds(subset.map((p) => [p.x, p.y])), 0.6);
          userMoved = true;
        } else {
          fitPoland();
        }
      }
      draw();
    }

    function setSelected(lake, center) {
      selected = lake ? points.find((p) => p.lake === lake) || null : null;
      if (selected && center) {
        const [sx, sy] = toScreen(selected.x, selected.y);
        const outside = sx < 40 || sy < 40 || sx > width - 40 || sy > height - 40;
        if (outside || view.scale < fitScale * 2.5) {
          view.scale = Math.max(view.scale, fitScale * 3);
          view.cx = selected.x; view.cy = selected.y;
          userMoved = true;
        }
      }
      draw();
    }

    function zoomAt(factor, sx, sy) {
      const [wx, wy] = toWorld(sx, sy);
      const scale = Math.min(Math.max(view.scale * factor, fitScale * 0.8), fitScale * 40);
      view.scale = scale;
      view.cx = wx - (sx - width / 2) / scale;
      view.cy = wy - (sy - height / 2) / scale;
      userMoved = true;
      draw();
    }

    function showTooltip(p, sx, sy) {
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

    // pointer interaction: drag to pan, wheel or pinch to zoom, tap to select
    const pointers = new Map();
    let dragStart = null, pinchStart = null;

    box.addEventListener("pointerdown", (event) => {
      box.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
      if (pointers.size === 1) {
        dragStart = { x: event.offsetX, y: event.offsetY, cx: view.cx, cy: view.cy, moved: false };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
        dragStart = null;
      }
    });
    box.addEventListener("pointermove", (event) => {
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
      if (pinchStart && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const factor = Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.distance;
        zoomAt((pinchStart.scale * factor) / view.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (dragStart) {
        const dx = event.offsetX - dragStart.x, dy = event.offsetY - dragStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) dragStart.moved = true;
        if (dragStart.moved) {
          box.classList.add("dragging");
          view.cx = dragStart.cx - dx / view.scale;
          view.cy = dragStart.cy - dy / view.scale;
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
    function endPointer(event) {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (dragStart && !dragStart.moved && event.type === "pointerup") {
        const p = nearest(event.offsetX, event.offsetY, event.pointerType === "mouse" ? 10 : 18);
        if (p) selectLake(p.lake, { scroll: window.matchMedia("(max-width: 900px)").matches });
      }
      if (pointers.size === 0) { dragStart = null; box.classList.remove("dragging"); }
    }
    box.addEventListener("pointerup", endPointer);
    box.addEventListener("pointercancel", endPointer);
    box.addEventListener("pointerleave", () => { if (hover) { hover = null; draw(); } showTooltip(null); });
    box.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoomAt(Math.pow(1.0015, -event.deltaY), event.offsetX, event.offsetY);
    }, { passive: false });

    $("#zoom-in").addEventListener("click", () => zoomAt(1.6, width / 2, height / 2));
    $("#zoom-out").addEventListener("click", () => zoomAt(1 / 1.6, width / 2, height / 2));
    $("#zoom-reset").addEventListener("click", () => { fitPoland(); draw(); });

    if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(box);
    else window.addEventListener("resize", resize);
    const recolor = () => { readColors(); draw(); };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recolor);
    new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return { setup, resize, setMatches, setSelected };
  })();

  // legend
  $("#legend-items").replaceChildren(
    ...DEPTH_BINS.map((bin) => h("span", null, h("i", { class: "dot", style: `background: var(${bin.token})`, "aria-hidden": "true" }), bin.label)),
    h("span", null, h("i", { class: "dot none", "aria-hidden": "true" }), "brak danych o głębokości"));

  load();
})();

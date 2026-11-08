/* patofishing: "Połowy", photos and measurements of fish added by users.

   Storage runs on the claude.ai artifact runtime (db for entries, assets for photos). Where that
   runtime is absent (for example on plain static hosting) the section stays hidden.
   Each person keeps their entries in one document, catches/<their id>, as {items: [...]}; everyone
   can read all documents, each person writes only their own, and the owner can remove any entry. */
(function () {
  "use strict";
  const P = window.patofishing;
  const $ = (selector) => document.querySelector(selector);
  const h = P.h;
  const ASSET_ID = /^[A-Za-z0-9_-]{8,128}$/;
  const MAX_SIDE = 1600;
  const decimal = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 });

  let db = null, assets = null, myId = null, isOwner = false;
  let entries = [];               // [{owner, item}] for display, newest first
  const rawItems = new Map();     // owner id -> items exactly as stored (for rewriting a document)
  let loaded = false;
  let filterLake = null;
  let lakeLabels = new Map();     // datalist label -> lake id
  let previewUrl = null;

  // ---------------------------------------------------------------- startup
  async function start() {
    await P.ready;
    if (!window.claude || typeof window.claude.use !== "function") return;
    let capabilities;
    try {
      capabilities = await Promise.all([window.claude.use("db"), window.claude.use("user"), window.claude.use("assets")]);
    } catch (error) {
      return;
    }
    const user = capabilities[1];
    db = capabilities[0];
    assets = capabilities[2];
    if (!db) return;
    myId = user ? await user.id() : null;
    isOwner = user ? await user.isOwner() : false;

    P.catchesEnabled = true;
    $("#nav-catches").hidden = false;
    setupForm();
    setupGallery();
    subscribe();
    P.onLakeSelected(renderLakeCatches);
    renderLakeCatches(P.state.selected);
    renderStartTeaser();
    if (location.hash === "#polowy") P.applyHash();
  }

  function canAdd() {
    return Boolean(assets && myId);
  }

  // ---------------------------------------------------------------- data
  function text(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }
  function number(value, min, max) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
  }
  function clean(raw) {
    if (!raw || typeof raw !== "object") return null;
    const photo = typeof raw.photo === "string" && ASSET_ID.test(raw.photo) ? raw.photo : null;
    const length = number(raw.length, 1, 300);
    if (!photo || length === null) return null;
    return {
      id: text(raw.id, 40),
      photo,
      species: text(raw.species, 40),
      speciesOther: text(raw.speciesOther, 40),
      length,
      weight: number(raw.weight, 0.01, 150),
      lakeId: Number.isInteger(raw.lakeId) ? raw.lakeId : null,
      place: text(raw.place, 80),
      date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || "") ? raw.date : "",
      nick: text(raw.nick, 40),
      note: text(raw.note, 300),
      created: text(raw.created, 40),
    };
  }

  function speciesName(item) {
    if (item.species === "inny") return item.speciesOther || "inny gatunek";
    const species = P.state.speciesByKey.get(item.species);
    return species ? species.name : "nieznany gatunek";
  }

  function placeName(item) {
    if (item.lakeId !== null && P.state.byId.has(item.lakeId)) return P.state.byId.get(item.lakeId).n;
    return item.place;
  }

  function measurement(item) {
    const parts = [`${decimal.format(item.length)} cm`];
    if (item.weight !== null) parts.push(`${decimal.format(item.weight)} kg`);
    return parts.join(" · ");
  }

  function setState(message) {
    const el = $("#g-state");
    el.textContent = message || "";
    el.hidden = !message;
  }

  function subscribe() {
    const timer = setTimeout(() => {
      if (!loaded) setState("Nie udało się jeszcze połączyć z bazą połowów. Wpisy pojawią się, gdy połączenie wróci.");
    }, 10000);
    db.collection("catches").onSnapshot((snapshot) => {
      if (!snapshot.metadata.fromCache) {
        loaded = true;
        clearTimeout(timer);
      }
      entries = [];
      rawItems.clear();
      for (const doc of snapshot.docs) {
        const data = doc.data() || {};
        const items = Array.isArray(data.items) ? data.items : [];
        rawItems.set(doc.id, items.map((item) => Object.assign({}, item)));
        for (const raw of items) {
          const item = clean(raw);
          if (item) entries.push({ owner: doc.id, item });
        }
      }
      entries.sort((a, b) => (b.item.created || "").localeCompare(a.item.created || ""));
      renderGallery();
      renderLakeCatches(P.state.selected);
      renderStartTeaser();
    }, (error) => {
      clearTimeout(timer);
      loaded = true;
      setState(error && error.code === "revoked"
        ? "Dostęp do połowów został wyłączony."
        : "Nie udało się wczytać połowów. Odśwież stronę, żeby spróbować ponownie.");
    });
  }

  async function writeItems(owner, items) {
    await db.doc("catches/" + owner).set({ items });
    rawItems.set(owner, items);
  }

  // ---------------------------------------------------------------- gallery
  function setupGallery() {
    $("#g-species").addEventListener("change", renderGallery);
    if (myId) {
      $("#g-mine-label").hidden = false;
      $("#g-mine").addEventListener("change", renderGallery);
    }
    if (!canAdd()) {
      const message = $("#catch-permission");
      message.textContent = "Dodawać połowy mogą osoby, którym właściciel strony dał prawo współtworzenia. Pozostali mogą je oglądać.";
      message.hidden = false;
    } else {
      $("#add-catch").hidden = false;
      $("#add-catch").addEventListener("click", () => openForm(null));
    }
  }

  function renderSpeciesFilter() {
    const select = $("#g-species");
    const current = select.value;
    const keys = [...new Set(entries.map((e) => e.item.species === "inny" ? "inny" : e.item.species))];
    const options = keys.map((key) => ({ key, name: key === "inny" ? "inne gatunki" : (P.state.speciesByKey.get(key) || {}).name || key }))
      .sort((a, b) => P.collator.compare(a.name, b.name));
    select.replaceChildren(h("option", { value: "", text: "Wszystkie" }),
      ...options.map((o) => h("option", { value: o.key, text: o.name })));
    if (options.some((o) => o.key === current)) select.value = current;
  }

  function renderGallery() {
    renderSpeciesFilter();
    const species = $("#g-species").value;
    const mine = myId && $("#g-mine").checked;
    const shown = entries.filter((e) =>
      (!species || e.item.species === species) &&
      (!mine || e.owner === myId) &&
      (filterLake === null || e.item.lakeId === filterLake));

    const chip = $("#g-lake");
    if (filterLake !== null && P.state.byId.has(filterLake)) {
      chip.replaceChildren(`Jezioro: ${P.state.byId.get(filterLake).n} `,
        h("button", { type: "button", class: "linklike", text: "pokaż wszystkie", onclick: () => { filterLake = null; renderGallery(); } }));
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
    $("#g-count").textContent = loaded || entries.length
      ? `${P.numberFmt.format(shown.length)} ${P.plural(shown.length, "połów", "połowy", "połowów")}` : "";

    if (!entries.length) {
      setState(loaded ? (canAdd()
        ? "Nie ma jeszcze żadnych połowów. Dodaj pierwszy: zdjęcie ryby, gatunek i długość."
        : "Nie ma jeszcze żadnych połowów.") : "Wczytywanie połowów…");
    } else if (!shown.length) {
      setState("Żaden połów nie pasuje do wybranych filtrów.");
    } else {
      setState("");
    }
    $("#g-grid").replaceChildren(...shown.map(card));
  }

  function photo(item, className) {
    const img = h("img", {
      class: className,
      src: "/_blob/" + encodeURIComponent(item.photo),
      alt: `${speciesName(item)}, ${decimal.format(item.length)} cm`,
      loading: "lazy",
      decoding: "async",
    });
    img.addEventListener("error", () => {
      img.replaceWith(h("div", { class: className + " photo-missing", text: "Zdjęcie niedostępne" }));
    }, { once: true });
    return img;
  }

  function card(entry) {
    const item = entry.item;
    const place = placeName(item);
    const meta = [];
    if (place) {
      meta.push(item.lakeId !== null && P.state.byId.has(item.lakeId)
        ? h("a", { href: "#j" + item.lakeId, text: place })
        : place);
    }
    if (item.date) meta.push(P.formatDate(item.date));
    if (item.nick) meta.push(item.nick);
    const metaLine = h("p", { class: "catch-meta" });
    meta.forEach((part, index) => { if (index) metaLine.append(" · "); metaLine.append(part); });

    const body = h("div", { class: "catch-body" },
      h("h3", { text: speciesName(item) }),
      h("p", { class: "catch-measure num", text: measurement(item) }),
      meta.length ? metaLine : null,
      item.note ? h("p", { class: "catch-note", text: item.note }) : null);

    if (entry.owner === myId || isOwner) {
      const actions = h("div", { class: "catch-actions" });
      const ask = () => {
        actions.replaceChildren(
          h("span", { text: "Usunąć ten wpis? " }),
          h("button", { type: "button", class: "linklike danger", text: "Tak, usuń", onclick: () => remove(entry, actions) }),
          h("button", { type: "button", class: "linklike", text: "Anuluj", onclick: reset }));
      };
      const reset = () => actions.replaceChildren(h("button", { type: "button", class: "linklike", text: "Usuń", onclick: ask }));
      reset();
      body.append(actions);
    }
    return h("li", { class: "card card-link catch-card" },
      h("div", { class: "photo-wrap" }, photo(item, "catch-photo"), h("span", { class: "badge num", text: `${decimal.format(item.length)} cm` })),
      body);
  }

  async function remove(entry, actions) {
    actions.replaceChildren(h("span", { text: "Usuwanie…" }));
    const current = rawItems.get(entry.owner) || [];
    const next = current.filter((raw) => !(raw && raw.id === entry.item.id && raw.photo === entry.item.photo));
    try {
      await writeItems(entry.owner, next);
    } catch (error) {
      actions.replaceChildren(h("span", { class: "form-error", text: "Nie udało się usunąć wpisu. Spróbuj ponownie." }));
      return;
    }
    if (assets) {
      try { await assets.delete(entry.item.photo); } catch (error) { /* the entry is gone; a leftover file is harmless */ }
    }
  }

  // ---------------------------------------------------------------- record sheet integration
  function renderLakeCatches(lake) {
    const box = document.getElementById("lake-catches");
    if (!box || !lake) return;
    const forLake = entries.filter((e) => e.item.lakeId === lake.id);
    if (!forLake.length && !canAdd()) { box.hidden = true; return; }
    const children = [h("h2", { text: forLake.length ? `Połowy (${forLake.length})` : "Połowy" })];
    if (forLake.length) {
      children.push(h("ul", { class: "catch-thumbs" }, ...forLake.slice(0, 6).map((e) =>
        h("li", null, h("a", { href: "#polowy", onclick: () => { filterLake = lake.id; renderGallery(); } },
          photo(e.item, "catch-thumb"),
          h("span", { text: `${speciesName(e.item)}, ${decimal.format(e.item.length)} cm` }))))));
    } else {
      children.push(h("p", { class: "muted", text: "Nikt jeszcze nie dodał połowu z tego jeziora." }));
    }
    const actions = h("div", { class: "source-links" });
    if (forLake.length) {
      actions.append(h("a", { class: "btn btn-small", href: "#polowy", text: "Zobacz wszystkie", onclick: () => { filterLake = lake.id; renderGallery(); } }));
    }
    if (canAdd()) {
      actions.append(h("button", { type: "button", class: "btn btn-small btn-primary", onclick: () => openForm(lake) }, P.icon("camera"), "Dodaj połów z tego jeziora"));
    }
    children.push(actions);
    box.replaceChildren(...children);
    box.hidden = false;
  }

  // ---------------------------------------------------------------- start page teaser
  function renderStartTeaser() {
    const section = document.getElementById("start-catches");
    const body = document.getElementById("start-catches-body");
    if (!section || !body) return;
    section.hidden = false;
    if (entries.length) {
      body.replaceChildren(h("ul", { class: "catch-grid teaser-grid" }, ...entries.slice(0, 4).map(card)));
    } else {
      body.replaceChildren(h("div", { class: "card cta-card" },
        h("div", null, h("h3", { text: "Pochwal się rybą" }),
          h("p", { class: "muted", text: "Dodaj zdjęcie, gatunek, długość i wagę. Dane GPS ze zdjęcia usuwamy przed wysłaniem." })),
        canAdd() ? h("button", { type: "button", class: "btn btn-primary", onclick: () => { location.hash = "polowy"; openForm(null); } }, P.icon("camera"), "Dodaj połów")
          : h("a", { class: "btn", href: "#polowy", text: "Zobacz połowy" })));
    }
  }

  // ---------------------------------------------------------------- form
  function lakeLabel(lake) {
    const where = lake.voivNames.join(", ");
    return lake.t === lake.n ? `${lake.n}, ${where}` : `${lake.t}, ${where}`;
  }

  function today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function setupForm() {
    const speciesSelect = $("#c-species");
    [...P.state.speciesByKey.values()]
      .sort((a, b) => P.collator.compare(a.name, b.name))
      .forEach((s) => speciesSelect.append(h("option", { value: s.key, text: s.name })));
    speciesSelect.append(h("option", { value: "inny", text: "inny gatunek (wpiszę nazwę)" }));
    speciesSelect.addEventListener("change", () => {
      $("#c-species-other-field").hidden = speciesSelect.value !== "inny";
    });

    const list = $("#c-lake-list");
    lakeLabels = new Map();
    const options = [];
    for (const lake of P.state.lakes) {
      const label = lakeLabel(lake);
      lakeLabels.set(label, lake.id);
      options.push(label);
    }
    options.sort((a, b) => P.collator.compare(a, b));
    list.replaceChildren(...options.map((label) => h("option", { value: label })));

    const photoInput = $("#c-photo");
    photoInput.addEventListener("change", () => {
      const preview = $("#c-preview");
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      const file = photoInput.files && photoInput.files[0];
      if (file) {
        previewUrl = URL.createObjectURL(file);
        preview.src = previewUrl;
        preview.hidden = false;
      } else {
        preview.hidden = true;
      }
    });
    $("#c-date").max = today();
    $("#c-cancel").addEventListener("click", closeForm);
    $("#c-close").addEventListener("click", closeForm);
    $("#catch-dialog").addEventListener("click", (event) => { if (event.target.id === "catch-dialog") closeForm(); });
    $("#catch-form").addEventListener("submit", submit);
  }

  function openForm(lake) {
    if (!canAdd()) return;
    const dialog = $("#catch-dialog");
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    }
    $("#c-date").max = today();
    if (!$("#c-date").value) $("#c-date").value = today();
    if (lake) $("#c-lake").value = lakeLabel(lake);
    $("#c-status").textContent = "";
    showError("");
    requestAnimationFrame(() => $("#c-photo").focus({ preventScroll: true }));
  }

  function closeForm() {
    const dialog = $("#catch-dialog");
    if (dialog.open) { if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open"); }
  }

  function showError(message) {
    const el = $("#c-error");
    el.textContent = message;
    el.hidden = !message;
  }

  function readForm() {
    const file = $("#c-photo").files && $("#c-photo").files[0];
    const species = $("#c-species").value;
    const speciesOther = $("#c-species-other").value.trim();
    const toNumber = (value) => (/^\d+(?:[.,]\d+)?$/.test(value) ? Number(value.replace(",", ".")) : NaN);
    const lengthValue = $("#c-length").value.trim();
    const weightValue = $("#c-weight").value.trim();
    const length = toNumber(lengthValue);
    const weight = weightValue === "" ? null : toNumber(weightValue);
    const date = $("#c-date").value;
    const lakeText = $("#c-lake").value.trim();
    const lakeId = lakeLabels.has(lakeText) ? lakeLabels.get(lakeText) : null;

    if (!file) return { error: "Dodaj zdjęcie ryby.", field: "#c-photo" };
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
      return { error: "Ten plik nie jest zdjęciem. Wybierz plik JPG, PNG lub WEBP.", field: "#c-photo" };
    }
    if (file.size > 40 * 1024 * 1024) return { error: "Zdjęcie jest za duże (ponad 40 MB). Wybierz mniejszy plik.", field: "#c-photo" };
    if (!species) return { error: "Wybierz gatunek ryby.", field: "#c-species" };
    if (species === "inny" && !speciesOther) return { error: "Wpisz nazwę gatunku.", field: "#c-species-other" };
    if (!Number.isFinite(length) || length < 1 || length > 300) {
      return { error: "Podaj długość ryby w centymetrach, od 1 do 300.", field: "#c-length" };
    }
    if (weight !== null && (!Number.isFinite(weight) || weight < 0.01 || weight > 150)) {
      return { error: "Podaj wagę w kilogramach, od 0,01 do 150, albo zostaw to pole puste.", field: "#c-weight" };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) {
      return { error: "Podaj datę połowu, nie późniejszą niż dzisiaj.", field: "#c-date" };
    }
    if (!$("#c-consent").checked) {
      return { error: "Zaznacz, że to Twoje zdjęcie i zgadzasz się na jego publikację.", field: "#c-consent" };
    }
    return {
      file,
      item: {
        species,
        speciesOther: species === "inny" ? speciesOther.slice(0, 40) : "",
        length: Math.round(length * 10) / 10,
        weight: weight === null ? null : Math.round(weight * 100) / 100,
        lakeId,
        place: lakeId === null ? lakeText.slice(0, 80) : "",
        date,
        nick: $("#c-nick").value.trim().slice(0, 40),
        note: $("#c-note").value.trim().slice(0, 300),
      },
    };
  }

  function decodeWithImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  /* Re-encode through a canvas: scales the photo down and drops all metadata (EXIF, GPS). */
  async function prepareImage(file) {
    let source;
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (error) {
      source = await decodeWithImg(file);
    }
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    if (!width || !height) throw new Error("decode");
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    if (source.close) source.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("encode");
    return blob;
  }

  function newId() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return "c" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  const UPLOAD_MESSAGES = {
    too_large: "Zdjęcie jest za duże nawet po zmniejszeniu. Wybierz inne zdjęcie.",
    unsupported_type: "Tego formatu nie da się zapisać. Wybierz zdjęcie JPG lub PNG.",
    quota_or_state: "Miejsce na zdjęcia na tej stronie się skończyło. Daj znać właścicielowi strony.",
    rate_limited: "Za dużo prób w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.",
    not_granted: "Nie masz uprawnień do dodawania zdjęć na tej stronie.",
  };

  async function submit(event) {
    event.preventDefault();
    showError("");
    const result = readForm();
    if (result.error) {
      showError(result.error);
      const field = $(result.field);
      if (field) field.focus();
      return;
    }
    const button = $("#c-submit");
    const status = $("#c-status");
    button.disabled = true;
    let uploaded = null;
    try {
      status.textContent = "Przygotowuję zdjęcie…";
      let blob;
      try {
        blob = await prepareImage(result.file);
      } catch (error) {
        throw { message: "Nie udało się odczytać zdjęcia. Zapisz je jako JPG lub PNG i spróbuj ponownie." };
      }
      status.textContent = "Wysyłam zdjęcie…";
      try {
        uploaded = await assets.upload(blob, { type: "image/jpeg" });
      } catch (error) {
        throw { message: UPLOAD_MESSAGES[error && error.code] || "Nie udało się wysłać zdjęcia. Spróbuj ponownie." };
      }
      status.textContent = "Zapisuję wpis…";
      const item = Object.assign({ id: newId(), photo: uploaded.id, created: new Date().toISOString() }, result.item);
      const next = (rawItems.get(myId) || []).concat([item]);
      try {
        await writeItems(myId, next);
      } catch (error) {
        try { await assets.delete(uploaded.id); } catch (ignored) { /* best effort */ }
        const code = error && error.code;
        throw { message: code === "quota_exceeded" || code === "invalid_argument"
          ? "Nie udało się zapisać wpisu: osiągnięto limit wpisów albo nie masz uprawnień do zapisu."
          : "Nie udało się zapisać wpisu. Spróbuj ponownie." };
      }
      $("#catch-form").reset();
      $("#c-preview").hidden = true;
      $("#c-species-other-field").hidden = true;
      $("#c-date").value = today();
      status.textContent = "Dodano połów.";
      setTimeout(() => { closeForm(); status.textContent = ""; }, 900);
      filterLake = null;
      renderGallery();
    } catch (error) {
      status.textContent = "";
      showError(error && error.message ? error.message : "Coś poszło nie tak. Spróbuj ponownie.");
    } finally {
      button.disabled = false;
    }
  }

  start();
})();

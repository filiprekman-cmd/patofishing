"""Find every Polish Wikipedia article about a lake or reservoir in Poland and download it.

The number of requests is kept small on purpose (Wikimedia rate-limits anonymous clients):
  * the article list comes from a category-tree search (deepcat) per voivodeship,
  * the wikitext of up to 400 articles is downloaded per request through Special:Export.
"""

import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import wiki_api

VOIVODESHIPS = {
    "dolnośląskim": "dolnośląskie",
    "kujawsko-pomorskim": "kujawsko-pomorskie",
    "lubelskim": "lubelskie",
    "lubuskim": "lubuskie",
    "łódzkim": "łódzkie",
    "małopolskim": "małopolskie",
    "mazowieckim": "mazowieckie",
    "opolskim": "opolskie",
    "podkarpackim": "podkarpackie",
    "podlaskim": "podlaskie",
    "pomorskim": "pomorskie",
    "śląskim": "śląskie",
    "świętokrzyskim": "świętokrzyskie",
    "warmińsko-mazurskim": "warmińsko-mazurskie",
    "wielkopolskim": "wielkopolskie",
    "zachodniopomorskim": "zachodniopomorskie",
}

# (category title prefix, kind of water body)
ROOTS = (
    ("Jeziora w województwie ", "jezioro"),
    ("Sztuczne zbiorniki wodne w województwie ", "zbiornik"),
)

EXPORT_URL = "https://pl.wikipedia.org/w/index.php"
EXPORT_BATCH = 400


def search_category_tree(category):
    """Return the titles of all articles in the category and its subcategories."""
    titles = []
    params = {
        "action": "query",
        "list": "search",
        "srsearch": f'deepcat:"{category}"',
        "srnamespace": "0",
        "srlimit": "500",
        "srprop": "",
        "srinfo": "totalhits",
    }
    cont = {}
    total = None
    while True:
        data = wiki_api.get(dict(params, **cont))
        if data.get("warnings"):
            raise RuntimeError(f"Search warning for {category}: {data['warnings']}")
        total = data["query"]["searchinfo"]["totalhits"]
        titles.extend(item["title"] for item in data["query"]["search"])
        if "continue" not in data:
            break
        cont = data["continue"]
    if len(titles) != total:
        raise RuntimeError(f"{category}: got {len(titles)} of {total} search results")
    return titles


def collect_titles(log=print):
    """Returns {title: {"voivodeships": set, "kinds": set}}."""
    pages = {}
    for suffix, voivodeship in VOIVODESHIPS.items():
        for prefix, kind in ROOTS:
            category = prefix + suffix
            titles = search_category_tree(category)
            for title in titles:
                entry = pages.setdefault(title, {"voivodeships": set(), "kinds": set()})
                entry["voivodeships"].add(voivodeship)
                entry["kinds"].add(kind)
            log(f"  {category}: {len(titles)} artykułów (łącznie {len(pages)})")
    return pages


def category_members_direct(category):
    """Articles placed directly in a category (no subcategories). Used for self-checks."""
    return {
        item["title"]
        for item in wiki_api.get_all(
            {"action": "query", "list": "categorymembers", "cmtitle": "Kategoria:" + category,
             "cmtype": "page", "cmlimit": "max"},
            "categorymembers",
        )
    }


def _export(titles):
    body = urllib.parse.urlencode(
        {"title": "Specjalna:Eksport", "pages": "\n".join(titles), "curonly": "1", "action": "submit"}
    ).encode("utf-8")
    delay = 5
    for _ in range(12):
        wait = wiki_api.MIN_INTERVAL - (time.monotonic() - wiki_api._last_request)
        if wait > 0:
            time.sleep(wait)
        wiki_api._last_request = time.monotonic()
        request = urllib.request.Request(
            EXPORT_URL,
            data=body,
            headers={"User-Agent": wiki_api.USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code in (429, 500, 502, 503, 504):
                retry_after = error.headers.get("retry-after")
                time.sleep(int(retry_after) + 1 if retry_after and retry_after.isdigit() else delay)
                delay = min(delay * 2, 120)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(delay)
            delay = min(delay * 2, 120)
    raise RuntimeError("Special:Export failed repeatedly")


def fetch_wikitexts(titles, log=print):
    """Return {title: {"wikitext", "revision_timestamp", "pageid"}} for the given article titles."""
    result = {}
    titles = sorted(titles)
    for start in range(0, len(titles), EXPORT_BATCH):
        batch = titles[start:start + EXPORT_BATCH]
        root = ET.fromstring(_export(batch))
        ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
        for page in root.findall(f"{ns}page"):
            title = page.findtext(f"{ns}title")
            revision = page.find(f"{ns}revision")
            if revision is None:
                continue
            result[title] = {
                "pageid": int(page.findtext(f"{ns}id")),
                "revision_timestamp": revision.findtext(f"{ns}timestamp"),
                "wikitext": revision.findtext(f"{ns}text") or "",
            }
        log(f"  pobrano treść {min(start + EXPORT_BATCH, len(titles))}/{len(titles)} artykułów")
    missing = set(titles) - set(result)
    if missing:
        raise RuntimeError(f"Special:Export did not return {len(missing)} pages, e.g. {sorted(missing)[:5]}")
    return result


def species_articles(seed_titles):
    """For each seed title: the article it resolves to, that article's wikitext and every
    redirect pointing to it. Returns ({seed: canonical or None}, {canonical: wikitext},
    {canonical: [redirect titles]})."""
    resolved, texts, redirects = {}, {}, {}
    seeds = sorted(set(seed_titles))
    for start in range(0, len(seeds), 50):
        batch = seeds[start:start + 50]
        data = wiki_api.get({
            "action": "query", "titles": "|".join(batch), "redirects": "1",
            "prop": "revisions", "rvprop": "content", "rvslots": "main",
        })
        query = data.get("query", {})
        mapping = {t: t for t in batch}
        for key in ("normalized", "redirects"):
            for item in query.get(key, []):
                for seed, current in mapping.items():
                    if current == item["from"]:
                        mapping[seed] = item["to"]
        present = set()
        for page in query.get("pages", []):
            if page.get("missing") or page.get("invalid"):
                continue
            present.add(page["title"])
            if page.get("revisions"):
                texts[page["title"]] = page["revisions"][0]["slots"]["main"]["content"]
        for seed, current in mapping.items():
            resolved[seed] = current if current in present else None
    canonical = sorted({c for c in resolved.values() if c})
    for start in range(0, len(canonical), 50):
        batch = canonical[start:start + 50]
        for page in wiki_api.get_all_pages({
            "action": "query", "titles": "|".join(batch), "prop": "redirects",
            "rdlimit": "max", "rdnamespace": "0",
        }):
            redirects.setdefault(page["title"], []).extend(r["title"] for r in page.get("redirects", []))
    return resolved, texts, redirects


def api_coordinates(titles):
    """Primary coordinates stored by Wikipedia (GeoData) for the given titles: {title: (lat, lon)}."""
    found = {}
    titles = sorted(titles)
    for start in range(0, len(titles), 50):
        batch = titles[start:start + 50]
        for page in wiki_api.get_all_pages({
            "action": "query", "titles": "|".join(batch), "prop": "coordinates",
            "coprimary": "primary", "colimit": "max",
        }):
            for coordinate in page.get("coordinates", []):
                lat, lon = coordinate["lat"], coordinate["lon"]
                if 48.9 <= lat <= 55.0 and 14.0 <= lon <= 24.3:
                    found[page["title"]] = (round(lat, 5), round(lon, 5))
                    break
    return found

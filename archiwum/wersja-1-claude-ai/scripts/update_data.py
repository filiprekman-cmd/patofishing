"""Refresh site/data/lakes.json from Polish Wikipedia.

Usage:
    python3 scripts/update_data.py                 # download everything and rebuild the data file
    python3 scripts/update_data.py --cache DIR     # also keep the raw download in DIR
    python3 scripts/update_data.py --cache DIR --offline   # rebuild from a previous download

The data file is replaced only when the new data passes the sanity checks at the bottom of
this file, so a failed or partial download never overwrites good data.
"""

import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_pages  # noqa: E402
import gatunki  # noqa: E402
import parse_lakes  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "site" / "data" / "lakes.json"

UPDATE_MONTHS = (2, 5, 8, 11)  # 1 February, 1 May, 1 August, 1 November
MIN_LAKES = 2000
MAX_DROP = 0.10  # refuse to publish if more than 10% of lakes disappear at once
MUST_HAVE = {"Śniardwy": None, "Mamry": None, "Hańcza (jezioro)": 100.0, "Jeziorak": None, "Łebsko": None}


def log(message):
    print(message, flush=True)


def normalise_title(title):
    title = re.sub(r"\s+", " ", title.replace("_", " ")).strip()
    return title[:1].upper() + title[1:]


def lead_mentions(wikitext, token):
    """True if the article is not a disambiguation page and its lead sentence contains token."""
    if re.search(r"\{\{\s*(?:ujednoznacznienie|disambig)", wikitext, flags=re.IGNORECASE):
        return False
    text = parse_lakes.remove_templates(parse_lakes.strip_comments_and_refs(wikitext))
    for line in text.split("\n"):
        if line.startswith("'''"):
            return token in line
    return False


def build_species_aliases(resolved, texts, redirects):
    """Map article titles (and redirects) to species keys. Exact seed titles win, so a
    redirect like "Karaś" (generic) is not merged with "Karaś pospolity"."""
    aliases = {}
    accepted = {}
    for species in gatunki.SPECIES:
        latin_words = species["latin"].split()
        tokens = [latin_words[1] if len(latin_words) >= 2 else species["latin"]] + species.get("lead_tokens", [])
        for seed in species["seeds"]:
            canonical = resolved.get(seed)
            if canonical is None:
                log(f"  uwaga: brak artykułu '{seed}' (gatunek {species['key']}), pomijam")
                continue
            if any(t and lead_mentions(texts.get(canonical, ""), t) for t in tokens):
                accepted.setdefault(species["key"], []).append((seed, canonical))
                aliases.setdefault(normalise_title(seed), species["key"])
            else:
                log(f"  uwaga: artykuł '{canonical}' (z tytułu '{seed}') nie opisuje gatunku "
                    f"{species['key']}, pomijam")
    for key, pairs in accepted.items():
        for _, canonical in pairs:
            aliases.setdefault(normalise_title(canonical), key)
    for key, pairs in accepted.items():
        for _, canonical in pairs:
            for redirect in redirects.get(canonical, []):
                aliases.setdefault(normalise_title(redirect), key)
    return aliases


def next_update_date(today):
    for year in (today.year, today.year + 1):
        for month in UPDATE_MONTHS:
            candidate = datetime.date(year, month, 1)
            if candidate > today:
                return candidate
    raise AssertionError("unreachable")


def download(cache):
    log("1/3 Szukam artykułów o jeziorach i zbiornikach w kategoriach województw…")
    titles = fetch_pages.collect_titles(log)
    log(f"    znaleziono {len(titles)} artykułów")
    log("2/3 Sprawdzam artykuły o gatunkach ryb…")
    seeds = [seed for species in gatunki.SPECIES for seed in species["seeds"]]
    resolved, texts, redirects = fetch_pages.species_articles(seeds)
    log("3/3 Pobieram treść artykułów…")
    pages = fetch_pages.fetch_wikitexts(titles.keys(), log)
    missing = [t for t, page in pages.items() if not parse_lakes.page_coordinates(page["wikitext"])]
    if missing:
        log(f"    dopytuję o współrzędne {len(missing)} artykułów bez współrzędnych w treści…")
        for title, coordinates in fetch_pages.api_coordinates(missing).items():
            pages[title]["api_coordinates"] = coordinates
    raw = {
        "titles": {t: {"voivodeships": sorted(v["voivodeships"]), "kinds": sorted(v["kinds"])}
                   for t, v in titles.items()},
        "species": {"resolved": resolved, "texts": texts, "redirects": redirects},
        "pages": pages,
    }
    if cache:
        Path(cache).mkdir(parents=True, exist_ok=True)
        with open(Path(cache) / "raw.json", "w", encoding="utf-8") as handle:
            json.dump(raw, handle, ensure_ascii=False)
    return raw


def build(raw, today):
    species_raw = raw["species"]
    aliases = build_species_aliases(species_raw["resolved"], species_raw["texts"], species_raw["redirects"])
    voivodeships = sorted(fetch_pages.VOIVODESHIPS.values())
    lakes, skipped = [], []
    for title, page in sorted(raw["pages"].items()):
        record = parse_lakes.parse_lake(title, page, aliases)
        if record is None:
            skipped.append(title)
            continue
        meta = raw["titles"][title]
        record["w"] = [voivodeships.index(v) for v in meta["voivodeships"]]
        record["k"] = "".join(sorted({"jezioro": "j", "zbiornik": "z"}[k] for k in meta["kinds"]))
        lakes.append(record)

    counts = {}
    for lake in lakes:
        for key in lake.get("fish", []):
            counts[key] = counts.get(key, 0) + 1
    species = [
        {"key": s["key"], "name": s["name"], "latin": s["latin"], "count": counts.get(s["key"], 0)}
        for s in gatunki.SPECIES
    ]
    return {
        "generated": today.isoformat(),
        "next_update": next_update_date(today).isoformat(),
        "source": "Polska Wikipedia (pl.wikipedia.org), licencja CC BY-SA 4.0",
        "voivodeships": voivodeships,
        "species": species,
        "stats": {
            "lakes": len(lakes),
            "with_depth": sum(1 for lake in lakes if "dmax" in lake),
            "with_fish": sum(1 for lake in lakes if lake.get("fish")),
            "with_coordinates": sum(1 for lake in lakes if "lat" in lake),
            "skipped_not_water_body": skipped,
        },
        "lakes": lakes,
    }


def check(data, output):
    """Raise if the new data looks broken. Compares with the data file it would replace."""
    problems = []
    lakes = data["lakes"]
    if len(lakes) < MIN_LAKES:
        problems.append(f"za mało jezior: {len(lakes)} (minimum {MIN_LAKES})")
    by_title = {lake["t"]: lake for lake in lakes}
    for title, min_depth in MUST_HAVE.items():
        if title not in by_title:
            problems.append(f"brak artykułu kontrolnego: {title}")
        elif min_depth is not None and not by_title[title].get("dmax", 0) >= min_depth:
            problems.append(f"podejrzana głębokość dla {title}: {by_title[title].get('dmax')}")
    if data["stats"]["with_depth"] < 0.5 * len(lakes):
        problems.append("mniej niż połowa jezior ma głębokość, parser mógł się zepsuć")
    if output.exists():
        try:
            previous = json.loads(output.read_text(encoding="utf-8"))
            old = len(previous.get("lakes", []))
            if old and len(lakes) < old * (1 - MAX_DROP):
                problems.append(f"liczba jezior spadła z {old} do {len(lakes)}")
        except (ValueError, OSError) as error:
            log(f"  uwaga: nie mogę odczytać poprzedniego pliku danych ({error})")
    if problems:
        raise SystemExit("Dane NIE zostały zapisane:\n  - " + "\n  - ".join(problems))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", help="katalog na surowe dane z Wikipedii")
    parser.add_argument("--offline", action="store_true", help="użyj danych z --cache zamiast pobierać")
    parser.add_argument("--output", default=str(OUTPUT), help="ścieżka pliku wynikowego")
    args = parser.parse_args()

    today = datetime.date.today()
    if args.offline:
        if not args.cache:
            raise SystemExit("--offline wymaga --cache")
        with open(Path(args.cache) / "raw.json", encoding="utf-8") as handle:
            raw = json.load(handle)
    else:
        raw = download(args.cache)

    data = build(raw, today)
    output = Path(args.output)
    check(data, output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, output)
    stats = data["stats"]
    log(f"Zapisano {output}: {stats['lakes']} akwenów, {stats['with_depth']} z głębokością, "
        f"{stats['with_fish']} z informacją o rybach, {stats['with_coordinates']} ze współrzędnymi.")


if __name__ == "__main__":
    main()

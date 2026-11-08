"""Turn Polish Wikipedia wikitext of lake articles into structured records.

Nothing here guesses: values are copied from the article (infobox first, then explicit
sentences in the text), and every fish mention keeps the sentence it came from so the
website can show it as evidence.
"""

import re

import gatunki

INFOBOX_NAME = re.compile(r"\{\{\s*(?:jezioro|zbiornik wodny|sztuczny zbiornik wodny|zbiornik)\s+infobox\b",
                          re.IGNORECASE)

PL_UPPER = "A-ZĄĆĘŁŃÓŚŹŻ"
PL_WORD = "0-9A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż"

# Words that show a sentence is about fish or fishing (matched at the start of a word).
STRONG_FISH_CONTEXT = re.compile(
    r"\b(?:ryb|ichtiofaun|ichtiolin|wędkar|zarybi|narybk|łowisk|połów|połowu|połowów|połowem|"
    r"połowach|połowami|odłow|złowi|łowion|tarł|tarlisk|rybostan|pogłowi)",
    re.IGNORECASE,
)
FISH_CONTEXT = re.compile(
    STRONG_FISH_CONTEXT.pattern + r"|\b(?:gatunk|występuj|występowa|żyj[eąa]|bytuj|spotyka|zasiedl|"
    r"obfituj|zasobn|populacj|dominuj|przeważa)",
    re.IGNORECASE,
)
# Fish names that are also ordinary words ("liny" = ropes, "sumy" = sums). Without a link or a
# clearly fish-related word they are not counted.
AMBIGUOUS_SPECIES = {"lin", "sum", "swinka", "sapa", "ciosa", "certa"}

# Sentences that deny presence, describe a failure or a loss, or state fishing rules.
# Fish in them are not counted; the sentence is kept as a note.
NOT_PRESENT = re.compile(
    r"\bnie\s+(?:występuj|występowa|stwierdz|odnotow|spotyka|żyj|ma\b|bytuj|było|został|zostały|"
    r"udał|udało|przyjął|przyjęł|utrzymuj|utrzymał|przetrwa|wolno)|"
    r"(?<!nie )\bbrak\b|\bbraku\b|\bzanik|\bwyginęł|\bwyginął|\bwymarł|\bwytępi|\bwyniszcz|\bdawniej\b|"
    r"\bniegdyś\b|\bw przeszłości\b|\bwcześniej\b|\bprzed (?:ii )?wojną|\bprzed ii wojną światową|"
    r"\bdo lat\b|\blat temu\b|\bustąpił|\bzniknęł|\bzniknął|\bjuż nie\b|\bprzestał|"
    r"\bśnięci|\bśnięt[eay]\s+ryb|\bprzyduch|\bbezskutecz|\bnieudan|\bniepowodzen|\bzakaz|"
    r"\blimit|\bwymiar\w*\s+ochronn|\bokres\w*\s+ochronn",
    re.IGNORECASE,
)
# Past tense without any present-tense verb: the sentence describes how things were.
PAST_TENSE = re.compile(
    r"\b(?:występował\w*|żył[aoy]?|bytował\w*|spotykano|łowiono|poławiano|odławiano|"
    r"był|była|było|były|byli)\b|\bmożna\s+było\b|\bbyło\s+można\b",
    re.IGNORECASE,
)
PRESENT_TENSE = re.compile(
    r"\b(?:występuj[eą]|żyj[eą]|bytuj[eą]|jest|są|spotyka|spotykają|dominuj[eą]|obfituj[eą]|przeważa|"
    r"przeważają|zamieszkuj[eą]|zarybia|zarybiają|obecnie|stanowi|stanowią)\b|\b(?:spotkać|złowić)\s+można\b(?!\s+było)|"
    r"\bmożna\s+(?:spotkać|złowić)\b(?!\s+było)|\b(?:łowi|poławia)\s+się\b",
    re.IGNORECASE,
)
RECENT = re.compile(r"\b20\d\d\b|\bXXI\s*w")
# Sentences about a river, stream, canal, bog or a neighbouring lake rather than this lake.
OTHER_WATER = re.compile(
    r"\b(?:w|we|na)\s+(?:\w+\s+){0,2}?(?:rzek\w*|rzece|potok(?:u|i|ów|ach|iem)?\b|"
    r"strumie(?:ń|nia|niu|nie|ni|niach)\b|kana(?:ł|le|łu|łach|łem|ły)\b|dopływ\w*|torfowisk\w*)|"
    r"\bsąsiedni\w*",
    re.IGNORECASE,
)

# Abbreviations after which a full stop followed by a capital letter does not end a sentence
# (they usually precede a name). Units such as "m", "ha" or "n.p.m." do end sentences.
ABBREVIATIONS = {
    "św", "im", "ul", "al", "pl", "prof", "dr", "gen", "płk", "ks", "tzw", "np", "m.in", "tj", "wg",
    "jez", "woj", "gm", "pow", "st", "mgr", "inż", "hab", "por", "kpt", "mjr", "ang", "niem", "łac",
    "lit", "ros", "pol", "ok", "płn", "płd", "wsch", "zach", "zm", "ur", "red", "oprac", "tzn",
}


# ----------------------------------------------------------------------------- wikitext helpers

def _matching_end(text, start, open_seq, close_seq):
    """Index just past the construct opened at text[start] (e.g. '{{' ... '}}'), or -1."""
    depth = 0
    i = start
    while i < len(text):
        if text.startswith(open_seq, i):
            depth += 1
            i += len(open_seq)
        elif text.startswith(close_seq, i):
            depth -= 1
            i += len(close_seq)
            if depth == 0:
                return i
        else:
            i += 1
    return -1


def strip_comments_and_refs(text):
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"<ref[^>]*/\s*>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<ref[^>]*>.*?</ref\s*>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<references[^>]*/>|<references[^>]*>.*?</references>", "", text,
                  flags=re.IGNORECASE | re.DOTALL)
    return text


def unwrap_simple_templates(text):
    """Keep the visible content of a few formatting templates before templates are removed."""
    text = re.sub(r"\{\{\s*formatnum\s*:\s*([^{}|]*?)\s*\}\}", r"\1", text, flags=re.IGNORECASE)
    text = re.sub(r"\{\{\s*(?:nowrap|nobr|unikod|small|mały)\s*\|\s*([^{}]*?)\s*\}\}", r"\1", text,
                  flags=re.IGNORECASE)
    text = re.sub(r"\{\{\s*(?:lang|k)\s*\|[^{}|]*\|\s*([^{}]*?)\s*\}\}", r"\1", text, flags=re.IGNORECASE)
    text = re.sub(r"\{\{\s*km2\s*\}\}", "km²", text, flags=re.IGNORECASE)
    return text


def remove_templates(text):
    previous = None
    while previous != text:
        previous = text
        text = re.sub(r"\{\{[^{}]*\}\}", "", text)
    return text


def remove_tables(text):
    out = []
    i = 0
    while True:
        start = text.find("{|", i)
        if start == -1:
            out.append(text[i:])
            break
        end = _matching_end(text, start, "{|", "|}")
        out.append(text[i:start])
        if end == -1:
            break
        i = end
    return "".join(out)


def remove_files_and_categories(text):
    pattern = re.compile(r"\[\[\s*(?:plik|file|grafika|image|kategoria|category)\s*:", re.IGNORECASE)
    while True:
        match = pattern.search(text)
        if not match:
            return text
        end = _matching_end(text, match.start(), "[[", "]]")
        if end == -1:
            return text[:match.start()]
        text = text[:match.start()] + text[end:]


LINK = re.compile(r"\[\[([^\[\]|]+)(?:\|([^\[\]]*))?\]\]")


def render_plain(text):
    """Wikitext (templates already removed) to plain text."""
    text = LINK.sub(lambda m: (m.group(2) if m.group(2) is not None else m.group(1)), text)
    text = re.sub(r"\[(?:https?:)?//[^\s\]]+\s+([^\]]+)\]", r"\1", text)
    text = re.sub(r"\[(?:https?:)?//[^\s\]]+\]", "", text)
    text = re.sub(r"'{2,}", "", text)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = (text.replace("&nbsp;", " ").replace(" ", " ").replace("&ndash;", "–")
            .replace("&mdash;", "–").replace("—", "–").replace("&amp;", "&"))
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.;:)])", r"\1", text)
    text = re.sub(r"\(\s*\)", "", text)
    text = re.sub(r",\s*([.;:])", r"\1", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def link_targets(text):
    targets = []
    for match in LINK.finditer(text):
        target = match.group(1).split("#")[0].strip().replace("_", " ")
        target = re.sub(r"\s+", " ", target)
        if target:
            targets.append(target[0].upper() + target[1:])
    return targets


# ----------------------------------------------------------------------------- infobox

def find_infobox(text):
    match = INFOBOX_NAME.search(text)
    if not match:
        return None, None
    end = _matching_end(text, match.start(), "{{", "}}")
    if end == -1:
        return None, None
    return match.start(), end


def parse_infobox(block):
    """Return {param name (lower-case): raw value} for a template block '{{...}}'."""
    inner = strip_comments_and_refs(block[2:-2])
    params = {}
    parts, depth_curly, depth_square, current = [], 0, 0, []
    i = 0
    while i < len(inner):
        two = inner[i:i + 2]
        if two == "{{":
            depth_curly += 1; current.append(two); i += 2; continue
        if two == "}}":
            depth_curly -= 1; current.append(two); i += 2; continue
        if two == "[[":
            depth_square += 1; current.append(two); i += 2; continue
        if two == "]]":
            depth_square -= 1; current.append(two); i += 2; continue
        char = inner[i]
        if char == "|" and depth_curly == 0 and depth_square == 0:
            parts.append("".join(current)); current = []
        else:
            current.append(char)
        i += 1
    parts.append("".join(current))
    for part in parts[1:]:
        if "=" in part:
            key, value = part.split("=", 1)
            params[re.sub(r"\s+", " ", key.strip().lower())] = value.strip()
    return params


def clean_value(raw):
    if raw is None:
        return ""
    value = unwrap_simple_templates(strip_comments_and_refs(raw))
    value = remove_templates(value)
    return render_plain(value)


NUMBER = re.compile(r"(?<![\d,.])(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[,.](\d+))?")


def parse_numbers(text):
    numbers = []
    for match in NUMBER.finditer(text):
        whole = match.group(1).replace(" ", "").replace(" ", "")
        numbers.append((float(whole + ("." + match.group(2) if match.group(2) else "")),
                        match.start(), match.end()))
    return numbers


def parse_measure(text, unit_suffix_pattern=r"\s*m\.?$"):
    """Depth-like value already in metres. Returns (display text, first number) or (None, None)."""
    if not text:
        return None, None
    display = re.sub(unit_suffix_pattern, "", text).strip()
    numbers = parse_numbers(display)
    if not numbers:
        return None, None
    return display, numbers[0][0]


def parse_area(text):
    """Area. Returns (display text, hectares or None). Hectares only when the unit is explicit.
    For a range such as "11–12,6 ha" the first value is used for sorting."""
    if not text:
        return None, None
    numbers = parse_numbers(text)
    if not numbers:
        return None, None
    value, _, end = numbers[0]
    for later, start, later_end in numbers[1:]:
        if re.fullmatch(r"\s*[–\-‐‑]\s*", text[end:start]):
            end = later_end
        break
    rest = text[end:end + 12].lower()
    if re.match(r"\s*km(?:²|2|\^2| kw)", rest):
        return text, round(value * 100, 2)
    if re.match(r"\s*ha\b", rest):
        return text, value
    if re.match(r"\s*m(?:²|2)", rest):
        return text, round(value / 10000, 4)
    return text, None


def parse_length_m(text):
    """Length such as "4550 m", "4,55 km" or "0,25-3,5 km" in metres (the larger end of a
    range), or None when the unit is missing."""
    numbers = parse_numbers(text or "")
    if not numbers:
        return None
    value, _, end = numbers[0]
    for later, start, later_end in numbers[1:]:
        if re.fullmatch(r"\s*[–\-‐‑]\s*", text[end:start]):
            value, end = max(value, later), later_end
        break
    rest = text[end:end + 6].lower()
    if re.match(r"\s*km\b", rest):
        return value * 1000
    if re.match(r"\s*m\b", rest):
        return value
    return None


def parse_volume_m3(text):
    """Volume such as "129,5 mln m³", "30950,5 tys. m³" or "0,118 km³" in cubic metres."""
    numbers = parse_numbers(text or "")
    if not numbers:
        return None
    value, _, end = numbers[0]
    rest = text[end:end + 14].lower()
    for pattern, factor in ((r"\s*km(?:³|3)", 1e9), (r"\s*hm(?:³|3)", 1e6), (r"\s*mln\.?\s*m(?:³|3)", 1e6),
                            (r"\s*tys\.?\s*m(?:³|3)", 1e3), (r"\s*m(?:³|3)", 1.0)):
        if re.match(pattern, rest):
            return value * factor
    return None


TEXT_AREA = re.compile(
    r"(?:^|;\s*)powierzchnia\s*[–:\-]\s*(?:około\s+|ok\.\s+)?{num}\s*(ha|km²|km2)\b|"
    r"\b(?:jezioro|zbiornik|akwen)\w*\s+(?:ma|zajmuje|posiada)\s+powierzchni\w*\s+(?:około\s+|ok\.\s+)?{num}\s*(ha|km²|km2)\b|"
    r"\bpowierzchnia\s+(?:jeziora|zbiornika|akwenu|lustra\s+wody|zwierciadła\s+wody)\s+(?:wynosi\s+|to\s+)?"
    r"(?:około\s+|ok\.\s+)?{num}\s*(ha|km²|km2)\b".format(num=r"(\d+(?:[ \u00a0]\d{3})*(?:[,.]\d+)?)"),
    re.IGNORECASE,
)
LARGE_AREA_HA = 2000  # only a few dozen Polish lakes are larger


def _text_area_ha(sentences):
    for _, sentence in sentences:
        match = TEXT_AREA.search(render_plain(sentence))
        if match:
            groups = [g for g in match.groups() if g is not None]
            value = parse_numbers(groups[0])[0][0]
            return value * 100 if groups[1].lower().startswith("km") else value, f"{groups[0]} {groups[1]}"
    return None, None


def area_conflict(area_ha, infobox, sentences, mean_depth):
    """Reason why the infobox area cannot be trusted, or None."""
    # Mean depth is by definition volume / area. Volumes in Wikipedia often carry wrong units,
    # so agreement only confirms an area and disagreement is not held against it.
    volume = parse_volume_m3(clean_value(infobox.get("objętość")))
    implied_ha = volume / mean_depth / 10000 if volume and mean_depth else None
    volume_agrees = bool(implied_ha) and 1 / 3 <= area_ha / implied_ha <= 3
    shore = parse_length_m(clean_value(infobox.get("długość brzegu") or infobox.get("długość linii brzegowej")))
    # No shape with perimeter P can enclose more than P² / 4π (isoperimetric inequality).
    if shore and area_ha * 10000 > 1.1 * shore * shore / (4 * 3.141592653589793):
        return "jest większa, niż pozwala podana długość linii brzegowej"
    length = parse_length_m(clean_value(infobox.get("max długość")))
    width = parse_length_m(clean_value(infobox.get("max szerokość")))
    if length and width and length >= 20 and width >= 20 and area_ha * 10000 > 10 * length * width:
        return "jest ponad 10 razy większa niż prostokąt o podanej długości i szerokości jeziora"
    text_ha, text_value = _text_area_ha(sentences)
    if text_ha and not (1 / 3 <= area_ha / text_ha <= 3):
        return f"różni się od powierzchni podanej w treści artykułu ({text_value})"
    if area_ha >= LARGE_AREA_HA:
        corroborated = (text_ha and 1 / 3 <= area_ha / text_ha <= 3) or volume_agrees or \
            (length and width and length * width * 3 >= area_ha * 10000)
        if not corroborated:
            return "jest bardzo duża, a artykuł nie zawiera danych, które by ją potwierdzały"
    return None


DMS = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*°\s*(?:(\d+(?:[.,]\d+)?)\s*(?:′|'|’|‘)\s*)?"
    r"(?:(\d+(?:[.,]\d+)?)\s*(?:″|\"|”|“|''|’’)?\s*)?,?\s*([NSEW])\b",
)


def parse_coordinates(text):
    if not text:
        return None
    found = DMS.findall(text)
    lat = lon = None
    for deg, minutes, seconds, hemisphere in found:
        value = float(deg.replace(",", ".")) + float((minutes or "0").replace(",", ".")) / 60 + \
            float((seconds or "0").replace(",", ".")) / 3600
        if hemisphere in "NS" and lat is None:
            lat = value if hemisphere == "N" else -value
        elif hemisphere in "EW" and lon is None:
            lon = value if hemisphere == "E" else -value
    if lat is None or lon is None:
        decimal = re.findall(r"(-?\d{2}[.,]\d+)", text)
        if len(decimal) >= 2:
            lat, lon = float(decimal[0].replace(",", ".")), float(decimal[1].replace(",", "."))
        else:
            return None
    if 48.9 <= lat <= 55.0 and 14.0 <= lon <= 24.3:
        return round(lat, 5), round(lon, 5)
    return None


def page_coordinates(wikitext):
    """Coordinates from the infobox, else from a {{Współrzędne}} template, else None."""
    start, end = find_infobox(wikitext)
    if start is not None:
        found = parse_coordinates(clean_value(parse_infobox(wikitext[start:end]).get("współrzędne")))
        if found:
            return found
    return body_coordinates(wikitext)


def body_coordinates(text):
    """Coordinates from a {{Współrzędne|...}} template in the article body."""
    match = re.search(r"\{\{\s*współrzędne\s*\|([^{}]*)\}\}", text, flags=re.IGNORECASE)
    if not match:
        return None
    params = [p for p in match.group(1).split("|") if "=" not in p]
    return parse_coordinates(" ".join(params))


# ----------------------------------------------------------------------------- sentences

def _split_sentences(paragraph):
    sentences, start = [], 0
    for match in re.finditer(rf"[.!?](?=\s+[{PL_UPPER}„\"(\[])", paragraph):
        before = paragraph[start:match.start()]
        token = re.search(rf"([{PL_WORD}.]+)$", before)
        word = token.group(1) if token else ""
        lower = word.lower()
        if lower in ABBREVIATIONS:
            continue
        if len(word) == 1 and word.isupper():  # an initial, e.g. "A. Choiński"
            continue
        if word.isdigit() and len(word) != 4:  # an ordinal, e.g. "w latach 70. XX wieku"
            continue
        sentences.append(paragraph[start:match.end()].strip())
        start = match.end()
    tail = paragraph[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


def article_blocks(wikitext):
    """Split the article body (without its infobox) into (section heading, sentence) pairs.
    Sentences keep their wikilinks. Consecutive list items become one block, joined to the
    line before them when that line ends with a colon."""
    start, end = find_infobox(wikitext)
    if start is not None:
        wikitext = wikitext[:start] + wikitext[end:]
    text = strip_comments_and_refs(wikitext)
    text = unwrap_simple_templates(text)
    text = remove_templates(text)
    text = remove_tables(text)
    text = remove_files_and_categories(text)
    text = re.sub(r"<gallery.*?</gallery>", "", text, flags=re.IGNORECASE | re.DOTALL)
    cut = re.search(r"^==+\s*(przypisy|bibliografia|linki zewnętrzne|zobacz też|uwagi)\s*==+",
                    text, flags=re.IGNORECASE | re.MULTILINE)
    if cut:
        text = text[:cut.start()]

    blocks = []  # [heading, text, is_list]
    heading = ""
    for line in text.split("\n"):
        stripped = line.strip()
        heading_match = re.match(r"^(=+)\s*(.*?)\s*\1$", stripped)
        if heading_match:
            heading = render_plain(heading_match.group(2))
            blocks.append(None)
            continue
        if not stripped or stripped.startswith(("__", "{|", "|", "!")):
            blocks.append(None)
            continue
        if stripped[0] in "*#:;":
            item = stripped.lstrip("*#:; ").strip()
            if not item:
                continue
            previous = blocks[-1] if blocks else None
            if previous and previous[2]:
                previous[1] = previous[1].rstrip(" .;,") + "; " + item
            elif previous and previous[1].rstrip().endswith(":"):
                previous[1] = previous[1].rstrip() + " " + item
                previous[2] = True
            else:
                blocks.append([heading, item, True])
            continue
        blocks.append([heading, stripped, False])

    result = []
    for block in blocks:
        if block:
            for sentence in _split_sentences(block[1]):
                result.append((block[0], sentence))
    return result


# ----------------------------------------------------------------------------- fish

COMPILED_SPECIES = [
    (species["key"], [re.compile(rf"(?<![{PL_WORD}]){p}(?![{PL_WORD}])") for p in species["patterns"]])
    for species in gatunki.SPECIES
]
FISHERY_TYPE_PATTERNS = [(name, re.compile(rf"(?<![{PL_WORD}]){p}")) for name, p in gatunki.FISHERY_TYPES]
ADJECTIVE = re.compile(r"ow(?:y|e|a|ego|ej|ych|ym|ymi|o)$|owo[\s\-‐‑–]", re.IGNORECASE)
FISHERY_CONTEXT = re.compile(r"typ|rybac|jezior\w*\s+(?:typu\s+)?(?:sielaw|sandacz|leszcz|linow|karasi)",
                             re.IGNORECASE)


def species_in_text(plain):
    """Species named in plain text. Multi-word names are matched first and blank their span."""
    found = []
    text = plain
    for key, patterns in COMPILED_SPECIES:
        for pattern in patterns:
            def blank(match, key=key):
                found.append(key)
                return " " * len(match.group(0))
            text = pattern.sub(blank, text)
    return list(dict.fromkeys(found))


def species_in_sentence(sentence, link_aliases):
    """Species named in one wikitext sentence. Returns (from links to fish articles, from plain text).

    For a link, the visible label decides when it names a fish ([[Tołpyga biała|tołpyga]] counts
    as "tołpyga", without the species), otherwise the article it points to does. Text outside
    links is matched separately so nothing is counted twice."""
    linked, plain_named = [], []
    for match in LINK.finditer(sentence):
        target = match.group(1).split("#")[0].strip().replace("_", " ")
        target = re.sub(r"\s+", " ", target)
        target = target[:1].upper() + target[1:]
        label = render_plain(match.group(2) if match.group(2) is not None else match.group(1))
        from_label = species_in_text(label)
        if target in link_aliases:
            if from_label:
                linked.extend(from_label)
            elif not ADJECTIVE.search(label):  # [[sielawa|sielawowe]] names a lake type, not a fish
                linked.append(link_aliases[target])
        else:
            plain_named.extend(from_label)
    outside = render_plain(LINK.sub(" | ", sentence))
    plain_named.extend(species_in_text(outside))
    return list(dict.fromkeys(linked)), list(dict.fromkeys(plain_named))


def shorten(plain, limit=500):
    """Very long list-like sentences are cut to the clauses that mention fish."""
    if len(plain) <= limit:
        return plain
    clauses = [c.strip() for c in re.split(r";\s+", plain) if c.strip()]
    keep = [clauses[0]] + [c for c in clauses[1:] if species_in_text(c)]
    text = " … ".join(dict.fromkeys(keep))
    return text if len(text) < len(plain) else plain


def split_clauses(sentence):
    """Split a wikitext sentence at semicolons that are not inside links."""
    clauses, depth, current = [], 0, []
    i = 0
    while i < len(sentence):
        if sentence.startswith("[[", i):
            depth += 1; current.append("[["); i += 2; continue
        if sentence.startswith("]]", i):
            depth = max(0, depth - 1); current.append("]]"); i += 2; continue
        if sentence[i] == ";" and depth == 0:
            clauses.append("".join(current).strip()); current = []
        else:
            current.append(sentence[i])
        i += 1
    clauses.append("".join(current).strip())
    return [c for c in clauses if c]


def _excluded(scope, named):
    past_only = (bool(PAST_TENSE.search(scope)) and not PRESENT_TENSE.search(scope)
                 and not RECENT.search(scope))  # a survey from this century still counts
    return bool(NOT_PRESENT.search(scope)) or past_only or bool(named and OTHER_WATER.search(scope))


def analyse_fish(sentences, link_aliases):
    """Return (species keys, evidence list, notes list, fishery types, fishery evidence).

    Each clause (part between semicolons) is judged together with the first clause of its
    sentence, so in "Dane: typ sielawowe; wpływa struga (a wcześniej ...)" the word
    "wcześniej" does not cancel the fishery type, while "Dawniej: sielawa; sieja" still
    cancels both fish."""
    species, evidence, notes = [], [], []
    types, type_evidence = [], []
    for heading, sentence in sentences:
        plain = render_plain(sentence)
        if len(plain) < 3:
            continue
        clauses = split_clauses(sentence)
        found = []
        for clause in clauses:
            linked, texted = species_in_sentence(clause, link_aliases)
            clause_plain = render_plain(clause)
            clause_types = []
            if FISHERY_CONTEXT.search(clause_plain) or FISHERY_CONTEXT.search(plain):
                clause_types = [name for name, pattern in FISHERY_TYPE_PATTERNS if pattern.search(clause_plain)]
            found.append((clause, linked, texted, clause_types))
        all_linked = [k for f in found for k in f[1]]
        all_texted = [k for f in found for k in f[2]]
        if not all_linked and not all_texted and not any(f[3] for f in found):
            continue

        strong = bool(STRONG_FISH_CONTEXT.search(plain)) or bool(STRONG_FISH_CONTEXT.search(heading))
        clear = [k for k in all_texted if k not in AMBIGUOUS_SPECIES]
        allow_ambiguous = bool(all_linked or strong or clear)
        has_context = (strong or bool(FISH_CONTEXT.search(plain)) or bool(FISH_CONTEXT.search(heading)) or
                       bool(all_linked) or len(set(all_texted)) >= 2)

        lead = render_plain(clauses[0])
        sentence_species, sentence_types, excluded = [], [], False
        for index, (clause, linked, texted, clause_types) in enumerate(found):
            if not allow_ambiguous:
                texted = [k for k in texted if k not in AMBIGUOUS_SPECIES]
            named = list(dict.fromkeys(linked + texted)) if has_context else []
            if not named and not clause_types:
                continue
            scope = render_plain(clause) if index == 0 else lead + " " + render_plain(clause)
            if _excluded(scope, named):
                excluded = True
                continue
            sentence_species.extend(named)
            sentence_types.extend(clause_types)

        if sentence_types:
            types.extend(sentence_types)
            type_evidence.append(shorten(plain))
        if sentence_species:
            item = {"s": shorten(plain), "sp": list(dict.fromkeys(sentence_species))}
            if heading:
                item["h"] = heading
            evidence.append(item)
            species.extend(sentence_species)
        elif excluded and not sentence_types:
            notes.append(shorten(plain))
    return (list(dict.fromkeys(species)), evidence, list(dict.fromkeys(notes)),
            list(dict.fromkeys(types)), list(dict.fromkeys(type_evidence)))


# ----------------------------------------------------------------------------- depth from text

TEXT_DEPTH = {
    "max": re.compile(r"(?:głębokoś\w*\s+maksymaln\w*|maksymaln\w*\s+głębokoś\w*|głębokoś\w*\s+max\w*)"
                      r"[^.;]{0,50}?(\d+(?:[,.]\d+)?(?:\s*[–\-]\s*\d+(?:[,.]\d+)?)?)\s*m(?![\w²])(?!\s*n\.\s*p\.\s*m)",
                      re.IGNORECASE),
    "mean": re.compile(r"(?:głębokoś\w*\s+średni\w*|średni\w*\s+głębokoś\w*)"
                       r"[^.;]{0,50}?(\d+(?:[,.]\d+)?(?:\s*[–\-]\s*\d+(?:[,.]\d+)?)?)\s*m(?![\w²])(?!\s*n\.\s*p\.\s*m)",
                       re.IGNORECASE),
}


def depth_from_text(sentences):
    result = {}
    for _, sentence in sentences:
        plain = render_plain(sentence)
        for kind, pattern in TEXT_DEPTH.items():
            if kind in result:
                continue
            match = pattern.search(plain)
            if match:
                value = match.group(1).replace(".", ",")
                result[kind] = (value, parse_numbers(value)[0][0], plain)
    return result


# ----------------------------------------------------------------------------- lake record

def display_name(title, infobox_name):
    name = clean_value(infobox_name) if infobox_name else ""
    if name and len(name) <= 80 and not re.search(r"[{}\[\]|=]", name):
        return name
    return re.sub(r"\s*\([^)]*\)$", "", title)


def is_water_body_article(wikitext, has_infobox):
    if has_infobox:
        return True
    if re.match(r"\s*#(?:redirect|patrz|przekieruj)", wikitext, flags=re.IGNORECASE):
        return False
    lead = render_plain(remove_templates(strip_comments_and_refs(wikitext)))[:600].lower()
    return bool(re.search(r"\b(?:jezior|zbiornik|zalew|staw|starorzecz|akwen|sztuczne jezioro)", lead))


def parse_lake(title, raw, link_aliases):
    wikitext = raw["wikitext"]
    start, end = find_infobox(wikitext)
    infobox = parse_infobox(wikitext[start:end]) if start is not None else {}
    if not is_water_body_article(wikitext, bool(infobox)):
        return None

    record = {"id": raw["pageid"], "t": title, "n": display_name(title, infobox.get("nazwa"))}

    coordinates = page_coordinates(wikitext) or raw.get("api_coordinates")
    if coordinates:
        record["lat"], record["lon"] = coordinates

    sentences = article_blocks(wikitext)

    dmax_text, dmax = parse_measure(clean_value(infobox.get("głębokość max") or infobox.get("głębokość maksymalna")))
    dmean_text, dmean = parse_measure(clean_value(infobox.get("głębokość średnia")))
    text_depth = depth_from_text(sentences) if (dmax is None or dmean is None) else {}
    if dmax is None and "max" in text_depth:
        dmax_text, dmax, quote = text_depth["max"]
        record["dmaxQ"] = quote
    if dmean is None and "mean" in text_depth:
        dmean_text, dmean, quote = text_depth["mean"]
        record["dmeanQ"] = quote
    warnings = []
    if dmax is not None and not 0 < dmax <= 120:
        warnings.append(f"Wikipedia podaje głębokość maksymalną {dmax_text} m, co jest niemożliwe dla "
                        "jeziora w Polsce, więc jej nie pokazujemy.")
        dmax = dmax_text = None
        record.pop("dmaxQ", None)
    if dmean is not None and (not 0 < dmean <= 60 or (dmax is not None and dmean > dmax)):
        warnings.append(f"Wikipedia podaje głębokość średnią {dmean_text} m, niezgodną z głębokością "
                        "maksymalną, więc jej nie pokazujemy.")
        dmean = dmean_text = None
        record.pop("dmeanQ", None)
    if dmax is not None:
        record["dmax"], record["dmaxT"] = dmax, dmax_text
    if dmean is not None:
        record["dmean"], record["dmeanT"] = dmean, dmean_text

    area_text, area = parse_area(clean_value(infobox.get("powierzchnia")))
    if area is not None:
        conflict = area_conflict(area, infobox, sentences, dmean)
        if conflict:
            warnings.append(f"Powierzchnia z Wikipedii ({area_text}) {conflict}, więc jej nie pokazujemy.")
            area_text = area = None
    if area_text:
        record["areaT"] = area_text
        if area is not None:
            record["area"] = area
    if warnings:
        record["warn"] = warnings

    elevation_text, elevation = parse_measure(clean_value(infobox.get("wysokość lustra")),
                                              r"\s*m(?:\s*n\.\s*p\.\s*m\.?)?$")
    if elevation is not None:
        record["elevT"] = elevation_text

    species, evidence, notes, types, type_evidence = analyse_fish(sentences, link_aliases)
    if species:
        record["fish"] = species
        record["ev"] = evidence
    if notes:
        record["notes"] = notes
    if types:
        record["ftype"] = types
        record["ftypeQ"] = type_evidence
    record["rev"] = raw.get("revision_timestamp", "")[:10]
    return record

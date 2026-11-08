"""Minimal, polite client for the Polish Wikipedia API (standard library only)."""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API_URL = "https://pl.wikipedia.org/w/api.php"
USER_AGENT = os.environ.get(
    "WIKI_USER_AGENT",
    "Patofishing/1.0 (quarterly data refresh for a lake information website) python-urllib",
)
# Minimum pause between requests, in seconds. Wikimedia asks bots to make serial requests.
MIN_INTERVAL = float(os.environ.get("WIKI_MIN_INTERVAL", "1.0"))

_last_request = 0.0


def get(params, max_attempts=12):
    """GET the API with the given params and return the parsed JSON. Retries on 429/5xx/maxlag."""
    global _last_request
    query = dict(params, format="json", formatversion="2", maxlag="5")
    url = API_URL + "?" + urllib.parse.urlencode(query)
    delay = 5
    for attempt in range(1, max_attempts + 1):
        wait = MIN_INTERVAL - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.monotonic()
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                data = json.loads(response.read().decode("utf-8"))
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
            continue
        if "error" in data:
            if data["error"].get("code") == "maxlag":
                time.sleep(delay)
                delay = min(delay * 2, 120)
                continue
            raise RuntimeError(f"API error {data['error']} for {url}")
        return data
    raise RuntimeError(f"Giving up after {max_attempts} attempts: {url}")


def get_all_pages(params):
    """Follow continuation for a prop query; yield each page once with list props merged."""
    pages = {}
    cont = {}
    while True:
        data = get(dict(params, **cont))
        for page in data.get("query", {}).get("pages", []):
            merged = pages.setdefault(page["title"], {"title": page["title"]})
            for key, value in page.items():
                if isinstance(value, list):
                    merged.setdefault(key, []).extend(value)
                else:
                    merged.setdefault(key, value)
        if "continue" not in data:
            break
        cont = data["continue"]
    yield from pages.values()


def get_all(params, list_key):
    """Follow API continuation for a list query and yield every item of query[list_key]."""
    cont = {}
    while True:
        data = get(dict(params, **cont))
        for item in data.get("query", {}).get(list_key, []):
            yield item
        if "continue" not in data:
            return
        cont = data["continue"]

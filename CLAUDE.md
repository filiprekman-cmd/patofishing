# patofishing: kontekst projektu

Strona po polsku o polskich jeziorach i zbiornikach: głębokość, powierzchnia, gatunki ryb
wymienione w Wikipedii (z cytatem zdania źródłowego) oraz sekcja „Połowy”, w której
użytkownicy wrzucają zdjęcia ryb z wymiarami. Właściciel pisze po polsku, odpowiadaj po polsku.

## Preferencje właściciela (obowiązkowe)

- Żadnych fioletowych gradientów, przycisków w kształcie pigułki, emoji jako ikon, myślników
  (em dash, en dash) w tekstach strony, zmyślonych opinii, liczników ani metryk.
- Żadnego ogólnikowego tekstu w hero, „AI slop” w tekstach i zdjęciach, animacji kursora,
  przesadzonych animacji przy przewijaniu.
- Przed startem: własna domena, favicon, brak znaczka „Made with AI”, polityka prywatności
  i regulamin (oba istnieją, trzeba uzupełnić pola `[UZUPEŁNIJ]`).
- „Make no mistakes”: dane muszą być prawdziwe i sprawdzalne. Nic nie wymyślać.
- Ostatnia prośba: „premium design”, różnorodne kolory, lepsze boxy, animacje z umiarem,
  mniej rzeczy na jednym ekranie (osobne widoki).

## Stan prac (WAŻNE)

Trwa przebudowa wyglądu. Gotowe są już NOWE pliki:
- `site/assets/style.css`: ciemny motyw „nocne jezioro”, fonty DM Serif Display + Manrope
  (w `site/fonts/`), akcenty: aqua, sky, amber, coral, reed, sand.
- `site/index.html`: nowa struktura z widokami `#view-start`, `#view-explore`, `#view-lake`,
  `#view-catches` i formularzem połowu w `<dialog id="catch-dialog">`.

NIE są jeszcze dostosowane (pasują do starego HTML i obecnie nie zadziałają):
- `site/assets/app.js`: do napisania od nowa pod nowy HTML. Plan:
  - routing po hashu: `#start` (domyślny), `#jeziora`, `#j<pageid>` (strona jeziora), `#polowy`;
  - Start: hero z wyszukiwarką i podpowiedziami (`#hero-q`, `#hero-suggest`), fakty (`#facts`,
    `#updated`, `#hero-count`), mapa `#hero-map` z jednorazową animacją „zapalania się” punktów,
    zestawienia `#rankings` (najgłębsze, największe, najwięcej ryb w artykule; top 5 z danych),
    kafelki gatunków `#species-grid` (top 8, bez wpisów „bez podania gatunku”);
  - Jeziora: filtry `#f-q #f-voiv #f-kind #f-fish #f-sort #f-onlyfish`, lista kart `#results`
    (po 40, `#more-btn`), mapa `#map` z przyciskami `#zoom-in/out/reset` (bez zoomu kółkiem),
    przełącznik Lista/Mapa na telefonie (`#mode-list`, `#mode-map`, atrybut `data-mode`);
  - Strona jeziora: `#lake-hero` (nazwa, mapka-lokalizator z pulsującym „sygnałem echosondy”),
    `#lake-body` (4 kafelki `.stat` z `--accent`, wskaźnik głębokości `.gauge` względem
    najgłębszego jeziora w bazie, ryby, cytaty w `<details>`, uwagi `.warn`, kontener na połowy,
    linki do Wikipedii i OpenStreetMap);
  - eksport `window.patofishing` dla `catches.js` (ready, state, h, fold, formatDate, plural,
    numberFmt, collator, onLakeSelected, showView, applyHash, catchesEnabled).
- `site/assets/catches.js`: działa logicznie, ale trzeba go przepiąć na `<dialog>` (otwieranie
  `showModal()`, `#c-close`), dodać zapowiedź na Starcie (`#start-catches`) i nowe klasy kart
  (`.card .card-link`, `.photo-wrap` z plakietką długości).
- `site/o-danych.html`, `site/polityka-prywatnosci.html`, `site/regulamin.html`: mają stary
  nagłówek (`.site-header`, `.brand`), trzeba przenieść na nowy (`.nav`, `.prose-wrap`).

Ostatnia DZIAŁAJĄCA wersja (stary jasny wygląd) jest w `archiwum/wersja-1-claude-ai/`
(to dokładnie to, co jest opublikowane jako Artifact). Stamtąd można wziąć logikę mapy na
canvasie, filtrów, karty jeziora i połowów.

## Dane

- `scripts/update_data.py` (tylko biblioteka standardowa) pobiera z pl.wikipedia.org artykuły
  z kategorii „Jeziora w województwie …” i „Sztuczne zbiorniki wodne w województwie …”
  (wyszukiwanie `deepcat`, treść przez Specjalna:Eksport), parsuje i zapisuje
  `site/data/lakes.json`. Kontrole: min. 2000 akwenów, spadek najwyżej 10%, jeziora kontrolne.
  Opcje: `--cache DIR`, `--offline`, `--output PLIK`.
- `scripts/parse_lakes.py`: infoboks, głębokość z tekstu jako zapas, kontrole spójności
  (średnia > maksymalnej, nierówność izoperymetryczna dla powierzchni i linii brzegowej,
  porównanie z tekstem, bardzo duże powierzchnie muszą mieć potwierdzenie). Ryby: linki
  i odmiana nazw, pomijane zdania przeczące, historyczne, o przepisach i o innych wodach.
- `scripts/gatunki.py`: słownik ok. 64 gatunków z wzorcami odmiany i tytułami artykułów.
- `site/data/poland.json`: kontur Polski i sąsiadów (Natural Earth, domena publiczna).
- Stan danych: 8 listopada 2026, 3056 akwenów, 1968 z głębokością, 433 z rybami.
- Wikimedia mocno limituje zapytania z chmury: skrypt ma pauzy i obsługę 429. Środowisko
  potrzebuje dostępu do hosta pl.wikipedia.org.

## Publikacja i aktualizacje

- Artifact na claude.ai (prywatny podgląd, konto poprzednie): https://claude.ai/artifact/9ra4wA6S3x5BMYQzrL7o3o
  Capabilities: db (reguły: `catches` read view / write owner, `catches/{self}` write interact),
  user, assets (`upload: "interact"`). Wpis połowu: dokument `catches/<userId>` = `{items: [...]}`.
  Na nowym koncie trzeba opublikować nowy Artifact (`python3 scripts/build_artifact.py`
  buduje `artifact-build/`).
- Na poprzednim koncie jest zadanie co 3 miesiące (1 lutego, 1 maja, 1 sierpnia, 1 listopada,
  4:17 czasu polskiego), które aktualizuje dane tamtego Artifactu. Po przejściu na nowe konto
  trzeba je utworzyć od nowa albo korzystać z GitHub Actions.
- `.github/workflows/aktualizacja-danych.yml`: GitHub Pages + kwartalna aktualizacja danych
  (Settings, Pages, Source: GitHub Actions). Na GitHub Pages sekcja „Połowy” jest ukryta,
  bo nie ma backendu (do zrobienia: np. Supabase).

## Do zrobienia

1. Dokończyć przebudowę (app.js, catches.js, podstrony), przetestować w Playwright
   (komputer i telefon, brak błędów w konsoli, brak poziomego przewijania).
2. Własna domena (właściciel musi ją podać), uzupełnić `[UZUPEŁNIJ]` w polityce i regulaminie.
3. Backend na zdjęcia dla wersji na własnej domenie.

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

## Stan prac

Przebudowa wyglądu jest skończona i przetestowana (Playwright: komputer i telefon, bez błędów
w konsoli, bez poziomego przewijania, dodawanie i usuwanie połowu na atrapie środowiska).
- `site/assets/style.css`: jeden ciemny motyw „nocne jezioro”, fonty DM Serif Display + Manrope
  (w `site/fonts/`), akcenty: aqua, sky, amber, coral, reed, sand. Głębokość na mapach: rampa
  `--d1`..`--d5` sprawdzona walidatorem kontrastu.
- `site/index.html`: widoki `#view-start`, `#view-explore`, `#view-lake`, `#view-catches`,
  formularz połowu w `<dialog id="catch-dialog">`.
- `site/assets/app.js`: routing po hashu `#start`, `#jeziora`, `#j<pageid>`, `#polowy`;
  mapy na canvasie (`createMap`): hero z animacją pojawiania się punktów, wyszukiwarka
  z przesuwaniem i przybliżaniem przyciskami, lokalizator na stronie jeziora z pulsującym
  sygnałem. Eksportuje `window.patofishing` dla `catches.js`.
- `site/assets/catches.js`: galeria, formularz w oknie dialogowym, zapowiedź na Starcie,
  połowy na stronie jeziora (`#lake-catches`). Zdjęcie jest zmniejszane do 1600 px i
  przekodowane przez canvas, co usuwa EXIF i GPS.
- `archiwum/wersja-1-claude-ai/`: pierwsza (jasna) wersja, tylko do wglądu.

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

1. Własna domena (właściciel musi ją podać), uzupełnić `[UZUPEŁNIJ]` w polityce i regulaminie.
2. Backend na zdjęcia dla wersji na własnej domenie.

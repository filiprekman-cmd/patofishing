# patofishing

Strona z głębokością, powierzchnią i gatunkami ryb polskich jezior i zbiorników, z sekcją
„Połowy”, w której użytkownicy dodają zdjęcia złowionych ryb z wymiarami.

## Skąd są dane

`scripts/update_data.py` pobiera z polskiej Wikipedii wszystkie artykuły z kategorii
„Jeziora w województwie…” i „Sztuczne zbiorniki wodne w województwie…”, odczytuje głębokość,
powierzchnię i współrzędne, wyszukuje ryby wymienione w tekście (razem ze zdaniem źródłowym)
i zapisuje wynik w `site/data/lakes.json`. Plik zostaje podmieniony tylko wtedy, gdy nowe dane
przejdą kontrole (liczba jezior, wartości kontrolne dla dużych jezior).

```bash
python3 scripts/update_data.py
```

Skrypt używa tylko biblioteki standardowej Pythona 3.10+. Zajmuje kilka minut, bo Wikipedia
ogranicza tempo zapytań.

## Struktura

- `site/`: gotowa strona statyczna (HTML, CSS, JS, dane, fonty, favicon).
- `site/polityka-prywatnosci.html`, `site/regulamin.html`: przed publikacją uzupełnij pola `[UZUPEŁNIJ]`.
- `scripts/`: pobieranie i przetwarzanie danych, budowa wersji na claude.ai.
- `.github/workflows/aktualizacja-danych.yml`: publikacja na GitHub Pages i automatyczna
  aktualizacja danych 1 lutego, 1 maja, 1 sierpnia i 1 listopada.

## Publikacja na własnej domenie (GitHub Pages)

1. Utwórz repozytorium na GitHubie i wgraj do niego ten katalog.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Settings → Pages → Custom domain: wpisz swoją domenę, a u rejestratora domeny ustaw rekordy DNS
   wskazane przez GitHuba. Zaznacz „Enforce HTTPS”.
4. Uzupełnij `[UZUPEŁNIJ]` w polityce prywatności i regulaminie.

## Sekcja „Połowy”

Zapisywanie zdjęć i wpisów działa w wersji opublikowanej na claude.ai (baza danych i pliki
dostarcza tam platforma). Na zwykłym hostingu statycznym (GitHub Pages) sekcja jest ukryta,
dopóki nie podłączy się serwera na zdjęcia i wpisy, np. Supabase, z kontami użytkowników
i moderacją.

## Licencje

Dane o jeziorach: polska Wikipedia, CC BY-SA 4.0. Kontur mapy: Natural Earth (domena publiczna).
Fonty Barlow, Barlow Condensed, Source Serif 4: SIL OFL 1.1 (pliki licencji w `site/fonts/`).

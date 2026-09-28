# PDF fonts (ADR 008)

Static TrueType instances embedded (subsetted) in the generated PDFs. The web app uses the same families as WOFF2
subsets from `@fontsource-variable/*`; PDF engines need whole TrueType files, hence these copies.

| File | Family / weight | Instantiated from | SHA-256 |
|---|---|---|---|
| `Cairo-Regular.ttf` | Cairo 400 (slnt 0) | `ofl/cairo/Cairo[slnt,wght].ttf` | `6385d47c429cdebbda24f584074f345d4622dac317433e3ebd41eb5e9981829a` |
| `Cairo-Bold.ttf` | Cairo 700 (slnt 0) | `ofl/cairo/Cairo[slnt,wght].ttf` | `39788d25b23768d605e71f298b2d333e74bec9ca7f895f666166db49fe4687f6` |
| `SourceSans3-Regular.ttf` | Source Sans 3 400 | `ofl/sourcesans3/SourceSans3[wght].ttf` | `8837d52d008027eff9197eaf5fb85e43858b689d5e0de6e2d26eb6f15580cd3a` |
| `SourceSans3-Bold.ttf` | Source Sans 3 700 | `ofl/sourcesans3/SourceSans3[wght].ttf` | `d32efc29d80c3a58f302c90a6378993cae95a76a0dedd2750c6e6e6ba956af61` |

Source: the Google Fonts repository (`https://github.com/google/fonts`, branch `main`, downloaded 2026-09-28). The
variable files used had these SHA-256:

- `Cairo[slnt,wght].ttf` — `667c987182391c91f4e57a2f455b1794fb5e3ee6ca4ef3383e86bb690fa9c964`
- `SourceSans3[wght].ttf` — `042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9`

Command (fontTools 4.x):

```sh
fonttools varLib.instancer 'Cairo[slnt,wght].ttf' wght=400 slnt=0 -o Cairo-Regular.ttf
fonttools varLib.instancer 'Cairo[slnt,wght].ttf' wght=700 slnt=0 -o Cairo-Bold.ttf
fonttools varLib.instancer 'SourceSans3[wght].ttf' wght=400 -o SourceSans3-Regular.ttf
fonttools varLib.instancer 'SourceSans3[wght].ttf' wght=700 -o SourceSans3-Bold.ttf
```

Licence: SIL Open Font License 1.1 (`OFL-Cairo.txt`, `OFL-SourceSans3.txt`).

**Changing a file changes the bytes of every PDF issued afterwards** (stored PDFs are never re-rendered, ADR 008 §5).
Record the new hashes here and bump nothing else: the renderer string stored with each document names the engine,
not the fonts.

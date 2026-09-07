# Lifts dashboard

Parses workout logs and generates an interactive HTML report: strength
trends, personal records, effort heatmap, and 90-day projections.
`Lift_Progress_Report.html` is prebuilt from my own logs and works
standalone (open it in any browser; charts load Plotly from CDN).

## Input your own data

The page is fully self-contained — the CSVs are only needed at build time
to bake the data in. To build with your own logs:

1. Create three CSVs next to `lifts.py` (filenames drive the day split —
   any `Lifts - <Day>.csv` works, e.g. add `Lifts - Arms.csv`):
   `Lifts - Push.csv`, `Lifts - Pull.csv`, `Lifts - Legs.csv`
2. Layout: first column is the date (`MM/DD/YYYY`), one column per
   exercise (any names), cells are `reps x weight` (e.g. `6x225`).
   Blank = skipped that day. Bodyweight moves use `0` weight (`8x0`):

   | Date      | Bench Press | Overhead Press | Dips |
   |-----------|-------------|----------------|------|
   | 1/05/2026 | 6x135       | 8x65           | 8x0  |
   | 1/12/2026 | 5x145       | 6x75           |      |

3. Run the build (needs `pandas numpy plotly`):

```bash
pip install -r requirements.txt
python lifts.py
```

This regenerates `Lift_Progress_Report.html` with your data baked in.
The CSVs never need to be committed — only the script and the HTML.
Real `Lifts - *.csv` files are gitignored; commit only `*.EXAMPLE.csv` templates.
`Lifts - Push.EXAMPLE.csv` / `Lifts - Pull.EXAMPLE.csv` show the expected format.

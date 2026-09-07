# Trade Lab (fantasy football)

Interactive single-file web app for evaluating fantasy-football trades:
trade packages across several archetypes (need-filler, stud consolidation,
value snipe, win-win...), roster values, positional needs, power rankings,
and a team builder. **The app is `trade_lab.html`** — everything (data,
styling, logic) is baked in. Open it in any browser; no server, no build,
no dependencies.

It ships with a fictional demo league (managers like `Alex Example`; NFL
player names are real public data).

## Input your own data

No files to edit — use the **Data** menu in the page:

- **Upload league JSON** — a top-level array of team objects. Each roster
  entry needs `name`, `position`, and the NFL `team` abbreviation:

```json
[
  {
    "team_name": "Turbo Blitz",
    "owner": "Alex Example",
    "roster": [
      {"name": "Josh Allen", "position": "QB", "team": "BUF"},
      {"name": "Jahmyr Gibbs", "position": "RB", "team": "DET"}
    ]
  }
]
```

- **Upload rankings CSV** — one row per player with exact headers
  `Rank,Name,Team,Position,Expert Rank` (`Tier` optional):

```csv
Rank,Name,Team,Position,Expert Rank,Tier
1,Jahmyr Gibbs,DET,RB,1,1
2,Bijan Robinson,ATL,RB,2,1
```

Uploads apply instantly in the page (nothing is sent anywhere — it all
runs locally). Saved trades can be exported to CSV from the Trades view.

Note: the header's refresh button targets the original monorepo's live
data paths and will report "Embedded" here — harmless; the embedded demo
data and your uploads are what the page actually uses.

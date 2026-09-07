import math
import re
from datetime import datetime
from pathlib import Path
import numpy as np
import pandas as pd

# All data files live next to this script -- never rely on the caller's
# working directory.
SCRIPT_DIR = Path(__file__).resolve().parent

# get exercises sorted by day (push, pull, legs) then alphabetially within each day
def exercises_by_day(df):
    """sorts exercises by day (push, pull, legs) then alphabetically"""
    day_order = ["Push", "Pull", "Legs"]
    present = [d for d in day_order if d in df["day"].values]
    order = []
    for day in present:
        order.extend(sorted(df.loc[df["day"] == day, "exercise"].unique()))
    return order


# get the color for an exercise from the color map
def exercise_color(exercise: str, color_map: dict = None) -> str:
    """grab color for exercise from the map"""
    if color_map and exercise in color_map:
        return color_map[exercise]
    return "#ffffff"


# build a color map where each exercise gets its own color spread around the color wheel
def build_color_map(exercises) -> dict:
    """makes a color for each exercise, spreads them around the color wheel"""
    import colorsys
    sorted_ex = sorted(exercises)
    n = len(sorted_ex)
    colors = {}
    for i, ex in enumerate(sorted_ex):
        hue = i / n  # evenly space the hues
        r, g, b = colorsys.hsv_to_rgb(hue, 0.85, 0.95)
        colors[ex] = f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}"
    return colors


# parsing
def parse_cell(cell: str):
    """turns '6x235' into (6, 235). returns none if empty or bad."""
    if not isinstance(cell, str) or "x" not in cell.strip():
        return None, None
    parts = cell.strip().split("x")
    try:
        return int(parts[0]), float(parts[1])
    except (ValueError, IndexError):
        return None, None


# estimate 1 rep max using average of epley and lombardi formulas
def est_1rm(weight, reps):
    """estimates 1rm using average of epley and lombardi formulas"""
    if weight is None or reps is None or weight <= 0 or reps <= 0 or reps >= 37:
        return 0.0

    epley = weight * (1 + reps / 30)
    lombardi = weight * reps ** 0.10

    return (epley + lombardi) / 2 * 1.03


# strip trailing ' 2', ' 3' etc from column names so multiple sets merge into one exercise
def _base_exercise(col: str):
    """strips trailing ' 2', ' 3' etc from column names"""
    return re.sub(r"\s+\d+$", "", col.strip())


# load a lift csv into a tidy dataframe where each row is one set
def load_csv(path: str, label: str) -> pd.DataFrame:
    """loads a lift csv into a tidy dataframe. each row is one set."""
    raw = pd.read_csv(path)
    raw.columns = raw.columns.str.strip()
    date_col = raw.columns[0]  # first column is the date
    exercise_cols = raw.columns[1:]  # rest are exercises

    records = []
    for _, row in raw.iterrows():
        raw_date = str(row[date_col]).strip()
        # Tolerate 2-digit years ("9/3/26") and skip blank/malformed dates
        # with a warning instead of crashing the whole build.
        try:
            if re.fullmatch(r"\d{1,2}/\d{1,2}/\d{2}", raw_date):
                date = datetime.strptime(raw_date, "%m/%d/%y")
            else:
                date = pd.to_datetime(raw_date, format="%m/%d/%Y")
        except (ValueError, TypeError):
            print(f"  warning: skipping row with bad date {raw_date!r} in {path}")
            continue
        for ex in exercise_cols:
            reps, weight = parse_cell(row[ex])
            if weight is not None:
                exercise = _base_exercise(ex)
                strength = est_1rm(weight, reps)
                records.append({
                    "date":     date,
                    "day":      label,
                    "exercise": exercise,
                    "reps":     reps,
                    "weight":   weight,
                    "volume":   reps * weight,
                    "est_1rm":  strength,
                })

    df = pd.DataFrame(records)
    return df


# find and load all Lifts - *.csv files next to this script
def load_all():
    """finds and loads all Lifts - *.csv files next to this script"""
    csv_paths = sorted(SCRIPT_DIR.glob("Lifts - *.csv"))
    if not csv_paths:
        raise FileNotFoundError("No 'Lifts - *.csv' files found.")

    frames = []
    for path in csv_paths:
        label = path.name.replace("Lifts - ", "").replace(".csv", "")
        frames.append(load_csv(path, label))
    return pd.concat(frames, ignore_index=True)


# get the best set (highest est_1rm) for each exercise per date
def best_set_per_day(df: pd.DataFrame) -> pd.DataFrame:
    """gets the best set (highest est_1rm) for each exercise per day"""
    idx = df.groupby(["exercise", "date"])["est_1rm"].idxmax()
    return df.loc[idx].copy()


# aggregate data by day, exercise, and date
def daily_agg(df: pd.DataFrame) -> pd.DataFrame:
    """aggregates by day, exercise, date"""
    result = (
        df.groupby(["day", "exercise", "date"])
        .agg(
            avg_reps=("reps", "mean"),
            total_volume=("volume", "sum"),
            avg_weight=("weight", "mean"),
            max_strength=("est_1rm", "max"),
            exercises=("exercise", "first"),
            sets=("reps", "count"),
        )
        .reset_index()
    )
    result["avg_reps"] = result["avg_reps"].round(2)
    result["avg_weight"] = result["avg_weight"].round(1)
    result["est_1rm"] = result.apply(
        lambda r: est_1rm(r["avg_weight"], r["avg_reps"]),
        axis=1
    )
    result.drop(columns=["max_strength", "exercises"], inplace=True)
    return result


# get stats per session (volume, weight, reps, 1rm)
def session_stats(df: pd.DataFrame) -> pd.DataFrame:
    """stats per session"""
    return (
        df.groupby(["day", "exercise", "date"])
        .agg(
            total_volume=("volume", "sum"),
            max_weight=("weight", "max"),
            best_reps=("reps", "max"),
            best_1rm=("est_1rm", "max"),
            sets=("reps", "count"),
        )
        .reset_index()
    )


# main terminal output
def main():
    # load all the data
    df = load_all()
    ss = session_stats(df)
    bs = best_set_per_day(df)
    da = daily_agg(df)
    color_map = build_color_map(df["exercise"].unique())

    # terminal output - overall header
    print("=" * 70)
    print("LIFT PROGRESS REPORT")
    print("=" * 70)
    print(f"Dates: {df['date'].min().strftime('%Y-%m-%d')} to {df['date'].max().strftime('%Y-%m-%d')}")
    print(f"Total: {len(df)} sets, {df['volume'].sum():,.0f} lbs volume")
    print(f"Days tracked: {sorted(df['day'].unique())}")
    print(f"Exercises: {sorted(df['exercise'].unique())}")
    print(f"Total sessions: {df['date'].nunique()}")
    print(f"Avg weight: {df['weight'].mean():.1f} lbs, Avg reps: {df['reps'].mean():.1f}")
    print(f"Max single-set weight: {df['weight'].max():.0f} lbs, Max single-set reps: {df['reps'].max():.0f}")
    print()

    # per-exercise stats
    print("-" * 70)
    print("PER-EXERCISE STATS")
    print("-" * 70)
    for ex in sorted(df["exercise"].unique()):
        ex_df = df[df["exercise"] == ex]
        ex_da = da[da["exercise"] == ex].sort_values("date")
        ex_ss = ss[ss["exercise"] == ex]
        n_sessions = ex_df["date"].nunique()
        total_vol = ex_df["volume"].sum()
        avg_wt = ex_df["weight"].mean()
        min_wt = ex_df["weight"].min()
        max_wt = ex_df["weight"].max()
        avg_reps = ex_df["reps"].mean()
        min_reps = ex_df["reps"].min()
        max_reps = ex_df["reps"].max()
        if len(ex_da) >= 2 and ex_da["est_1rm"].iloc[0] > 0:
            growth = (ex_da["est_1rm"].iloc[-1] - ex_da["est_1rm"].iloc[0]) / ex_da["est_1rm"].iloc[0] * 100
            growth_str = f"{growth:+.1f}%"
            first_1rm = ex_da["est_1rm"].iloc[0]
            last_1rm = ex_da["est_1rm"].iloc[-1]
        else:
            growth_str = "N/A"
            first_1rm = 0
            last_1rm = 0
        print(f"{ex}:")
        print(f"  Sets: {len(ex_df)}, Sessions: {n_sessions}, Volume: {total_vol:,.0f} lbs")
        print(f"  Weight: min {min_wt:.0f}, avg {avg_wt:.0f}, max {max_wt} lbs")
        print(f"  Reps: min {min_reps:.0f}, avg {avg_reps:.1f}, max {max_reps:.0f}")
        print(f"  1RM: first {first_1rm:.0f}, max {ex_df['est_1rm'].max():.0f}, last {last_1rm:.0f}, growth: {growth_str}")

    print()
    print("-" * 70)
    print("PER-SESSION DETAILS (per exercise)")
    print("-" * 70)
    for ex in sorted(df["exercise"].unique()):
        ex_ss = ss[ss["exercise"] == ex].sort_values("date")
        print(f"{ex}:")
        for _, row in ex_ss.iterrows():
            print(f"  {row['date'].strftime('%Y-%m-%d')}: vol {row['total_volume']:,.0f} lbs, "
                  f"weight {row['max_weight']:.0f} lbs x {row['best_reps']:.0f}, "
                  f"1RM {row['best_1rm']:.0f}, sets {row['sets']:.0f}")

    print()
    print("-" * 70)
    print("PER-DAY")
    print("-" * 70)
    for day in sorted(df["day"].unique()):
        day_df = df[df["day"] == day]
        day_ex = sorted(day_df["exercise"].unique())
        print(f"{day}: {day_df['date'].nunique()} sessions, {len(day_df)} sets, {day_df['volume'].sum():,.0f} lbs")
        print(f"  Exercises: {day_ex}")
        for ex in day_ex:
            ex_day_df = day_df[day_df["exercise"] == ex]
            print(f"    {ex}: {len(ex_day_df)} sets, vol {ex_day_df['volume'].sum():,.0f} lbs, "
                  f"avg wt {ex_day_df['weight'].mean():.0f}, max 1RM {ex_day_df['est_1rm'].max():.0f}")

    print()
    print("-" * 70)
    print("PERSONAL RECORDS")
    print("-" * 70)
    for ex in sorted(ss["exercise"].unique()):
        ex_ss = ss[ss["exercise"] == ex]
        best = ex_ss["best_1rm"].max()
        row = ex_ss.loc[ex_ss["best_1rm"].idxmax()]
        max_wt = ex_ss["max_weight"].max()
        best_reps = ex_ss.loc[ex_ss["max_weight"].idxmax(), "best_reps"]
        best_vol = ex_ss["total_volume"].max()
        print(f"{ex}:")
        print(f"  Best 1RM: {best:.0f} lbs on {row['date'].strftime('%Y-%m-%d')}")
        print(f"  Heaviest set: {int(max_wt)} lbs x {best_reps} reps")
        print(f"  Best volume: {best_vol:,.0f} lbs")

    print()
    print("-" * 70)
    print("WEIGHT PROGRESSION")
    print("-" * 70)
    for ex in sorted(df["exercise"].unique()):
        ex_df = df[df["exercise"] == ex].sort_values("date")
        weights = ex_df.groupby("date")["weight"].max().sort_index()
        steps = []
        for w in weights.values:
            if not steps or steps[-1] != int(w):
                steps.append(int(w))
        print(f"{ex}: {' -> '.join(map(str, steps))}")

    print()
    print("-" * 70)
    print("REP RANGE DISTRIBUTION")
    print("-" * 70)
    def _rep_bucket(r):
        if r <= 5:   return "1-5"
        if r <= 8:   return "6-8"
        if r <= 12:  return "9-12"
        return "13+"
    for ex in sorted(df["exercise"].unique()):
        ex_df = df[df["exercise"] == ex]
        buckets = {"1-5": 0, "6-8": 0, "9-12": 0, "13+": 0}
        for r in ex_df["reps"]:
            buckets[_rep_bucket(r)] += 1
        print(f"{ex}: 1-5: {buckets['1-5']}, 6-8: {buckets['6-8']}, 9-12: {buckets['9-12']}, 13+: {buckets['13+']}")

    print()
    print("-" * 70)
    print("SESSION FREQUENCY")
    print("-" * 70)
    all_dates = sorted(df["date"].unique())
    if len(all_dates) > 1:
        gaps = [(all_dates[i+1] - all_dates[i]).days for i in range(len(all_dates)-1)]
        print(f"Total sessions: {len(all_dates)}")
        print(f"Avg gap between sessions: {sum(gaps)/len(gaps):.1f} days")
        print(f"Min gap: {min(gaps)} days, Max gap: {max(gaps)} days")
    print(f"All session dates: {[d.strftime('%Y-%m-%d') for d in all_dates]}")

    print()
    print("=" * 70)
    print("DONE")
    print("=" * 70)
    print()

    generate_html(df, ss, bs, da, color_map)


# interactive html report
def generate_html(df, ss, bs, da, color_map):
    """makes the html report with charts"""
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots

    def _dark_layout(**kwargs):
        layout = {
            "paper_bgcolor": "#0f0f1a",
            "plot_bgcolor": "#0f0f1a",
            "font": dict(color="#e2e2e2", family="sans-serif"),
            "hoverlabel": dict(bgcolor="#16213e", font_size=12, font_color="#e2e2e2"),
            "margin": dict(l=50, r=50, t=40, b=40),
            "xaxis": dict(gridcolor="#1f1f30", zerolinecolor="#1f1f30", gridwidth=1),
            "yaxis": dict(gridcolor="#1f1f30", zerolinecolor="#1f1f30", gridwidth=1),
        }
        for k, v in kwargs.items():
            if k in ("xaxis", "yaxis", "margin") and k in layout and isinstance(v, dict):
                layout[k].update(v)
            else:
                layout[k] = v
        return layout

    fragments = []

    # filter to only exercises done within last 6 days
    today = datetime.now().date()
    recent_by_ex = df.groupby("exercise")["date"].max().apply(lambda d: d.date())
    active_exercises = [ex for ex in df["exercise"].unique() if (today - recent_by_ex.get(ex, today)).days <= 9]
    if not active_exercises:
        active_exercises = [df["exercise"].unique()[0]]  # fallback to first if all are stale
    df = df[df["exercise"].isin(active_exercises)]
    ss = ss[ss["exercise"].isin(active_exercises)]
    da = da[da["exercise"].isin(active_exercises)]
    bs = bs[bs["exercise"].isin(active_exercises)]

    # header info
    date_min = df["date"].min().strftime("%B %d")
    date_max = df["date"].max().strftime("%B %d, %Y")
    n_sets = len(df)
    n_ex = df["exercise"].nunique()
    days_str = ", ".join(sorted(df["day"].unique()))

    # sidebar stuff
    sidebar_fragments = []
    sidebar_fragments.append(f"""
    <div class="sidebar">
        <div class="brand">
            <div class="logo"></div>
            <h1>LIFTS</h1>
        </div>
        <div class="stats-mini">
            <div class="stat-item">
                <span class="stat-label">Progress</span>
                <span class="stat-value">{date_min} - {date_max}</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">Total Volume</span>
                <span class="stat-value">{df['volume'].sum():,.0f} lbs</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">Workload</span>
                <span class="stat-value">{n_sets} sets &bull; {n_ex} exercises</span>
            </div>
        </div>
        <nav class="nav-links">
            <a href="#dashboard" class="nav-item active">
                <span class="nav-icon">📊</span>
                <span class="nav-text">Dashboard</span>
            </a>
            <a href="#projections" class="nav-item">
                <span class="nav-icon">📈</span>
                <span class="nav-text">Projections</span>
            </a>
            <div class="nav-divider">Lifts</div>""")

    for day_label in sorted(df["day"].unique()):
        anchor = day_label.lower().replace(" ", "-")
        sidebar_fragments.append(f"""
            <a href="#day-{anchor}" class="nav-item">
                <span class="nav-icon">💪</span>
                <span class="nav-text">{day_label}</span>
            </a>""")

    sidebar_fragments.append("""
        </nav>
        <div class="sidebar-footer">
            Generated on """ + datetime.now().strftime("%Y-%m-%d") + """
        </div>
    </div>
    """)

    fragments.append('<div class="main-content">')

    # dashboard
    fragments.append('<section id="dashboard" class="active-section">')
    fragments.append('<div class="page-header"><h1>Dashboard</h1><p>Performance overview and metrics</p></div>')

    # heatmap stuff
    ss_sorted = ss.sort_values(["exercise", "date"]).copy()
    ss_sorted["session_num"] = ss_sorted.groupby("exercise").cumcount() + 1
    pivot = ss_sorted.pivot_table(index="exercise", columns="session_num", values="best_1rm")
    if pivot.ndim == 1:
        pivot = pivot.to_frame()
    pivot = pivot.reindex(exercises_by_day(ss))

    exercises_sorted = list(pivot.index)
    session_labels = [str(int(c)) for c in pivot.columns]

    # cell text for heatmap
    cell_text = []
    cell_hover = []
    for ex in exercises_sorted:
        txt_row = []
        hov_row = []
        for sn in pivot.columns:
            val = pivot.loc[ex, sn]
            if np.isnan(val):
                txt_row.append("")
                hov_row.append("")
            else:
                txt_row.append(f"{val:.0f}")
                hov_row.append(f"<b>{ex}</b><br>Session {int(sn)}<br>Est 1RM: {val:.0f} lbs")
        cell_text.append(txt_row)
        cell_hover.append(hov_row)

    # normalize per exercise for coloring
    # only normalize actual data, leave NaN for empty cells so they render as empty
    normed = pivot.copy()
    for ex in normed.index:
        row = normed.loc[ex]
        mn = row.min()
        mx = row.max()
        if pd.notna(mn) and pd.notna(mx) and mx != mn:
            normed.loc[ex] = (row - mn) / (mx - mn)
        else:
            normed.loc[ex] = np.nan
    
    z_values = normed.values

    fig_heat = go.Figure(data=go.Heatmap(
        z=z_values,
        x=session_labels,
        y=exercises_sorted,
        colorscale=[
            [0.0, "#0d1b2a"],
            [0.25, "#1b2838"],
            [0.5, "#1a5276"],
            [0.75, "#2e86c1"],
            [1.0, "#00d2ff"],
        ],
        showscale=True,
        colorbar=dict(
            title=dict(text="Relative<br>Effort", font=dict(size=10, color="#7a7a8e")),
            tickfont=dict(color="#7a7a8e", size=9),
            len=0.8,
            thickness=12,
            bgcolor="rgba(0,0,0,0)",
        ),
        text=cell_text,
        texttemplate="<b>%{text}</b>",
        textfont=dict(size=12, color="white"),
        hovertext=cell_hover,
        hoverinfo="text",
        xgap=3,
        ygap=3,
    ))
    fig_heat.update_layout(
        **_dark_layout(
            title=dict(text="Effort Heatmap — Est. 1RM per session", font=dict(size=16, color="#00d2ff")),
            height=max(250, len(exercises_sorted) * 40 + 100),
            xaxis=dict(side="top", type="category"),
            margin=dict(l=120, r=60, t=60, b=30),
        ),
    )
    fragments.append(f'<div class="dash-card">{fig_heat.to_html(full_html=False, include_plotlyjs=False)}</div>')

    # strength index chart
    fig_si = go.Figure()
    for ex in exercises_by_day(da):
        ex_df = da[da["exercise"] == ex].sort_values("date")
        if len(ex_df) == 0:
            continue
        vals = ex_df["est_1rm"].values
        if len(vals) == 0:
            continue
        baseline = vals[0]
        if baseline == 0:
            pct = np.zeros_like(vals)
        else:
            pct = (vals - baseline) / baseline * 100
        color = exercise_color(ex, color_map)
        fig_si.add_trace(go.Scatter(
            x=ex_df["date"], y=pct,
            mode="lines+markers", name=ex,
            line=dict(color=color, width=2.5),
            marker=dict(size=7, color=color, line=dict(width=1.5, color="#0f0f1a")),
            hovertemplate=f"<b>%{{fullData.name}}</b><br>%{{x|%m/%d}}<br>Change: %{{y:+.1f}}%<br>1RM: %{{customdata:.0f}}<extra></extra>",
            customdata=vals,
        ))
    fig_si.update_layout(
        **_dark_layout(
            title=dict(text="Relative Progress (% Change)", font=dict(size=16, color="#00d2ff")),
            yaxis_title="% Change from First Session",
            height=350, showlegend=True,
            legend=dict(font=dict(size=10), bgcolor="rgba(0,0,0,0)", orientation="h", y=-0.15),
            yaxis=dict(ticksuffix="%", tickformat=".1f", zeroline=True, zerolinecolor="#cccccc", zerolinewidth=1.5),
        ),
    )
    fragments.append(f'<div class="dash-card">{fig_si.to_html(full_html=False, include_plotlyjs=False)}</div>')

    # growth bars
    exercises_list = exercises_by_day(da)
    growths = []
    for ex in exercises_list:
        ex_df = da[da["exercise"] == ex].sort_values("date")
        if len(ex_df) == 0:
            continue
        first_val = ex_df["est_1rm"].iloc[0]
        last_val = ex_df["est_1rm"].iloc[-1]
        growths.append((last_val - first_val) / first_val * 100 if first_val > 0 else 0)

    colors = [exercise_color(ex, color_map) for ex in exercises_list]
    fig_growth = go.Figure(data=go.Bar(
        y=exercises_list, x=growths, orientation="h",
        marker_color=colors,
        marker_line=dict(width=0),
        text=[f"+{g:.1f}%" if g >= 0 else f"{g:.1f}%" for g in growths],
        textposition="outside", textfont=dict(color="#e2e2e2"),
        hovertemplate="<b>%{y}</b><br>Growth: %{x:.1f}%<extra></extra>",
    ))
    fig_growth.update_layout(
        **_dark_layout(
            title=dict(text="Strength Growth", font=dict(size=16, color="#00d2ff")),
            xaxis_title="Growth %",
            xaxis=dict(tickformat=".1f"),
            height=max(250, len(exercises_list) * 40 + 80),
            yaxis=dict(autorange="reversed"),
        ),
    )
    fragments.append(f'<div class="dash-card">{fig_growth.to_html(full_html=False, include_plotlyjs=False)}</div>')

    # rep distribution bubble chart
    def rep_bucket(r):
        if r <= 5:   return "1-5"
        if r <= 8:   return "6-8"
        if r <= 12:  return "9-12"
        return "13+"

    df_copy = df.copy()
    df_copy["rep_range"] = df_copy["reps"].apply(rep_bucket)
    ranges = ["1-5", "6-8", "9-12", "13+"]
    range_colors = ["#ff6b6b", "#feca57", "#00d2ff", "#ff9ff3"]

    total_sets = [len(df_copy[df_copy["rep_range"] == rng]) for rng in ranges]
    max_count = max(total_sets) if total_sets else 1
    max_bubble_size = 325
    bubble_sizes = [max(15, int((s / max_count) * max_bubble_size)) for s in total_sets]

    max_size = max(bubble_sizes) if bubble_sizes else 1
    y_range = [0.5 - max_size/400, 1.5 + max_size/400]

    fig_reps = go.Figure()
    for rng, col, size, count in zip(ranges, range_colors, bubble_sizes, total_sets):
        fig_reps.add_trace(go.Scatter(
            x=[rng], y=[1],
            mode="markers+text",
            marker=dict(size=size, color=col, line=dict(color="white", width=2)),
            text=[f"<b>{count}</b>"], textposition="middle center",
            textfont=dict(size=14, color="white", family="Arial Black"),
            hovertemplate=f"<b>{rng} reps</b><br>{count} sets<extra></extra>",
            showlegend=False,
        ))
    fig_reps.update_layout(
        **_dark_layout(
            title=dict(text="Rep Range Distribution", font=dict(size=16, color="#00d2ff")),
            xaxis=dict(showticklabels=False, showgrid=False, zeroline=False),
            yaxis=dict(showticklabels=False, showgrid=False, zeroline=False, range=y_range),
            height=450,
            margin=dict(t=50, b=60, l=20, r=20),
        ),
    )
    fig_reps.add_annotation(x=0.5, y=-0.1, text="• 1-5 • 6-8 • 9-12 • 13+", showarrow=False,
                            font=dict(size=10, color="#7a7a8e"), xref="paper", yref="paper")
    fragments.append(f'<div class="dash-card">{fig_reps.to_html(full_html=False, include_plotlyjs=False)}</div>')

    # weight ladder
    fragments.append('<div class="dash-card"><h3>Weight Ladder</h3>')
    for ex in exercises_by_day(df):
        color = exercise_color(ex, color_map)
        ex_df = df[df["exercise"] == ex].sort_values("date")
        weights_by_date = ex_df.groupby("date")["weight"].max().sort_index()
        steps = []
        for w in weights_by_date.values:
            if not steps or steps[-1] != w:
                steps.append(w)
        if not steps:
            continue
        boxes = ""
        for j, w in enumerate(steps):
            if j > 0:
                boxes += '<span class="ladder-arrow">›</span>'
            boxes += f'<span class="ladder-box" style="border-color:{color};color:{color}">{int(w)}</span>'
        fragments.append(
            f'<div class="ladder-row">'
            f'<span class="ladder-label" style="color:{color}">{ex}</span>'
            f'<div class="ladder-steps">{boxes}</div>'
            f'</div>'
        )
    fragments.append('</div>')

    # pr table
    fragments.append('<div class="dash-card"><h3>Personal Records</h3><table class="pr-table">')
    fragments.append("<tr><th>Exercise</th><th>Best 1RM</th><th>Heaviest Set</th><th>Best Volume</th></tr>")
    for ex in active_exercises:
        ex_df = ss[ss["exercise"] == ex]
        if ex_df.empty or ex_df["best_1rm"].isna().all():
            continue
        best_1rm_idx = ex_df["best_1rm"].idxmax()
        max_weight_idx = ex_df["max_weight"].idxmax()
        max_volume_idx = ex_df["total_volume"].idxmax()
        if pd.isna(best_1rm_idx) or pd.isna(max_weight_idx) or pd.isna(max_volume_idx):
            continue
        best_1rm_row = ex_df.loc[best_1rm_idx]
        best_weight_row = ex_df.loc[max_weight_idx]
        best_vol_row = ex_df.loc[max_volume_idx]
        color = exercise_color(ex, color_map)
        best_1rm_text = f'{best_1rm_row["best_1rm"]:.0f} lbs <span class="date">({best_1rm_row["date"].strftime("%m/%d")})</span>'
        heaviest_text = f'{int(best_weight_row["max_weight"])} lbs × {int(best_weight_row["best_reps"])} <span class="date">({best_weight_row["date"].strftime("%m/%d")})</span>'
        best_vol_text = f'{best_vol_row["total_volume"]:,.0f} lbs <span class="date">({best_vol_row["date"].strftime("%m/%d")})</span>'
        fragments.append(
            f'<tr>'
            f'<td style="color:{color};font-weight:bold">{ex}</td>'
            f'<td>{best_1rm_text}</td>'
            f'<td>{heaviest_text}</td>'
            f'<td>{best_vol_text}</td>'
            f'</tr>'
        )
    fragments.append("</table></div>")
    fragments.append("</section>")

    # projections section
    fragments.append('<section id="projections">')
    fragments.append('<div class="page-header"><h1>Projections</h1><p>90-day linear trend extrapolation with confidence intervals</p></div>')

    # calc projections per exercise
    for ex in exercises_by_day(df):
        ex_bs = bs[bs["exercise"] == ex].sort_values("date")
        if len(ex_bs) < 2:
            continue
        color = exercise_color(ex, color_map)
        dates = ex_bs["date"].values
        vals = ex_bs["est_1rm"].values
        date_nums = np.array([(d - dates[0]) / np.timedelta64(1, "D") for d in dates], dtype=float)

        coeffs = np.polyfit(date_nums, vals, 1)
        slope = coeffs[0]
        intercept = coeffs[1]
        fitted = np.polyval(coeffs, date_nums)
        residuals = vals - fitted
        std_err = np.std(residuals) if len(residuals) > 2 else 0

        last_day = date_nums[-1]
        future_days = np.linspace(0, last_day + 90, 200)
        initial_decay = 0.010
        later_decay = 0.004
        switch_day = 35
        t = future_days - last_day
        decay = np.exp(-initial_decay * t)
        decay[t > switch_day] = np.exp(-later_decay * (t[t > switch_day] - switch_day)) * np.exp(-initial_decay * switch_day)
        decay[t < 0] = 1
        future_vals = (intercept + slope * last_day) + slope * (future_days - last_day) * decay
        future_dates = [dates[0] + np.timedelta64(int(d), "D") for d in future_days]

        span = future_days / max(last_day, 1)
        band_width = future_vals * 0.05 * (1 + 0.3 * span)

        fig_proj = go.Figure()
        # confidence band
        fig_proj.add_trace(go.Scatter(
            x=list(future_dates) + list(future_dates[::-1]),
            y=list(future_vals + band_width) + list((future_vals - band_width)[::-1]),
            fill="toself", fillcolor=f"rgba({int(color[1:3],16)},{int(color[3:5],16)},{int(color[5:7],16)},0.1)",
            line=dict(width=0), showlegend=False, hoverinfo="skip",
        ))
        # trend line
        fig_proj.add_trace(go.Scatter(
            x=future_dates, y=future_vals,
            mode="lines", name="Trend",
            line=dict(color=color, width=2, dash="dash"),
            hoverinfo="skip",
        ))
        # actual data
        fig_proj.add_trace(go.Scatter(
            x=dates, y=vals,
            mode="markers+lines", name="Actual",
            line=dict(color=color, width=2),
            marker=dict(size=8, color=color, line=dict(width=2, color="#1a1a2e")),
            hovertemplate="<b>%{x|%m/%d}</b><br>1RM: %{y:.0f}<extra></extra>",
        ))
        # projection markers
        for fd in [30, 60, 90]:
            proj_day = last_day + fd
            t = fd
            decay = np.exp(-initial_decay * t) if t <= switch_day else np.exp(-later_decay * (t - switch_day)) * np.exp(-initial_decay * switch_day)
            proj_val = (intercept + slope * last_day) + slope * fd * decay
            proj_date = dates[0] + np.timedelta64(int(proj_day), "D")
            fig_proj.add_vline(x=proj_date, line_dash="dot", line_color="#feca57", opacity=0.4)
            fig_proj.add_annotation(
                x=proj_date, y=proj_val,
                text=f"+{fd}d<br>{proj_val:.0f}",
                showarrow=False, font=dict(size=10, color="#feca57"),
            )

        slope_per_week = slope * 7
        fig_proj.add_annotation(
            x=0.02, y=0.95, xref="paper", yref="paper",
            text=f"+{slope_per_week:.1f} lbs/week",
            showarrow=False, font=dict(size=12, color="#feca57", weight="bold"),
            bgcolor="#16213e", bordercolor="#2a2a4a", borderwidth=1, borderpad=4,
        )

        fig_proj.update_layout(
            **_dark_layout(
                title=dict(text=ex, font=dict(size=14, color=color)),
                yaxis_title="Est. 1RM (lbs)",
                height=280,
            ),
            showlegend=False,
        )
        fragments.append(fig_proj.to_html(full_html=False, include_plotlyjs=False))

    fragments.append("</section>")

    # day sections
    for day_label in sorted(df["day"].unique()):
        anchor = day_label.lower().replace(" ", "-")
        day_exercises = sorted(df.loc[df["day"] == day_label, "exercise"].unique())
        day_sets = len(df[df["day"] == day_label])

        fragments.append(f'<section id="day-{anchor}">')
        fragments.append(
            f'<div class="page-header">'
            f'<h1>{day_label}</h1>'
            f'<p>{len(day_exercises)} exercises &bull; {day_sets} sets &bull; Focused session tracking</p>'
            f'</div>'
        )

        for ex in day_exercises:
            color = exercise_color(ex, color_map)
            ex_da = da[(da["exercise"] == ex) & (da["day"] == day_label)].sort_values("date")
            ex_raw = df[(df["exercise"] == ex) & (df["day"] == day_label)].sort_values("date")
            if ex_da.empty:
                continue

            fig_ex = make_subplots(
                rows=2, cols=2,
                subplot_titles=["1RM & Volume", "Weight", "Volume", "Sets"],
                specs=[[{"secondary_y": True}, {}], [{}, {}]],
                vertical_spacing=0.15, horizontal_spacing=0.1,
            )

            # main chart stuff
            dates_da = ex_da["date"]
            e1rms = ex_da["est_1rm"]
            vols = ex_da["total_volume"]

            # individual set points
            set_dates = ex_raw["date"]
            set_1rms = ex_raw["est_1rm"]
            set_reps = ex_raw["reps"]
            set_weights = ex_raw["weight"]
            set_volumes = ex_raw["volume"]

            # volume bars
            fig_ex.add_trace(go.Bar(
                x=dates_da, y=vols, name="Volume",
                marker_color=color, opacity=0.2,
                hovertemplate="<b>%{x|%m/%d}</b><br>Volume: %{y:,.0f} lbs<extra></extra>",
            ), row=1, col=1, secondary_y=True)

            # 1rm line
            fig_ex.add_trace(go.Scatter(
                x=dates_da, y=e1rms, name="1RM",
                mode="lines+markers",
                line=dict(color=color, width=2.5),
                marker=dict(size=8, color=color, line=dict(width=2, color="#1a1a2e")),
                hovertemplate="<b>%{x|%m/%d}</b><br>1RM: %{y:.0f} lbs<extra></extra>",
            ), row=1, col=1, secondary_y=False)

            # individual set dots
            fig_ex.add_trace(go.Scatter(
                x=set_dates, y=set_1rms, name="Sets",
                mode="markers",
                marker=dict(size=5, color=color, opacity=0.5, symbol="circle-open",
                            line=dict(width=1)),
                customdata=np.stack([set_reps, set_weights, set_volumes], axis=-1),
                hovertemplate=(
                    "<b>%{x|%m/%d}</b><br>"
                    "Set: %{customdata[0]:.0f} × %{customdata[1]:.0f} lbs<br>"
                    "1RM: %{y:.0f} lbs<br>"
                    "Volume: %{customdata[2]:,.0f} lbs"
                    "<extra></extra>"
                ),
                showlegend=False,
            ), row=1, col=1, secondary_y=False)

            # weight chart
            fig_ex.add_trace(go.Scatter(
                x=dates_da, y=ex_da["avg_weight"], name="Avg Weight",
                mode="lines+markers",
                line=dict(color="#feca57", width=2),
                marker=dict(size=6, color="#feca57"),
                fill="tozeroy", fillcolor="rgba(254,202,87,0.1)",
                hovertemplate="<b>%{x|%m/%d}</b><br>Avg: %{y:.0f} lbs<br>Sets: %{customdata}<extra></extra>",
                customdata=ex_da["sets"],
            ), row=1, col=2)

            # volume bar chart
            fig_ex.add_trace(go.Bar(
                x=dates_da, y=vols, name="Vol",
                marker_color=color, opacity=0.6,
                hovertemplate="<b>%{x|%m/%d}</b><br>Volume: %{y:,.0f} lbs<extra></extra>",
                showlegend=False,
            ), row=2, col=1)

            # rep distribution
            rep_ranges = ["1-5", "6-8", "9-12", "13+"]
            rep_colors = ["#ff6b6b", "#feca57", "#00d2ff", "#ff9ff3"]
            for rng, rc in zip(rep_ranges, rep_colors):
                c = len(ex_raw[ex_raw["reps"].apply(rep_bucket) == rng])
                fig_ex.add_trace(go.Bar(
                    x=[rng], y=[c], name=rng,
                    marker_color=rc,
                    showlegend=False,
                    hovertemplate=f"{rng} reps: %{{y}} sets<extra></extra>",
                ), row=2, col=2)

            fig_ex.update_layout(
                **_dark_layout(
                    title=dict(text=ex, font=dict(size=18, color=color)),
                    height=550, showlegend=False,
                ),
            )
            fig_ex.update_xaxes(gridcolor="#1f1f30", zerolinecolor="#1f1f30", gridwidth=1)
            fig_ex.update_yaxes(gridcolor="#1f1f30", zerolinecolor="#1f1f30", gridwidth=1)
            fig_ex.update_yaxes(title_text="1RM (lbs)", row=1, col=1, secondary_y=False)
            fig_ex.update_yaxes(title_text="Volume", row=1, col=1, secondary_y=True, showgrid=False)
            fig_ex.update_yaxes(title_text="Weight (lbs)", row=1, col=2)
            fig_ex.update_yaxes(title_text="Volume (lbs)", row=2, col=1)
            fig_ex.update_yaxes(title_text="# Sets", row=2, col=2)

            fragments.append(f'<div class="exercise-card">{fig_ex.to_html(full_html=False, include_plotlyjs=False)}</div>')

        fragments.append("</section>")

    # assemble html
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lift Progress Report</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
        background: #0f0f1a;
        color: #e2e2e2;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        display: flex;
        min-height: 100vh;
        overflow-x: hidden;
    }}

    /* sidebar */
    .sidebar {{
        width: 260px;
        background: #0b0b14;
        border-right: 1px solid #1e2a40;
        height: 100vh;
        position: fixed;
        left: 0;
        top: 0;
        display: flex;
        flex-direction: column;
        padding: 40px 0;
        z-index: 1000;
        transition: width 0.3s;
    }}
    .brand {{
        padding: 0 30px 40px;
        display: flex;
        align-items: center;
        gap: 12px;
    }}
    .logo {{
        width: 32px;
        height: 32px;
        background: linear-gradient(135deg, #00d2ff, #7b2ff7);
        border-radius: 8px;
        position: relative;
    }}
    .logo::after {{
        content: "";
        position: absolute;
        top: 6px; left: 6px; right: 6px; bottom: 6px;
        background: #0b0b14;
        border-radius: 4px;
    }}
    .brand h1 {{
        font-size: 22px;
        font-weight: 800;
        letter-spacing: 2px;
        background: linear-gradient(135deg, #00d2ff, #7b2ff7);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        font-family: 'Segoe UI Black', sans-serif;
    }}
    .nav-links {{
        flex: 1;
        overflow-y: auto;
    }}
    .nav-item {{
        display: flex;
        align-items: center;
        padding: 14px 30px;
        color: #7a7a8e;
        text-decoration: none;
        transition: all 0.2s;
        font-size: 14px;
        font-weight: 600;
        border-left: 4px solid transparent;
    }}
    .nav-item:hover {{
        color: #00d2ff;
        background: rgba(0, 210, 255, 0.05);
    }}
    .nav-item.active {{
        color: #e2e2e2;
        background: rgba(0, 210, 255, 0.1);
        border-left-color: #00d2ff;
    }}
    .nav-icon {{ margin-right: 15px; font-size: 18px; width: 20px; text-align: center; }}
    .nav-divider {{
        padding: 30px 30px 10px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 2px;
        color: #3e3e5a;
        font-weight: 800;
    }}

    /* main content */
    .main-content {{
        margin-left: 260px;
        flex: 1;
        padding: 50px 60px;
        width: calc(100% - 260px);
    }}

    .page-header {{
        margin-bottom: 50px;
    }}
    .page-header h1 {{
        font-size: 40px;
        font-weight: 900;
        margin-bottom: 12px;
        letter-spacing: -0.5px;
    }}
    .page-header p {{
        color: #7a7a8e;
        font-size: 16px;
        max-width: 600px;
    }}

    section {{
        display: none;
        animation: fadeIn 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    }}
    section.active-section {{
        display: block;
    }}

    @keyframes fadeIn {{
        from {{ opacity: 0; transform: translateY(20px); }}
        to {{ opacity: 1; transform: translateY(0); }}
    }}

    .dash-card, .exercise-card {{
        background: #121220;
        border: 1px solid #1e2a40;
        border-radius: 20px;
        margin-bottom: 30px;
        padding: 30px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        transition: transform 0.2s, border-color 0.2s;
    }}
    .dash-card:hover, .exercise-card:hover {{
        border-color: #2a3a5a;
    }}
    .dash-card h3 {{
        font-size: 15px;
        font-weight: 800;
        color: #4a4a6e;
        text-transform: uppercase;
        letter-spacing: 1.5px;
        margin-bottom: 25px;
    }}

    .pr-table {{
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
    }}
    .pr-table th {{
        text-align: left;
        padding: 15px 20px;
        color: #555568;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 1.5px;
        border-bottom: 2px solid #1e2a40;
        font-weight: 700;
    }}
    .pr-table td {{
        padding: 20px;
        border-bottom: 1px solid #1e2a40;
        font-size: 15px;
    }}
    .pr-table tr:last-child td {{ border-bottom: none; }}
    .pr-table tr:hover td {{ background: rgba(255,255,255,0.02); }}
    .date {{ color: #555568; font-size: 13px; font-weight: 500; margin-left: 8px; }}

    .ladder-row {{
        display: flex;
        align-items: center;
        padding: 16px 0;
        border-bottom: 1px solid #1e2a40;
    }}
    .ladder-row:last-child {{ border-bottom: none; }}
    .ladder-label {{
        width: 130px;
        font-size: 14px;
        font-weight: 700;
        flex-shrink: 0;
    }}
    .ladder-steps {{
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0;
    }}
    .ladder-box {{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 52px;
        padding: 8px 14px;
        border: 2px solid;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 800;
        background: rgba(255,255,255,0.03);
    }}
    .ladder-arrow {{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        color: #3e3e5a;
        font-size: 18px;
        font-weight: 700;
    }}

    /* stats mini */
    .stats-mini {{
        padding: 0 30px 30px;
    }}
    .stat-item {{
        margin-bottom: 18px;
    }}
    .stat-label {{
        display: block;
        font-size: 10px;
        color: #4a4a6e;
        text-transform: uppercase;
        font-weight: 800;
        letter-spacing: 1px;
        margin-bottom: 4px;
    }}
    .stat-value {{
        font-size: 14px;
        color: #8a8aae;
        font-weight: 500;
    }}

    .sidebar-footer {{
        padding: 20px 30px;
        font-size: 11px;
        color: #3e3e5a;
        font-weight: 600;
        border-top: 1px solid #1a1a2e;
    }}

    @media (max-width: 1100px) {{
        .sidebar {{ width: 85px; }}
        .nav-text, .brand h1, .stat-label, .stat-value, .nav-divider, .sidebar-footer {{ display: none; }}
        .main-content {{ margin-left: 85px; padding: 40px; width: calc(100% - 85px); }}
        .brand {{ padding: 0 0 30px; justify-content: center; }}
        .nav-item {{ justify-content: center; padding: 18px 0; }}
        .nav-icon {{ margin-right: 0; font-size: 22px; }}
        .stats-mini {{ display: none; }}
    }}

    /* plotly responsiveness */
    .js-plotly-plot {{ width: 100% !important; }}
</style>
</head>
<body>
{"".join(sidebar_fragments)}
{"".join(fragments)}
</div>

<script>
    // handle nav switching
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('section');

    function switchSection(targetId) {{
        // update nav ui
        navItems.forEach(item => {{
            if (item.getAttribute('href') === '#' + targetId) {{
                item.classList.add('active');
            }} else {{
                item.classList.remove('active');
            }}
        }});

        // update section visibility
        sections.forEach(sec => {{
            if (sec.id === targetId) {{
                sec.classList.add('active-section');
                // trigger plotly resize
                window.dispatchEvent(new Event('resize'));
            }} else {{
                sec.classList.remove('active-section');
            }}
        }});
    }}

    navItems.forEach(link => {{
        link.addEventListener('click', function(e) {{
            const href = this.getAttribute('href');
            if (href.startsWith('#')) {{
                e.preventDefault();
                const targetId = href.substring(1);
                switchSection(targetId);
                history.pushState(null, null, '#' + targetId);
                window.scrollTo(0, 0);
            }}
        }});
    }});

    // handle initial load and back/forward
    function handleRouting() {{
        const hash = window.location.hash.substring(1) || 'dashboard';
        const targetSection = document.getElementById(hash);
        if (targetSection) {{
            switchSection(hash);
        }} else {{
            switchSection('dashboard');
        }}
    }}

    window.addEventListener('popstate', handleRouting);
    window.addEventListener('load', handleRouting);
</script>
</body>
</html>"""

    out_path = SCRIPT_DIR / "Lift_Progress_Report.html"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Saved {out_path}")


if __name__ == "__main__":
    main()

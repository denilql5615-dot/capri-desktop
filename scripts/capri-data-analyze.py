"""Local data analyzer for Capri PC Tools Engine.

Usage:
    py capri-data-analyze.py <inputPath> --out-dir <outDir> [--query <text>]
"""
import argparse
import json
import math
import os
import re
import sys
import time

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd


DARK_BG = "#131314"
CARD_BG = "#1E1F20"
TEXT_PRIMARY = "#E3E3E3"
TEXT_MUTED = "#C4C7C5"
ACCENT = "#8AB4F8"
GRID_COLOR = "#2E3033"


def _json_safe(val):
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    if isinstance(val, (int,)):
        return int(val)
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return None
        return float(val)
    if hasattr(val, "item"):
        try:
            return _json_safe(val.item())
        except Exception:
            pass
    if hasattr(val, "isoformat"):
        try:
            return val.isoformat()
        except Exception:
            pass
    try:
        if pd.isna(val):
            return None
    except Exception:
        pass
    return str(val)


def _load_dataframe(input_path: str) -> pd.DataFrame:
    ext = os.path.splitext(input_path)[1].lower()
    if ext == ".csv":
        for enc in ("utf-8-sig", "utf-8", "cp1251", "latin-1"):
            try:
                return pd.read_csv(input_path, encoding=enc)
            except UnicodeDecodeError:
                continue
        return pd.read_csv(input_path, encoding="utf-8", errors="replace")
    if ext == ".tsv":
        for enc in ("utf-8-sig", "utf-8", "cp1251", "latin-1"):
            try:
                return pd.read_csv(input_path, sep="\t", encoding=enc)
            except UnicodeDecodeError:
                continue
        return pd.read_csv(input_path, sep="\t", encoding="utf-8", errors="replace")
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(input_path)
    if ext == ".json":
        try:
            df = pd.read_json(input_path)
            if isinstance(df, pd.DataFrame):
                return df
        except ValueError:
            pass
        with open(input_path, "r", encoding="utf-8-sig") as f:
            raw = json.load(f)
        if isinstance(raw, list):
            return pd.json_normalize(raw)
        if isinstance(raw, dict):
            for v in raw.values():
                if isinstance(v, list):
                    return pd.json_normalize(v)
            return pd.json_normalize([raw])
    raise ValueError(f"Unsupported file format: {ext or 'unknown'}")


def _pick_numeric_column(df: pd.DataFrame, numeric_cols: list, query: str) -> str:
    if not numeric_cols:
        return ""
    q = (query or "").strip().lower()
    if q:
        for col in numeric_cols:
            if str(col).lower() in q:
                return col
    return numeric_cols[0]


def _render_chart(df: pd.DataFrame, numeric_cols: list, out_dir: str, input_path: str, query: str) -> str | None:
    if not numeric_cols or df.empty:
        return None

    target_col = _pick_numeric_column(df, numeric_cols, query)
    series = pd.to_numeric(df[target_col], errors="coerce").dropna()
    if series.empty:
        return None

    non_numeric = [c for c in df.columns if c not in numeric_cols]
    if non_numeric:
        labels = df.loc[series.index, non_numeric[0]].astype(str).tolist()
    else:
        labels = [str(i + 1) for i in range(len(series))]

    os.makedirs(out_dir, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", os.path.splitext(os.path.basename(input_path))[0]).strip("_") or "data"
    out_path = os.path.join(out_dir, f"{stem}-chart-{int(time.time() * 1000)}.png")

    fig, ax = plt.subplots(figsize=(8.5, 4.6), dpi=140)
    fig.patch.set_facecolor(DARK_BG)
    ax.set_facecolor(CARD_BG)

    use_bar = len(series) <= 25
    if use_bar:
        x_idx = list(range(len(series)))
        ax.bar(x_idx, series.values, color=ACCENT, width=0.62, edgecolor="none", zorder=3)
        short_labels = [lbl[:18] + ("…" if len(lbl) > 18 else "") for lbl in labels]
        ax.set_xticks(x_idx)
        ax.set_xticklabels(short_labels, rotation=28 if len(series) > 6 else 0, ha="right" if len(series) > 6 else "center")
    else:
        x_idx = list(range(len(series)))
        ax.plot(x_idx, series.values, color=ACCENT, linewidth=2.0, zorder=3)
        ax.fill_between(x_idx, series.values, color=ACCENT, alpha=0.14, zorder=2)
        step = max(1, len(series) // 8)
        ticks = x_idx[::step]
        ax.set_xticks(ticks)
        ax.set_xticklabels([labels[i][:16] for i in ticks], rotation=20, ha="right")

    ax.grid(True, axis="y", color=GRID_COLOR, linestyle="-", linewidth=0.7, zorder=1)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color(GRID_COLOR)

    ax.tick_params(colors=TEXT_MUTED, labelsize=9)
    title_text = f"{target_col}" + (f" · {query[:48]}" if query else "")
    ax.set_title(title_text, color=TEXT_PRIMARY, fontsize=12, pad=12, loc="left", fontweight="medium")
    ax.set_ylabel(str(target_col), color=TEXT_MUTED, fontsize=9.5)

    fig.tight_layout()
    fig.savefig(out_path, facecolor=DARK_BG, edgecolor="none")
    plt.close(fig)
    return out_path


def analyze(input_path: str, out_dir: str, query: str = "") -> dict:
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"File not found: {input_path}")

    df = _load_dataframe(input_path)
    rows, cols = int(df.shape[0]), int(df.shape[1])

    columns = []
    for col in df.columns:
        columns.append({
            "name": str(col),
            "dtype": str(df[col].dtype),
            "nulls": int(df[col].isna().sum()),
        })

    numeric_cols = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    numeric_summary = {}
    for col in numeric_cols:
        s = pd.to_numeric(df[col], errors="coerce").dropna()
        if s.empty:
            continue
        numeric_summary[str(col)] = {
            "min": _json_safe(round(float(s.min()), 6)),
            "max": _json_safe(round(float(s.max()), 6)),
            "mean": _json_safe(round(float(s.mean()), 6)),
            "sum": _json_safe(round(float(s.sum()), 6)),
        }

    preview_rows = []
    for _, row in df.head(5).iterrows():
        preview_rows.append({str(k): _json_safe(row[k]) for k in df.columns})

    chart_path = _render_chart(df, numeric_cols, out_dir, input_path, query)

    return {
        "ok": True,
        "file": os.path.abspath(input_path),
        "rows": rows,
        "cols": cols,
        "columns": columns,
        "numericSummary": numeric_summary,
        "previewRows": preview_rows,
        "chartPath": chart_path,
    }


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="Capri local data analyzer")
    parser.add_argument("input_path", help="Path to CSV, TSV, XLSX, XLS, or JSON file")
    parser.add_argument("--out-dir", required=True, help="Output directory for PNG charts")
    parser.add_argument("--query", default="", help="Optional focus query or column hint")
    args = parser.parse_args()

    try:
        result = analyze(args.input_path, args.out_dir, args.query)
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}

    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

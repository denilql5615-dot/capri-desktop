"""Local document converter for Capri PC Tools Engine.

Usage:
    py capri-convert-doc.py <inputPath> --to <docx|txt> --out <outputPath>
"""
import argparse
import json
import os
import re
import sys

from docx import Document
from docx.shared import Pt, RGBColor


INLINE_RE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)")


def _add_inline_runs(paragraph, text: str) -> None:
    for part in INLINE_RE.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            run = paragraph.add_run(part[2:-2])
            run.bold = True
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            run = paragraph.add_run(part[1:-1])
            run.font.name = "Consolas"
            run.font.size = Pt(9.5)
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            run = paragraph.add_run(part[1:-1])
            run.italic = True
        else:
            paragraph.add_run(part)


def _read_text_file(path: str) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def _hex_rgb(value):
    m = re.match(r"^#([0-9a-fA-F]{6})$", str(value or "").strip())
    if not m:
        return None
    h = m.group(1)
    return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _apply_style(doc, style: dict) -> None:
    """ALTAI:RE style (styles-engine docStyle): fonts and colours of body text and headings."""
    if not style:
        return
    body_font = str(style.get("fontBody") or "").strip()
    head_font = str(style.get("fontHeading") or "").strip() or body_font
    head_color = _hex_rgb(style.get("colorHeading"))
    accent = _hex_rgb(style.get("colorAccent")) or head_color
    if body_font:
        doc.styles["Normal"].font.name = body_font
    for level in range(1, 5):
        try:
            st = doc.styles[f"Heading {level}"]
        except KeyError:
            continue
        if head_font:
            st.font.name = head_font
        color = head_color if level == 1 else accent
        if color is not None:
            st.font.color.rgb = color
    try:
        title = doc.styles["Title"]
        if head_font:
            title.font.name = head_font
        if head_color is not None:
            title.font.color.rgb = head_color
    except KeyError:
        pass


def _markdown_to_docx(md_text: str, output_path: str, style: dict = None) -> None:
    doc = Document()
    normal_style = doc.styles["Normal"]
    normal_style.font.name = "Calibri"
    normal_style.font.size = Pt(11)
    normal_style.font.color.rgb = RGBColor(0x1F, 0x1F, 0x1F)
    _apply_style(doc, style)

    lines = md_text.splitlines()
    para_buf = []
    in_code = False
    code_buf = []

    def flush_para():
        if para_buf:
            p = doc.add_paragraph()
            _add_inline_runs(p, " ".join(para_buf))
            para_buf.clear()

    def flush_code():
        if code_buf:
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Pt(14)
            p.paragraph_format.space_before = Pt(4)
            p.paragraph_format.space_after = Pt(6)
            run = p.add_run("\n".join(code_buf))
            run.font.name = "Consolas"
            run.font.size = Pt(9.5)
            run.font.color.rgb = RGBColor(0x2B, 0x2D, 0x30)
            code_buf.clear()

    for raw in lines:
        stripped = raw.strip()
        if stripped.startswith("```"):
            flush_para()
            if in_code:
                flush_code()
                in_code = False
            else:
                in_code = True
            continue

        if in_code:
            code_buf.append(raw.rstrip())
            continue

        if not stripped:
            flush_para()
            continue

        heading = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        bullet = re.match(r"^[-*+]\s+(.*)$", stripped)
        number = re.match(r"^\d+[.)]\s+(.*)$", stripped)

        if heading:
            flush_para()
            level = min(4, len(heading.group(1)))
            doc.add_heading(heading.group(2).strip(), level=level)
        elif bullet:
            flush_para()
            p = doc.add_paragraph(style="List Bullet")
            _add_inline_runs(p, bullet.group(1).strip())
        elif number:
            flush_para()
            p = doc.add_paragraph(style="List Number")
            _add_inline_runs(p, number.group(1).strip())
        else:
            para_buf.append(stripped)

    flush_para()
    flush_code()

    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    doc.save(output_path)


def _to_txt(input_path: str, output_path: str) -> None:
    ext = os.path.splitext(input_path)[1].lower()
    if ext == ".docx":
        doc = Document(input_path)
        parts = [p.text for p in doc.paragraphs if p.text]
        for table in doc.tables:
            for row in table.rows:
                parts.append("\t".join(cell.text.strip() for cell in row.cells))
        text = "\n".join(parts)
    else:
        raw = _read_text_file(input_path)
        text = re.sub(r"^#{1,6}\s+", "", raw, flags=re.MULTILINE)
        text = re.sub(r"```[^\n]*\n?", "", text)
        text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
        text = re.sub(r"`([^`]+)`", r"\1", text)

    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(text)


def convert(input_path: str, target_format: str, output_path: str, style: dict = None) -> dict:
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Input file not found: {input_path}")

    fmt = target_format.strip().lower().lstrip(".")
    if fmt == "docx":
        raw = _read_text_file(input_path)
        _markdown_to_docx(raw, output_path, style)
    elif fmt == "txt":
        _to_txt(input_path, output_path)
    else:
        raise ValueError(f"Unsupported target format: {target_format}")

    abs_out = os.path.abspath(output_path)
    size = os.path.getsize(abs_out) if os.path.isfile(abs_out) else 0
    return {
        "ok": True,
        "outputPath": abs_out,
        "bytes": int(size),
    }


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="Capri local document converter")
    parser.add_argument("input_path", help="Path to source document (.md, .txt, .docx)")
    parser.add_argument("--to", required=True, choices=["docx", "txt"], help="Target format")
    parser.add_argument("--out", required=True, help="Output file path")
    parser.add_argument("--style", default="", help="JSON file with an ALTAI:RE style (fonts, colours)")
    args = parser.parse_args()

    try:
        style = None
        if args.style:
            with open(args.style, "r", encoding="utf-8") as f:
                style = json.load(f)
        result = convert(args.input_path, args.to, args.out, style)
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

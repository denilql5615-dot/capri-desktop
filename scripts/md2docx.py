"""Markdown to .docx for Capri's workers (src/main/workers.js): Claude and Codex write NAME.docx.md,
she turns it into NAME.docx. Headings (#), bullets (- or *), numbered lists (1.), **bold**, *italic*,
`code` and plain paragraphs; anything else stays as text.

usage: python md2docx.py IN.md OUT.docx
"""
import re
import sys

from docx import Document

INLINE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)")


def add_runs(paragraph, text):
    for part in INLINE.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            paragraph.add_run(part[2:-2]).bold = True
        elif part.startswith("`") and part.endswith("`"):
            paragraph.add_run(part[1:-1]).font.name = "Consolas"
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            paragraph.add_run(part[1:-1]).italic = True
        else:
            paragraph.add_run(part)


def convert(src, out):
    doc = Document()
    with open(src, encoding="utf-8") as f:
        lines = f.read().splitlines()
    para = []

    def flush():
        if para:
            add_runs(doc.add_paragraph(), " ".join(para))
            para.clear()

    for raw in lines:
        line = raw.strip()
        heading = re.match(r"^(#{1,4})\s+(.*)$", line)
        bullet = re.match(r"^[-*+]\s+(.*)$", line)
        number = re.match(r"^\d+[.)]\s+(.*)$", line)
        if not line:
            flush()
        elif heading:
            flush()
            doc.add_heading(heading.group(2), level=len(heading.group(1)))
        elif bullet:
            flush()
            add_runs(doc.add_paragraph(style="List Bullet"), bullet.group(1))
        elif number:
            flush()
            add_runs(doc.add_paragraph(style="List Number"), number.group(1))
        else:
            para.append(line)
    flush()
    doc.save(out)


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])

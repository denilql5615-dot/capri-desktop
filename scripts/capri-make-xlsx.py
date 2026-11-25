#!/usr/bin/env python3
"""Create a valid .xlsx file from a JSON rows payload using only Python stdlib."""

import argparse
import json
import math
import os
import re
import sys
import zipfile
from xml.sax.saxutils import escape

INVALID_XML_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]')
BAD_SHEET_CHARS_RE = re.compile(r'[\\/?*\[\]:]')


def clean_text(value) -> str:
    if value is None:
        return ''
    return INVALID_XML_RE.sub('', str(value))


def col_letter(idx: int) -> str:
    result = []
    n = idx + 1
    while n > 0:
        n, rem = divmod(n - 1, 26)
        result.append(chr(65 + rem))
    return ''.join(reversed(result))


def is_number(value) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    return False


def build_sheet_xml(rows: list) -> str:
    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        '<sheetData>',
    ]
    for r_idx, row in enumerate(rows, start=1):
        if not isinstance(row, (list, tuple)):
            row = [row]
        lines.append(f'<row r="{r_idx}">')
        style_attr = ' s="1"' if r_idx == 1 else ''
        for c_idx, val in enumerate(row):
            ref = f'{col_letter(c_idx)}{r_idx}'
            if is_number(val):
                lines.append(f'<c r="{ref}"{style_attr}><v>{val}</v></c>')
            else:
                text = escape(clean_text(val))
                lines.append(
                    f'<c r="{ref}" t="inlineStr"{style_attr}><is><t xml:space="preserve">{text}</t></is></c>'
                )
        lines.append('</row>')
    lines.append('</sheetData></worksheet>')
    return ''.join(lines)


CONTENT_TYPES_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>'''

ROOT_RELS_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''

WORKBOOK_RELS_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''

STYLES_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>'''


def make_xlsx(out_path: str, rows: list, title: str = 'Sheet1') -> None:
    sheet_name = BAD_SHEET_CHARS_RE.sub('_', clean_text(title or 'Sheet1')).strip()[:31] or 'Sheet1'
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets><sheet name="{escape(sheet_name)}" sheetId="1" r:id="rId1"/></sheets>'
        '</workbook>'
    )
    sheet_xml = build_sheet_xml(rows)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with zipfile.ZipFile(out_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', CONTENT_TYPES_XML)
        zf.writestr('_rels/.rels', ROOT_RELS_XML)
        zf.writestr('xl/workbook.xml', workbook_xml)
        zf.writestr('xl/_rels/workbook.xml.rels', WORKBOOK_RELS_XML)
        zf.writestr('xl/styles.xml', STYLES_XML)
        zf.writestr('xl/worksheets/sheet1.xml', sheet_xml)


def main() -> int:
    parser = argparse.ArgumentParser(description='Generate XLSX from JSON rows')
    parser.add_argument('--input', required=True, help='Path to JSON input file')
    parser.add_argument('--out', required=True, help='Output .xlsx file path')
    args = parser.parse_args()

    with open(args.input, 'r', encoding='utf-8') as f:
        payload = json.load(f)

    if isinstance(payload, list):
        rows = payload
        title = 'Sheet1'
    elif isinstance(payload, dict):
        rows = payload.get('rows') or []
        title = payload.get('title') or 'Sheet1'
    else:
        raise ValueError('Invalid JSON payload')

    make_xlsx(args.out, rows, title)
    print(json.dumps({'ok': True, 'path': os.path.abspath(args.out), 'rows': len(rows)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        sys.exit(1)

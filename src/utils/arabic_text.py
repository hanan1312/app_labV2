"""Arabic-safe text handling for ReportLab-generated PDFs.

ReportLab draws every string as a flat left-to-right run of glyphs: it never performs
Arabic contextual letter-shaping (initial/medial/final forms) or bidi reordering, and its
built-in Type1 fonts (Helvetica etc.) have no Arabic glyphs at all — so any Arabic text
passed straight into a Paragraph/drawString shows up either as disconnected isolated
letters in the wrong order, or as solid black "tofu" boxes. Fix: reshape with
arabic_reshaper (joins letters into their correct contextual forms) and reorder with
python-bidi's get_display() (applies the bidi algorithm so the shaped text draws correctly
left-to-right), then render it in a bundled font that actually has Arabic glyphs
(NotoNaskhArabic, registered once via register_arabic_font()).
"""
import os
import re
from xml.sax.saxutils import escape as xml_escape

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ARABIC_FONT_NAME = 'NotoNaskhArabic'
_FONT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'static', 'fonts', 'NotoNaskhArabic.ttf')

# Arabic, Arabic Supplement, Arabic Extended-A, Arabic Presentation Forms A/B.
_ARABIC_RE = re.compile(r'[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]')

_font_registered = False


def register_arabic_font():
    """Registers the bundled Arabic font with ReportLab's global font registry. Safe to
    call from every module that generates PDFs — repeat calls are a no-op."""
    global _font_registered
    if _font_registered:
        return
    pdfmetrics.registerFont(TTFont(ARABIC_FONT_NAME, _FONT_PATH))
    _font_registered = True


def has_arabic(text):
    return bool(text) and bool(_ARABIC_RE.search(text))


def shape_arabic(text):
    """Returns `text` reshaped (letters joined into contextual forms) and bidi-reordered
    so it draws correctly through a renderer that only ever draws left-to-right."""
    if not text:
        return text
    return get_display(arabic_reshaper.reshape(text))


def rtl_text(value):
    """For a plain (non-Paragraph) string destination — e.g. canvas.drawString — that
    picks its own font based on has_arabic(value). Reshapes+reorders Arabic, otherwise
    returns the value unchanged."""
    value = value or ''
    return shape_arabic(value) if has_arabic(value) else value


def draw_string_auto(canvas_obj, x, y, text, latin_font, size):
    """canvas.drawString() replacement that switches to the Arabic-capable font (and
    reshapes/reorders the text) only when `text` actually contains Arabic — otherwise
    draws with `latin_font` exactly as before. Leaves the canvas's fill color alone;
    callers still set that themselves."""
    text = text or ''
    if has_arabic(text):
        canvas_obj.setFont(ARABIC_FONT_NAME, size)
        canvas_obj.drawString(x, y, shape_arabic(text))
    else:
        canvas_obj.setFont(latin_font, size)
        canvas_obj.drawString(x, y, text)


def paragraph_text(value):
    """For embedding a dynamic (user-entered) value inside ReportLab Paragraph markup
    that's otherwise in a Latin font (Helvetica etc.). Escapes XML special characters,
    and — only when the value actually contains Arabic — reshapes/reorders it and wraps
    it in a <font> tag switching to the Arabic-capable face for just that span, leaving
    surrounding English label text in the paragraph's normal font untouched."""
    value = value or ''
    if has_arabic(value):
        shaped = shape_arabic(value)
        return f'<font name="{ARABIC_FONT_NAME}">{xml_escape(shaped)}</font>'
    return xml_escape(value)

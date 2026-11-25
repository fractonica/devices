/*
 * fui_paint.c - the layout of each face, the text styles, and the painter's
 * text functions (hash + rows + draw), including the paged card column.
 */
#include "fui_i.h"

/* ------------------------------------------------------------------------- */
/* Layouts. Numbers for the round and one-bit faces are DESIGN.md S11's; the */
/* rectangular faces are the same instrument with rows of text under it.     */
/* Rows of text are 20 px (the 5 x 7 font at 2 px per dot): see the size     */
/* rule in fui_i.h.                                                          */
/* ------------------------------------------------------------------------- */

static const fui_layout_t LAYOUTS[FUI_FACE_COUNT] = {
    /* ROUND240: centre (120, 120), R = 56, g = 8, gM = 5.5; alpha's ring at r 116 */
    { { 240, 240, 0, 1 }, FUI_FX(120), FUI_FX(120), FUI_FX(56), FUI_FX(8), FUI_FX(5.5), FUI_FX(117),
      FUI_U_PX(5), 240, -1, -1, -1, -1, 22, 216, 225, 120, 0, 0, 0, 112, FUI_U_PX(5) },
    /* RECT240: three 20 px rows (reading, countdown, Earth) leave 180 rows:
     * the instrument at 5/7 scale, alpha's ring at r 82.7, the alidade to 87.7 */
    { { 240, 240, 0, 0 }, FUI_FX(120), FUI_FX(90), FUI_FX(40), FUI_FX(5.7), FUI_FX(3.9), FUI_FX(83.5),
      FUI_U_PX(4), 179, -1, 180, 200, 220, 6, 224, 232, 120, 0, 0, 0, 112, FUI_U_PX(5) },
    /* RECT240X320: the instrument at full size, then words, reading, countdown, Earth */
    { { 240, 320, 0, 0 }, FUI_FX(120), FUI_FX(122), FUI_FX(56), FUI_FX(8), FUI_FX(5.5), FUI_FX(117),
      FUI_U_PX(5), 244, 245, 257, 278, 299, 10, 300, 310, 160, 0, 0, 0, 112, FUI_U_PX(5) },
    /* MONO128: carrier R = 19 at (31.5, 31.5) in the left 64 x 64 */
    { { 128, 64, 1, 0 }, FUI_FX(31.5), FUI_FX(31.5), FUI_FX(19), 0, 0, 0,
      FUI_U_MONO, 64, -1, -1, -1, -1, 0, 60, 62, 32, 1, 0, 0, 26, FUI_U_MONO },
    /* MONO400X300 (e-paper): NOW is the wave alone, centred on the pixel
     * centre (199.5, 149.5) and sized at each focus so that its ink reaches
     * 146 px (126 in EARTH, whose civil time takes the bottom centre); R 70
     * is only where the fitting starts (fui_ring.c). The readings stand in
     * the corners (fui_face_mono400.c). Cards: the whole panel; the SUN
     * card's ring at r 140 (5/4 of the colour cards' 112) round the centre. */
    { { 400, 300, 1, 0 }, FUI_FX(199.5), FUI_FX(149.5), FUI_FX(70), FUI_FX(10), FUI_FX(6.875), FUI_FX(146.25),
      2u * FUI_U_MONO, 300, -1, -1, -1, -1, 10, 282, 291, 150, 0, 146, 126, 140, 2u * FUI_U_MONO }
};

const fui_layout_t *fui_i_layout(uint8_t face)
{
    return &LAYOUTS[face < FUI_FACE_COUNT ? face : FUI_FACE_ROUND240];
}

const fui_face_info_t *fui_face_info(fui_face_t face)
{
    return (unsigned)face < FUI_FACE_COUNT ? &LAYOUTS[face].info : NULL;
}

/* ------------------------------------------------------------------------- */
/* Styles                                                                     */
/* ------------------------------------------------------------------------- */

fui_text_style_t fui_i_style(const fui_painter_t *p, fui_style_id_t id)
{
    const fui_theme_t *t = p->theme;
    /* the 128 x 64 face's sizes; the paper face takes the colour faces' */
    int mono = p->lay->tiny;
    fui_text_style_t s;

    /* Written-out text: the 5 x 7 font, at 2 px per dot on colour (fui_i.h). */
    s.font = &fui_font_text;
    s.scale = (uint8_t)(mono ? 1 : 2);
    s.flags = 0;
    s.ink = t->bone;
    s.ink_symbol = t->ash;
    s.ink_earth = t->ash;
    switch (id) {
    case FUI_STYLE_READING_BIG:
        s.flags = FUI_TEXT_TWO_TONE | FUI_TEXT_CAPS;
        if (mono) {
            s.font = &fui_font_small; /* the count of DESIGN.md S11: 3 x 5 dots, 2 px each */
            s.scale = 2;
        }
        break;
    case FUI_STYLE_READING:
        /* May end in a translation ("END IN 6ι 43λ · ⊕ 14:56:12"): the tail
         * from the Earth sign on is ash and keeps its case. */
        s.flags = FUI_TEXT_TWO_TONE | FUI_TEXT_CAPS | FUI_TEXT_EARTH_TAIL;
        break;
    case FUI_STYLE_VALUE:
        /* "1 per 58 500 Blinks", "7 pB", "1η light · ⊕ 5.453 Tm": the core's
         * text as it comes, on every face. "pB" is the symbol ruling 3 fixes
         * and an SI prefix changes meaning with its case: never folded. */
        s.flags = FUI_TEXT_TWO_TONE | FUI_TEXT_EARTH_TAIL;
        break;
    case FUI_STYLE_LABEL:
        s.flags = FUI_TEXT_CAPS;
        s.ink = t->ash;
        break;
    case FUI_STYLE_NAME:
        s.flags = FUI_TEXT_CAPS;
        break;
    case FUI_STYLE_EARTH:
        s.ink = t->ash;
        break;
    case FUI_STYLE_TITLE:
        s.scale = (uint8_t)(mono ? 2 : 3);
        s.ink = t->lumen;
        if (mono) {
            s.font = &fui_font_small;
        }
        break;
    case FUI_STYLE_SOL:
        s.flags = FUI_TEXT_CAPS;
        s.ink = t->sol;
        break;
    case FUI_STYLE_FURNITURE:
        s.scale = 1;
        s.flags = FUI_TEXT_CAPS;
        s.ink = t->ash;
        break;
    default: /* FUI_STYLE_MARK */
        s.scale = 1;
        s.ink = t->ash;
        if (p->lay->info.mono) {
            s.font = &fui_font_small; /* its Earth sign is 5 x 5 */
        }
        break;
    }
    return s;
}

/* ------------------------------------------------------------------------- */
/* Text through the painter                                                   */
/* ------------------------------------------------------------------------- */

uint32_t fui_i_hash(uint32_t h, const void *data, size_t bytes)
{
    const uint8_t *p = (const uint8_t *)data;
    size_t i;

    for (i = 0; i < bytes; i++) {
        h = (h ^ p[i]) * 16777619u;
    }
    return h;
}

static size_t text_bytes(const char *text, size_t limit)
{
    size_t n = 0;

    while (n < limit && text[n] != '\0') {
        n++;
    }
    return n;
}

int fui_i_text(fui_painter_t *p, const fui_text_style_t *style, int x, int y, fui_align_t align,
               const char *text, size_t bytes, unsigned flags)
{
    size_t n = text_bytes(text, bytes);
    int width = fui_text_width(style, text, n), height = fui_text_height(style);

    if (align == FUI_ALIGN_CENTER) {
        x -= width / 2;
    } else if (align == FUI_ALIGN_RIGHT) {
        x -= width;
    }
    if (p->lines < FUI_MAX_LINES) {
        /* What the line shows (its bytes, where, in which ink) ... */
        int16_t place[2];
        uint32_t h = fui_i_hash(FUI_I_HASH_SEED, text, n);

        place[0] = (int16_t)x;
        place[1] = (int16_t)(style->ink ^ (style->scale << 8) ^ style->flags);
        p->hash[p->lines] = fui_i_hash(h, place, sizeof place);
        /* ... and which rows it occupies: a layout change redraws the face. */
        place[0] = (int16_t)y;
        place[1] = (int16_t)height;
        p->layout_hash = fui_i_hash(p->layout_hash, place, sizeof place);
        p->top[p->lines] = (int16_t)y;
        p->bottom[p->lines] = (int16_t)(y + height);
        p->lines++;
    }
    p->flags |= (uint8_t)flags;
    if (p->sink && n > 0) {
        p->sink(p->sink_ctx, text, n, x, y, style);
    }
    if (p->canvas && n > 0) {
        fui_text_draw(p->canvas, style, x, y, text, n);
    }
    return width;
}

void fui_i_mark(fui_painter_t *p, int y0, int y1, const void *what, size_t bytes)
{
    if (p->lines < FUI_MAX_LINES) {
        int16_t place[2];

        p->hash[p->lines] = fui_i_hash(FUI_I_HASH_SEED, what, bytes);
        place[0] = (int16_t)y0;
        place[1] = (int16_t)(y1 - y0);
        p->layout_hash = fui_i_hash(p->layout_hash, place, sizeof place);
        p->top[p->lines] = (int16_t)y0;
        p->bottom[p->lines] = (int16_t)y1;
        p->lines++;
    }
}

void fui_i_line_until(fui_painter_t *p, frc_time_t t)
{
    if (t == FRC_TIME_NONE || t <= p->ui->t) {
        p->flags |= FUI_LINE_LIVE; /* no promise: look again at the next Blink */
    } else if (p->until == FRC_TIME_NONE || t < p->until) {
        p->until = t;
    }
}

/* ------------------------------------------------------------------------- */
/* The card: a centred column over as many pages as it takes (fui_i.h)        */
/* ------------------------------------------------------------------------- */

void fui_i_card_init(fui_card_t *card, fui_painter_t *p, char *text)
{
    const fui_layout_t *lay = p->lay;

    card->p = p;
    card->text = text;
    card->top = lay->card_top;
    card->bottom = lay->card_bottom;
    card->marks_y = lay->card_marks_y;
    /* blank rows between text rows: none on 128 x 64, 3 on paper (room) */
    card->gap = (int16_t)(lay->tiny ? 0 : lay->info.mono ? 3 : 1);
    card->head = 0;
    /* The round face shows the inscribed circle only, less a 2 px rim. */
    card->clip_cy = (int16_t)(lay->info.height / 2);
    card->clip_r = (int16_t)(lay->info.round ? lay->info.width / 2 - 2 : 0);
    card->first_page = 0;
    card->head_y = card->top;
}

/* The width a row may take at rows [y, y + h). */
static int card_room(const fui_card_t *card, int y, int h)
{
    const fui_layout_t *lay = card->p->lay;

    if (card->clip_r > 0) {
        /* the chord at the row of the band that is farthest from the centre */
        int above = card->clip_cy - y, below = y + h - card->clip_cy, far = above > below ? above : below;

        if (far >= card->clip_r) {
            return 0;
        }
        return 2 * (int)fui_isqrt((uint32_t)(card->clip_r * card->clip_r - far * far)) - 4;
    }
    return lay->info.width - (lay->tiny ? 0 : 8);
}

static const char *skip_spaces(const char *text)
{
    while (*text == ' ') {
        text++;
    }
    return text;
}

/*
 * One row of a wrapping line: how many bytes of `text` go on it, and where
 * the next row starts. Words are taken while they fit `room` (the first even
 * if it does not). When the line must break, it breaks where two FACTS part
 * if the row holds such a place: before a " · " (the dot is dropped: the line
 * end says it) or after a comma; otherwise at the last space.
 */
static size_t row_take(const fui_text_style_t *style, const char *text, int room, const char **next)
{
    const char *word = text, *cut = NULL, *fact = NULL, *fact_next = NULL;

    for (;;) {
        const char *end = word;
        int dot;

        while (*end != '\0' && *end != ' ') {
            end++;
        }
        dot = end - word == 2 && (unsigned char)word[0] == 0xC2 && (unsigned char)word[1] == 0xB7;
        if (cut != NULL && fui_text_width(style, text, (size_t)(end - text)) > room) {
            if (dot) { /* the dot itself is what does not fit: the row ends before it */
                fact = cut;
                fact_next = skip_spaces(end);
            }
            break;
        }
        if (cut != NULL && dot) {
            fact = cut; /* the row may end before this middle dot ... */
            fact_next = skip_spaces(end);
        } else if (end > word && end[-1] == ',' && *end != '\0') {
            fact = end; /* ... or after this comma */
            fact_next = skip_spaces(end);
        }
        cut = end;
        if (*end == '\0') {
            *next = end;
            return (size_t)(end - text);
        }
        word = skip_spaces(end);
    }
    if (fact != NULL && fact > text) {
        *next = fact_next;
        return (size_t)(fact - text);
    }
    *next = skip_spaces(cut);
    return (size_t)(cut - text);
}

/* Does the row hold the Earth sign (U+2295: E2 8A 95)? */
static int has_earth(const char *text, size_t bytes)
{
    size_t i;

    for (i = 0; i + 2 < bytes; i++) {
        if ((unsigned char)text[i] == 0xE2 && (unsigned char)text[i + 1] == 0x8A && (unsigned char)text[i + 2] == 0x95) {
            return 1;
        }
    }
    return 0;
}

/* The rows of one line from row `y` down; returns the row after the last.
 * `emit`: send them to the painter (when this page is the one shown). */
static int line_flow(fui_card_t *card, const fui_text_style_t *style, const char *text, int y, int emit)
{
    fui_painter_t *p = card->p;
    fui_text_style_t row_style = *style;
    int height = fui_text_height(style), centre = p->lay->info.width / 2;

    while (*text != '\0') {
        const char *next;
        size_t bytes = row_take(&row_style, text, card_room(card, y, height), &next);

        if (emit) {
            fui_i_text(p, &row_style, centre, y, FUI_ALIGN_CENTER, text, bytes, 0);
        }
        if ((row_style.flags & FUI_TEXT_EARTH_TAIL) && has_earth(text, bytes)) {
            /* The Earth tail runs on into the next rows: ash, as written. */
            row_style.ink = row_style.ink_symbol = style->ink_earth;
            row_style.flags = 0;
        }
        y += height + card->gap;
        card->rows++;
        text = next;
    }
    return y;
}

static void next_page(fui_card_t *card)
{
    if (card->ends != NULL && card->page < FUI_CARD_PAGES) {
        card->ends[card->page] = card->y;
    }
    card->page++;
    card->rows = 0;
    card->y = card->page < FUI_CARD_PAGES ? card->start[card->page] : (int16_t)(card->top + card->head);
}

void fui_i_card_styled(fui_card_t *card, const fui_text_style_t *style, const char *text, unsigned flags)
{
    fui_painter_t *p = card->p;
    uint8_t rows = card->rows;

    /* A line that is not on the page shown still moves the lines that are:
     * its "look again then" counts wherever it is. */
    p->flags |= (uint8_t)flags;
    text = skip_spaces(text);
    if (*text == '\0') {
        return;
    }
    /* All rows of a line stay together: see where it would end from here. */
    if (rows > 0 && line_flow(card, style, text, card->y, 0) - card->gap > card->bottom) {
        next_page(card);
    } else {
        card->rows = rows;
    }
    card->y = (int16_t)line_flow(card, style, text, card->y, card->emit && card->page == p->ui->page);
}

void fui_i_card_pair(fui_card_t *card, fui_style_id_t id, const char *text, fui_style_id_t under_id,
                     const char *under, unsigned flags)
{
    fui_text_style_t style = fui_i_style(card->p, id), under_style = fui_i_style(card->p, under_id);
    uint8_t rows = card->rows;
    int end = line_flow(card, &style, text, card->y, 0);

    /* Both lines on one page: turn it first if the second would not fit. */
    end = line_flow(card, &under_style, under, end, 0);
    if (rows > 0 && end - card->gap > card->bottom) {
        next_page(card);
    } else {
        card->rows = rows;
    }
    fui_i_card_styled(card, &style, text, flags);
    fui_i_card_styled(card, &under_style, under, flags);
}

void fui_i_card_line(fui_card_t *card, fui_style_id_t id, const char *text, unsigned flags)
{
    fui_text_style_t style = fui_i_style(card->p, id);

    fui_i_card_styled(card, &style, text, flags);
}

void fui_i_card_space(fui_card_t *card, int rows)
{
    if (card->rows > 0) {
        card->y = (int16_t)(card->y + rows);
    }
}

/* The page beads (DESIGN.md S11: bead = count): one per page, lit through
 * the page shown, as every sibling counter of the instrument is. */
static void page_beads(const fui_card_t *card, int pages)
{
    const fui_painter_t *p = card->p;
    int mono = p->lay->tiny, pitch = mono ? 5 : 9, shown = p->ui->page, i;
    int x = p->lay->info.width / 2 - ((pages - 1) * pitch) / 2;

    for (i = 0; i < pages; i++, x += pitch) {
        if (mono) {
            if (i <= shown) {
                fui_canvas_fill_rect(p->canvas, x - 1, card->marks_y - 1, 3, 3, p->theme->bone);
            } else {
                fui_canvas_pixel(p->canvas, x, card->marks_y, p->theme->bone);
            }
        } else if (i <= shown) {
            fui_fill_disc(p->canvas, FUI_FX(x) + FUI_FX(0.5), FUI_FX(card->marks_y) + FUI_FX(0.5), FUI_FX(2), p->theme->bone);
        } else {
            fui_draw_ring(p->canvas, FUI_FX(x) + FUI_FX(0.5), FUI_FX(card->marks_y) + FUI_FX(0.5), FUI_FX(1.5),
                          FUI_FX(0.8), p->theme->etch3);
        }
    }
}

void fui_i_card_run(fui_card_t *card, const fui_card_part_t *part, int parts)
{
    fui_painter_t *p = card->p;
    int16_t first = (int16_t)(card->top + card->head), end[FUI_CARD_PAGES];
    int pass, i, pages, shown;

    for (i = 0; i < FUI_CARD_PAGES; i++) {
        card->start[i] = first;
        end[i] = first;
    }
    /* Pass 0 finds where each page's column ends when it starts at the top;
     * pass 1 starts each page lower by half of what was left, and draws.
     * (On a round face a row may wrap differently once moved: the second
     * pass lays every row out again where it really is, so a page can only
     * come out a little off centre, never over the edge.) */
    for (pass = 0; pass < 2; pass++) {
        card->page = card->first_page;
        card->rows = 0;
        card->y = first;
        if (pass == 1 && card->page < FUI_CARD_PAGES) {
            card->y = card->start[card->page];
        }
        for (i = 0; i < parts; i++) {
            if (card->rows > 0) {
                /* Try the part where the page stands: if it runs over, it
                 * starts the next page instead. */
                uint8_t page = card->page, rows = card->rows;
                int16_t y = card->y;
                int fits;

                card->emit = 0;
                card->ends = NULL;
                part[i](card);
                fits = card->page == page && card->y - card->gap <= card->bottom;
                card->page = page;
                card->rows = rows;
                card->y = y;
                if (!fits) {
                    card->ends = pass == 0 ? end : NULL;
                    next_page(card);
                }
            }
            card->emit = (uint8_t)pass;
            card->ends = pass == 0 ? end : NULL;
            part[i](card);
        }
        if (pass == 0) {
            if (card->page < FUI_CARD_PAGES) {
                end[card->page] = card->y;
            }
            for (i = 0; i < FUI_CARD_PAGES; i++) {
                int spare = card->bottom - (end[i] - card->gap);

                card->start[i] = (int16_t)(first + (spare > 0 && end[i] > first ? spare / 2 : 0));
            }
        }
    }
    card->ends = NULL;
    /* A last page without a row is not a page (a figure alone is page 0). */
    pages = card->page + (card->rows > 0 || card->page == 0 ? 1 : 0);
    p->pages = (uint8_t)pages;
    shown = p->ui->page < pages ? p->ui->page : pages - 1;
    card->head_y = (int16_t)((shown < FUI_CARD_PAGES ? card->start[shown] : first) - card->head);
    if (p->canvas && pages > 1) {
        page_beads(card, pages);
    }
}

/* ------------------------------------------------------------------------- */
/* Text assembly                                                              */
/* ------------------------------------------------------------------------- */

void fui_i_str_init(fui_str_t *s, char *buf, size_t size)
{
    s->buf = buf;
    s->size = size;
    s->len = 0;
    buf[0] = '\0';
}

void fui_i_str_add(fui_str_t *s, const char *text)
{
    while (*text != '\0' && s->len + 1 < s->size) {
        s->buf[s->len++] = *text++;
    }
    s->buf[s->len] = '\0';
}

void fui_i_str_keep(fui_str_t *s, size_t from)
{
    size_t spaces = 0, i, j;

    for (i = from; i < s->len; i++) {
        spaces += s->buf[i] == ' ';
    }
    if (spaces == 0 || s->len + spaces + 1 > s->size) {
        return;
    }
    /* each ' ' (1 byte) becomes C2 A0 (2 bytes): move the text up from the end */
    j = s->len + spaces;
    s->buf[j] = '\0';
    for (i = s->len; i-- > from;) {
        if (s->buf[i] == ' ') {
            s->buf[--j] = (char)0xA0;
            s->buf[--j] = (char)0xC2;
        } else {
            s->buf[--j] = s->buf[i];
        }
    }
    s->len += spaces;
}

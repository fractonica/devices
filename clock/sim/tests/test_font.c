/*
 * test_font.c - no reading may ever show a box.
 *
 * COVERAGE: every text function of the core is called over its whole domain
 * (all 63 levels, every unit, medium, band, quarter, Pentad, rate preset,
 * date form; every digit count; dates, spans and civil times at thousands of
 * instants across the catalogue), each result is decoded, and every code
 * point must have a glyph in BOTH fonts. A new symbol in the core fails here,
 * naming the code point and the text, before it reaches a display.
 * The UI's own words (labels) are checked the same way.
 *
 * Then the drawer itself: UTF-8 decoding (also of damaged input), widths,
 * capitals, the two-tone reading style, the missing-glyph box.
 *
 * And the SHAPES of the dot font: a Greek letter is a unit ("3ν" is three
 * Blinks, "3υ" three of a rung nine levels finer), so in the 3 x 5 font no
 * Greek letter may be one dot away from another letter, digit or capital.
 */
#include <string.h>

#include "fui_font.h"
#include "fui_i.h"
#include "sim_test.h"

static uint8_t seen[0x3000 / 8]; /* which code points the core has written */
static int texts, distinct;

static void see(const char *text)
{
    const char *p = text;
    uint32_t cp;

    texts++;
    while ((cp = fui_utf8_next(&p)) != 0) {
        int small = fui_font_has(&fui_font_small, cp), big = fui_font_has(&fui_font_text, cp);

        test_checks++;
        if (!small || !big) {
            test_failures++;
            if (test_failures <= 20) {
                printf("FAIL [%s] U+%04X has no glyph in %s%s: \"%s\"\n", test_section, (unsigned)cp,
                       small ? "" : "fui_font_small ", big ? "" : "fui_font_text", text);
            }
        }
        if (cp < 0x3000 && !(seen[cp / 8] & (1u << (cp % 8)))) {
            seen[cp / 8] |= (uint8_t)(1u << (cp % 8));
            distinct++;
        }
    }
}

/* Call a core format function and look at what it wrote. */
#define SEE(call)                                   \
    do {                                            \
        char buf_[200];                             \
        char *at_ = buf_;                           \
        size_t room_ = sizeof buf_;                 \
        if ((call) > 0) {                           \
            see(buf_);                              \
        }                                           \
    } while (0)

static void static_facts(void)
{
    frc_interval_t intervals[3];
    int level, unit, medium, digits, i;

    TEST_SECTION("coverage: levels, units, ladder");
    intervals[0].num = FRC_INTERVAL_REFERENCE_MS;
    intervals[0].den = 1;
    intervals[1] = frc_interval_mean(&FRC_SAROS_141);
    intervals[2] = frc_interval_of_alpha_ms(2275891508000ULL);
    for (level = 0; level < FRC_LEVEL_COUNT; level++) {
        frc_span_t span;
        uint64_t num, den;

        SEE(frc_format_level_name((uint8_t)level, at_, room_));
        SEE(frc_format_level_name((uint8_t)(level + 1), at_, room_));
        SEE(frc_format_level_word((uint8_t)level, at_, room_));
        SEE(frc_format_prefix((uint8_t)level, at_, room_));
        SEE(frc_format_count(frc_siblings((uint8_t)level), at_, room_));
        SEE(frc_format_count(frc_factor((uint8_t)level), at_, room_));
        for (digits = 0; digits <= 9; digits++) {
            SEE(frc_format_level_rate((uint8_t)level, (uint8_t)digits, at_, room_));
            for (i = 0; i < 3; i++) {
                SEE(frc_format_period((uint8_t)level, intervals[i], (uint8_t)digits, at_, room_));
                SEE(frc_format_frequency((uint8_t)level, intervals[i], (uint8_t)digits, at_, room_));
                for (medium = 0; medium < FRC_MEDIUM_COUNT; medium++) {
                    SEE(frc_format_length((uint8_t)level, intervals[i], frc_medium_speed((frc_medium_t)medium),
                                          (uint8_t)digits, at_, room_));
                }
            }
        }
        for (medium = 0; medium < FRC_MEDIUM_COUNT; medium++) {
            SEE(frc_format_light_span((uint8_t)level, frc_medium_speed((frc_medium_t)medium), 0, at_, room_));
            SEE(frc_format_light_span((uint8_t)level, frc_medium_speed((frc_medium_t)medium), 1, at_, room_));
        }
        for (unit = 0; unit < FRC_UNIT_COUNT; unit++) {
            SEE(frc_format_level_in_unit((uint8_t)level, (frc_unit_t)unit, at_, room_));
        }
        if (frc_span_of_level((uint8_t)level, &span) == FRC_OK) {
            for (i = 0; i <= 4; i++) {
                SEE(frc_format_span(&span, (uint8_t)i, at_, room_));
            }
            span.negative = 1;
            SEE(frc_format_span(&span, 0, at_, room_));
        }
        if (frc_level_per_blink((uint8_t)level, &num, &den) == FRC_OK) {
            SEE(frc_format_per_blink(num, den, at_, room_));
        }
        SEE(frc_format_band(frc_band((uint8_t)level, intervals[0]), at_, room_));
        SEE(frc_format_level_kind(frc_level_kind((uint8_t)level), at_, room_));
        SEE(frc_format_level_in_parent((uint8_t)level, at_, room_));
        SEE(frc_format_level_children((uint8_t)level, at_, room_));
    }
    SEE(frc_format_light_word(at_, room_));
    for (unit = 0; unit < FRC_UNIT_COUNT; unit++) {
        SEE(frc_format_unit_in_parent((frc_unit_t)unit, at_, room_));
    }
    SEE(frc_format_count_signed(INT64_MIN, at_, room_));
    SEE(frc_format_count_signed(-3, at_, room_));
    SEE(frc_format_per_blink(0, 1, at_, room_)); /* the em dash */
    SEE(frc_format_count(18446744073709551615ULL, at_, room_));
    {
        /* core 0.2.0: a span under 1/1000 Blink is "<0.001ν" (either sign),
         * and a negative civil year is written with U+2212 ("−0044") */
        frc_span_t tiny;
        frc_civil_t civil;
        int form;

        tiny.blinks = 0;
        tiny.frac = 1;
        for (i = 0; i < 2; i++) {
            tiny.negative = (uint8_t)i;
            SEE(frc_format_span(&tiny, 0, at_, room_));
        }
        frc_civil_from_time(FRC_TIME_FROM_S(-63549360000LL), 0, &civil); /* THU 15 MAR -0044 */
        for (form = 0; form < FRC_CIVIL_FORM_COUNT; form++) {
            SEE(frc_format_civil_text(&civil, 0, (frc_civil_form_t)form, at_, room_));
        }
    }

    TEST_SECTION("coverage: names");
    for (unit = 0; unit < FRC_UNIT_COUNT; unit++) {
        SEE(frc_format_unit_symbol((frc_unit_t)unit, at_, room_));
        SEE(frc_format_unit_name((frc_unit_t)unit, 0, at_, room_));
        SEE(frc_format_unit_name((frc_unit_t)unit, 1, at_, room_));
    }
    for (i = 0; i < 4; i++) {
        SEE(frc_format_quarter((frc_quarter_t)i, 0, at_, room_));
        SEE(frc_format_quarter((frc_quarter_t)i, 1, at_, room_));
    }
    for (i = 0; i <= 8; i++) {
        SEE(frc_format_band((frc_band_t)i, at_, room_));
    }
    for (medium = 0; medium < FRC_MEDIUM_COUNT; medium++) {
        SEE(frc_format_medium_id((frc_medium_t)medium, at_, room_));
        SEE(frc_format_medium_name((frc_medium_t)medium, at_, room_));
        SEE(frc_format_medium_phase((frc_medium_t)medium, at_, room_));
    }
    for (i = 0; i <= 30; i++) {
        SEE(frc_format_ordinal((uint16_t)i, at_, room_));
    }
    for (i = 0; i < FRC_RATE_COUNT; i++) {
        frc_rate_t rate;

        if (frc_rate_preset((uint8_t)i, &rate) == FRC_OK) {
            SEE(frc_format_rate(&rate, at_, room_));
        }
    }
    for (i = 0; i < 4; i++) {
        frc_pentad_t pentad;
        int form, helion;

        pentad.sync = 4820;
        pentad.index = (uint8_t)i;
        pentad.helions = (uint8_t)(i == 3 ? 4 : 5);
        pentad.start = pentad.end = 0;
        for (form = 0; form < 4; form++) {
            for (helion = 0; helion <= pentad.helions; helion++) {
                pentad.helion = (uint8_t)helion;
                SEE(frc_format_pentad(&pentad, (frc_pentad_form_t)form, helion > 0, at_, room_));
            }
        }
    }
}

static void readings(void)
{
    const frc_catalogue_t *cat = &FRC_SAROS_141;
    frc_time_t first = frc_catalogue_first(cat), last = frc_catalogue_last(cat), t;
    int i, form, finest, level;

    TEST_SECTION("coverage: dates, spans, cycle names, civil time over the catalogue");
    for (i = 0; i <= 3000; i++) {
        frc_date_t date;
        frc_civil_t civil;
        frc_span_t span;
        frc_threshold_t next;
        frc_pentad_t pentad;
        frc_sync_t sync;
        int32_t offset = (i % 5 - 2) * 12600; /* -7 h .. +7 h in 3.5 h steps */

        /* spread over 1244 years, never on a round instant */
        t = first + (frc_time_t)(((unsigned long long)(last - first) / 3000u) * (unsigned)i) + (i ? -(frc_time_t)(test_random() % 1000000u) : 0);
        if (i == 3000) {
            t = last;
        }
        if (frc_date_at(cat, t, &date) != FRC_OK) {
            CHECK(0);
            continue;
        }
        for (form = 0; form < 4; form++) {
            for (finest = FRC_UNIT_DELTA; finest <= FRC_UNIT_BLINK; finest++) {
                SEE(frc_format_date(&date, (frc_date_form_t)form, (frc_unit_t)finest, at_, room_));
            }
        }
        for (level = 0; level <= FRC_CLOCK_MAX_LEVEL; level++) {
            frc_cycle_t cycle;

            if (frc_cycle_at(cat, t, (uint8_t)level, &cycle) == FRC_OK) {
                SEE(frc_format_cycle_name((uint8_t)level, cycle.cycle, 0, at_, room_));
                SEE(frc_format_cycle_name((uint8_t)level, cycle.cycle, 1, at_, room_));
            }
            if (frc_next_threshold(cat, t, (uint8_t)level, &next) == FRC_OK && next.time != FRC_TIME_NONE &&
                frc_span_between(cat, t, next.time, &span) == FRC_OK) {
                SEE(frc_format_span(&span, 0, at_, room_));
                SEE(frc_format_span(&span, 3, at_, room_));
                if (frc_span_between(cat, next.time, t, &span) == FRC_OK) {
                    SEE(frc_format_span(&span, 0, at_, room_)); /* negative */
                }
            }
        }
        for (level = 0; level < FRC_UNIT_COUNT; level++) {
            SEE(frc_format_date_term(&date, (frc_unit_t)level, at_, room_));
        }
        if (frc_pentad_at(cat, t, &pentad) == FRC_OK) {
            for (form = 0; form < 4; form++) {
                SEE(frc_format_pentad(&pentad, (frc_pentad_form_t)form, 1, at_, room_));
            }
        }
        if (frc_sync_at(cat, t, &sync) == FRC_OK) {
            SEE(frc_format_count_signed(sync.sync, at_, room_));
            SEE(frc_format_count_signed(-(int64_t)sync.sync, at_, room_));
            if (frc_span_between(cat, sync.nominal, sync.start, &span) == FRC_OK) {
                SEE(frc_format_span(&span, 0, at_, room_));
                SEE(frc_format_span_in_unit(&span, FRC_UNIT_FLAVON, at_, room_));
            }
        }
        frc_civil_from_time(t, offset, &civil);
        SEE(frc_format_civil(&civil, offset, at_, room_));
        for (form = 0; form < FRC_CIVIL_FORM_COUNT; form++) {
            SEE(frc_format_civil_text(&civil, offset, (frc_civil_form_t)form, at_, room_));
        }
        /* random spans too: tiny, huge, either sign */
        span.negative = (uint8_t)(i & 1);
        span.blinks = (uint64_t)test_random() >> (test_random() % 32);
        span.frac = test_random();
        SEE(frc_format_span(&span, (uint8_t)(i % 5), at_, room_));
    }
}

/* Everything the UI itself says (labels are ASCII, signs are these). */
static void own_words(void)
{
    static const char *const words[] = {
        "Time", "not set", "Out of", "catalogue", "Earth", "Pure", " in ", "made of ", "depth ", "drift ",
        "solar sync ", FUI_S_EARTH, FUI_S_RING, FUI_S_DOT, FUI_S_ENDASH
    };
    size_t i;

    TEST_SECTION("coverage: the UI's own words");
    for (i = 0; i < sizeof words / sizeof words[0]; i++) {
        see(words[i]);
    }
}

static void drawer(void)
{
    static uint16_t pixels[120 * 24];
    fui_canvas_t c;
    fui_text_style_t style;
    const char *p;
    int x, y, n, ash, bone;

    TEST_SECTION("utf-8");
    p = "A\xCE\xB7\xE2\x88\x92\xE2\xAC\xA0";
    CHECK_EQ(fui_utf8_next(&p), 'A');
    CHECK_EQ(fui_utf8_next(&p), 0x03B7);
    CHECK_EQ(fui_utf8_next(&p), 0x2212);
    CHECK_EQ(fui_utf8_next(&p), 0x2B20);
    CHECK_EQ(fui_utf8_next(&p), 0);
    CHECK_EQ(fui_utf8_next(&p), 0); /* stays at the NUL */
    p = "\xCE";                     /* cut in the middle of a code point */
    CHECK_EQ(fui_utf8_next(&p), 0xFFFD);
    CHECK_EQ(fui_utf8_next(&p), 0);
    p = "\x80\xFFz";                /* stray bytes: one box each, then go on */
    CHECK_EQ(fui_utf8_next(&p), 0xFFFD);
    CHECK_EQ(fui_utf8_next(&p), 0xFFFD);
    CHECK_EQ(fui_utf8_next(&p), 'z');
    p = "\xC0\x80";                 /* overlong: not a NUL in disguise */
    CHECK_EQ(fui_utf8_next(&p), 0xFFFD);
    p = "\xF0\x9F\x98\x80";         /* outside the fonts, still one code point */
    CHECK_EQ(fui_utf8_next(&p), 0x1F600);
    CHECK(!fui_font_has(&fui_font_text, 0x1F600));

    TEST_SECTION("widths");
    style.font = &fui_font_text;
    style.scale = 1;
    style.flags = 0;
    style.ink = 0xFFFF;
    style.ink_symbol = 0x8410;
    CHECK_EQ(fui_text_width(&style, "", (size_t)-1), 0);
    CHECK_EQ(fui_text_width(&style, "0", (size_t)-1), 5);
    CHECK_EQ(fui_text_width(&style, "00", (size_t)-1), 11);     /* one blank column between */
    CHECK_EQ(fui_text_width(&style, "0123456789", 2), 11);      /* only the bytes asked for */
    for (n = '0'; n <= '9'; n++) {                              /* tabular digits */
        char digit[2];

        digit[0] = (char)n;
        digit[1] = '\0';
        CHECK_EQ(fui_text_width(&style, digit, (size_t)-1), 5);
        style.font = &fui_font_small;
        CHECK_EQ(fui_text_width(&style, digit, (size_t)-1), 3);
        style.font = &fui_font_text;
    }
    style.scale = 3;
    CHECK_EQ(fui_text_width(&style, "00", (size_t)-1), 33);
    CHECK_EQ(fui_text_height(&style), 30);
    style.scale = 1;
    /* the narrow no-break space is a thin gap, narrower than a space */
    CHECK(fui_text_width(&style, "58\xE2\x80\xAF" "500", (size_t)-1) < fui_text_width(&style, "58 500", (size_t)-1));
    /* capitals: a-z fold, Greek does not */
    style.flags = FUI_TEXT_CAPS;
    CHECK_EQ(fui_text_width(&style, "light", (size_t)-1), fui_text_width(&style, "LIGHT", (size_t)-1));
    style.flags = 0;
    CHECK(fui_text_width(&style, "i", (size_t)-1) != fui_text_width(&style, "I", (size_t)-1));

    TEST_SECTION("drawing");
    memset(pixels, 0, sizeof pixels);
    fui_canvas_init(&c, pixels, FUI_FMT_RGB565, 120, 24);
    style.flags = FUI_TEXT_TWO_TONE;
    x = fui_text_draw(&c, &style, 2, 2, "34\xCE\xB7 #", (size_t)-1);
    CHECK_EQ(x, 2 + fui_text_width(&style, "34\xCE\xB7 #", (size_t)-1));
    for (ash = bone = 0, y = 0; y < 24; y++) {
        for (n = 0; n < 120; n++) {
            bone += fui_canvas_get(&c, n, y) == 0xFFFF;
            ash += fui_canvas_get(&c, n, y) == 0x8410;
        }
    }
    CHECK(bone > 20 && ash > 20); /* digits in one ink, the letter and '#' in the other */
    /* a code point without a glyph is a visible hollow box */
    memset(pixels, 0, sizeof pixels);
    style.flags = 0;
    fui_text_draw(&c, &style, 10, 0, "\xF0\x9F\x98\x80", (size_t)-1);
    CHECK_EQ(fui_canvas_get(&c, 10, 1), 0xFFFF);  /* corner */
    CHECK_EQ(fui_canvas_get(&c, 14, 7), 0xFFFF);  /* opposite corner */
    CHECK_EQ(fui_canvas_get(&c, 12, 4), 0);       /* hollow */
    CHECK_EQ(fui_text_width(&style, "\xF0\x9F\x98\x80", (size_t)-1), 5);
}

/* The dots of one glyph of the dot font, as a 16 x 8 bitmap in `rows`. */
static void glyph_dots(uint32_t cp, uint16_t rows[8])
{
    static uint16_t pixels[16 * 8];
    fui_canvas_t c;
    fui_text_style_t style;
    char text[5];
    int x, y, n = 0;

    if (cp < 0x80) {
        text[n++] = (char)cp;
    } else { /* two bytes: all of Greek */
        text[n++] = (char)(0xC0 | (cp >> 6));
        text[n++] = (char)(0x80 | (cp & 0x3F));
    }
    text[n] = '\0';
    memset(pixels, 0, sizeof pixels);
    fui_canvas_init(&c, pixels, FUI_FMT_RGB565, 16, 8);
    style.font = &fui_font_small;
    style.scale = 1;
    style.flags = 0;
    style.ink = style.ink_symbol = style.ink_earth = 0xFFFF;
    fui_text_draw(&c, &style, 0, 0, text, (size_t)-1);
    for (y = 0; y < 8; y++) {
        rows[y] = 0;
        for (x = 0; x < 16; x++) {
            rows[y] = (uint16_t)(rows[y] | (fui_canvas_get(&c, x, y) ? 1u << x : 0u));
        }
    }
}

static int dots_apart(uint32_t a, uint32_t b)
{
    uint16_t ra[8], rb[8];
    int y, n = 0;

    glyph_dots(a, ra);
    glyph_dots(b, rb);
    for (y = 0; y < 8; y++) {
        uint16_t diff = (uint16_t)(ra[y] ^ rb[y]);

        for (; diff; diff = (uint16_t)(diff & (diff - 1))) {
            n++;
        }
    }
    return n;
}

static void shapes(void)
{
    uint32_t greek, other;

    TEST_SECTION("shapes: no Greek letter of the dot font is one dot from another glyph");
    for (greek = 0x03B1; greek <= 0x03C9; greek++) {
        if (greek == 0x03C2) {
            continue; /* final sigma: no level is named with it */
        }
        for (other = '0'; other <= 0x03C9; other++) {
            /* what the dot font is drawn with: digits, capitals (the faces
             * fold a-z), the other Greek letters */
            if (!((other >= '0' && other <= '9') || (other >= 'A' && other <= 'Z') ||
                  (other > greek && other <= 0x03C9 && other != 0x03C2))) {
                continue;
            }
            /* theta IS an O with a bar: one dot by nature (the header of the art says so) */
            if (greek == 0x03B8 && other == 'O') {
                CHECK_EQ(dots_apart(greek, other), 1);
                continue;
            }
            test_checks++;
            if (dots_apart(greek, other) < 2) {
                test_failures++;
                printf("FAIL [%s] U+%04X and U+%04X are %d dot(s) apart in fui_font_small\n", test_section,
                       (unsigned)greek, (unsigned)other, dots_apart(greek, other));
            }
        }
    }
    /* the three the stage-5 review named */
    CHECK(dots_apart(0x03BD, 0x03C5) >= 4); /* nu, upsilon */
    CHECK(dots_apart(0x03B9, 'L') >= 2);    /* iota, L */
    CHECK(dots_apart(0x03C0, 'n') >= 4);    /* pi, n */
}

int main(void)
{
    static_facts();
    readings();
    own_words();
    drawer();
    shapes();
    if (!test_failures) {
        printf("     font coverage: %d texts from the core, %d distinct code points, all in both fonts\n", texts, distinct);
    }
    TEST_SUMMARY("font");
}

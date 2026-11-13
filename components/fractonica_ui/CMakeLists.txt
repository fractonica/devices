# fractonica_ui - the portable UI library of the Fractonica clock.
#
# Pure C99 with no ESP-IDF include: the same sources are built for the host by
# sim/Makefile. As an ESP-IDF component it needs only the clock core, the
# component named "fractonica" (the sibling checkout ../../../core; how the
# project registers it under that name is described in esp32/AGENTS.md).
#
# The list is explicit because ESP-IDF wants its sources named. A new src/*.c
# must be added here; sim/Makefile picks it up by itself.

set(FRACTONICA_UI_SOURCES
    src/fui_arc.c
    src/fui_canvas.c
    src/fui_disc.c
    src/fui_face_mono.c
    src/fui_font.c
    src/fui_font_small.c
    src/fui_font_text.c
    src/fui_glyph.c
    src/fui_instrument.c
    src/fui_line.c
    src/fui_model.c
    src/fui_paint.c
    src/fui_ring.c
    src/fui_screen_lens.c
    src/fui_screen_now.c
    src/fui_screen_stamp.c
    src/fui_screen_sun.c
    src/fui_stroke.c
    src/fui_theme.c
    src/fui_trig.c
    src/fui_ui.c
    src/fui_words.c
)

idf_component_register(
    SRCS ${FRACTONICA_UI_SOURCES}
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS src
    REQUIRES fractonica
)

# Warning-free under ESP-IDF's default flags plus these (hard rule 4). C99:
# ESP-IDF compiles C as gnu17, so without -std a C11 feature could slip in.
# This library includes no ESP-IDF header, so it can be held to it here too
# (sim/Makefile also builds it -std=c99 -Wpedantic).
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -std=gnu99)

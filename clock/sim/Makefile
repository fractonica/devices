# sim/Makefile - host build of fractonica_ui + the core: simulator and tests.
#
#   make            build build/fractonica-sim
#   make shots      render every face x screen x mode (every page of each card) at SPEC vector A into out/
#   make test       unit tests, golden images, the no-heap check, the sanitizer fuzz
#   make golden     re-render the golden images and rewrite golden/hashes.txt
#   make pictures   the shots docs/GUIDE.md shows, into ../docs/ (kept in the repository)
#   make probe      build/probe: what the core says at an instant (to check a picture against)
#   make matrix     = ../tools/render-matrix.sh: all 916 face x screen x page x mode x vector pictures
#   make firmware   the firmware's own loop (main/app.c) for a simulated idle hour
#                   on every face: wake-ups, redraws, pixels sent to the panel
#   make bench      host time per full redraw and arc counts, per face
#   make stats      what a redraw costs: primitives, pixels cleared and inked, per face / screen / focus
#   make wakes      wake-ups of the UI task in a simulated hour at every focus level, every face
#   make stack      = ../tools/stack-report.py: the UI task's deepest chain of frames, per target
#   make info       sizes of the UI state and the frame buffers (this host)
#   make sizes      flash / RAM of the library for xtensa-esp32 and riscv32 (-Os)
#   make fonts      regenerate the font tables from tools/fonts/*.txt
#   make clean
#
# Needs only the system C compiler (and nm for the no-heap check). No library.
# The core is the first of ../../core (devices/core) and ../../../core (the
# organisation's sibling checkout beside the devices repository) that exists;
# override with CORE=<path>.

CC      ?= cc
CORE    ?= $(or $(patsubst %/include/fractonica.h,%,$(firstword $(wildcard ../../core/include/fractonica.h ../../../core/include/fractonica.h))),../../../core)
UI      := ../components/fractonica_ui
BUILD   ?= build
# -ffp-contract=off: no fused multiply-add, so the arc geometry (the only float
# code) rounds the same on every host and the golden hashes are portable.
CFLAGS  ?= -std=c99 -O2 -g -Wall -Wextra -Wpedantic -Wshadow -Werror -ffp-contract=off
# The application's portable part (the UI task's loop, the console commands)
# and the HAL's one portable file are built here too: see main/app.h.
APP     := ../main
HAL     := ../components/fractonica_hal
INCLUDE := -I$(UI)/include -I$(UI)/src -I$(CORE)/include -Isrc -I$(APP) -I$(HAL)/include
# make V=1 shows the compiler command lines
Q       := $(if $(V),,@)

UI_SRC   := $(wildcard $(UI)/src/*.c)
CORE_SRC := $(wildcard $(CORE)/src/*.c)
SIM_SRC  := src/sim_frame.c src/sim_png.c src/sim_port.c
APP_SRC  := $(APP)/app.c $(APP)/app_console.c $(APP)/app_shot.c
HAL_SRC  := $(HAL)/src/fhal_button.c
UI_OBJ   := $(patsubst $(UI)/src/%.c,$(BUILD)/ui/%.o,$(UI_SRC))
CORE_OBJ := $(patsubst $(CORE)/src/%.c,$(BUILD)/core/%.o,$(CORE_SRC))
SIM_OBJ  := $(patsubst src/%.c,$(BUILD)/sim/%.o,$(SIM_SRC))
APP_OBJ  := $(patsubst $(APP)/%.c,$(BUILD)/app/%.o,$(APP_SRC))
HAL_OBJ  := $(patsubst $(HAL)/src/%.c,$(BUILD)/hal/%.o,$(HAL_SRC))
LIBS     := $(SIM_OBJ) $(APP_OBJ) $(HAL_OBJ) $(UI_OBJ) $(CORE_OBJ)

SIM      := $(BUILD)/fractonica-sim
FWSIM    := $(BUILD)/fractonica-fwsim
PROBE    := $(BUILD)/probe
TESTS    := test_raster test_canvas test_font test_ui test_golden test_firmware test_fuzz
TEST_BIN := $(addprefix $(BUILD)/,$(TESTS))

FACES   := round240 rect240 rect240x320 mono
SCREENS := now scales lens sun stamp
MODES   := pure earth
# EARTH shots use UTC+2 so the offset is visible in every translation.
OFFSET  := 7200

.PHONY: all shots pictures test golden firmware bench info sizes fonts check-noheap clean probe matrix stats stack wakes
all: $(SIM) $(FWSIM) $(PROBE)

$(BUILD)/ui/%.o: $(UI)/src/%.c $(wildcard $(UI)/include/*.h $(UI)/src/*.h) $(CORE)/include/fractonica.h
	@mkdir -p $(dir $@)
	$(Q)$(CC) $(CFLAGS) $(INCLUDE) -c $< -o $@

$(BUILD)/core/%.o: $(CORE)/src/%.c $(CORE)/include/fractonica.h
	@mkdir -p $(dir $@)
	$(Q)$(CC) $(CFLAGS) -I$(CORE)/include -c $< -o $@

$(BUILD)/sim/%.o: src/%.c $(wildcard src/*.h $(UI)/include/*.h $(APP)/*.h)
	@mkdir -p $(dir $@)
	$(Q)$(CC) $(CFLAGS) $(INCLUDE) -c $< -o $@

$(BUILD)/app/%.o: $(APP)/%.c $(wildcard $(APP)/*.h $(UI)/include/*.h) $(CORE)/include/fractonica.h
	@mkdir -p $(dir $@)
	$(Q)$(CC) $(CFLAGS) $(INCLUDE) -c $< -o $@

$(BUILD)/hal/%.o: $(HAL)/src/%.c $(wildcard $(HAL)/include/*.h)
	@mkdir -p $(dir $@)
	$(Q)$(CC) $(CFLAGS) $(INCLUDE) -c $< -o $@

$(SIM): $(BUILD)/sim/sim_main.o $(LIBS)
	$(Q)$(CC) $(CFLAGS) $^ -o $@

$(FWSIM): $(BUILD)/sim/sim_firmware.o $(LIBS)
	$(Q)$(CC) $(CFLAGS) $^ -lpthread -o $@

# fractonica-stats: the library with its seven drawing entry points renamed in
# the files that DEFINE them, so that src/sim_stats.c can stand in between the
# faces and the rasteriser and count the calls. See sim_stats.c.
STATS      := $(BUILD)/fractonica-stats
STATS_REAL := fui_arc fui_line fui_disc fui_stroke fui_font
STATS_NAME := fui_draw_line fui_draw_arc fui_draw_arc_dotted fui_fill_disc fui_draw_ring fui_draw_segments fui_text_draw
STATS_OBJ  := $(patsubst %,$(BUILD)/stats/%.o,$(STATS_REAL)) \
              $(filter-out $(patsubst %,$(BUILD)/ui/%.o,$(STATS_REAL)),$(UI_OBJ))

$(BUILD)/stats/%.o: $(UI)/src/%.c $(wildcard $(UI)/include/*.h $(UI)/src/*.h)
	@mkdir -p $(dir $@)
	$(Q)$(CC) $(CFLAGS) $(INCLUDE) $(foreach f,$(STATS_NAME),-D$(f)=$(subst fui_,fui_real_,$(f))) -c $< -o $@

$(STATS): $(BUILD)/sim/sim_stats.o $(BUILD)/sim/sim_frame.o $(STATS_OBJ) $(CORE_OBJ)
	$(Q)$(CC) $(CFLAGS) $^ -o $@

stats: $(STATS)
	./$(STATS)

# The probe links the core alone: it must not be able to ask the UI anything.
$(PROBE): $(BUILD)/sim/sim_probe.o $(CORE_OBJ)
	$(Q)$(CC) $(CFLAGS) $^ -o $@

probe: $(PROBE)
	./$(PROBE)

matrix: $(SIM)
	../tools/render-matrix.sh

$(BUILD)/test_%: tests/test_%.c tests/sim_test.h $(LIBS)
	$(Q)$(CC) $(CFLAGS) $(INCLUDE) -Itests $< $(LIBS) -lm -o $@

# test_fuzz: the UI library and the core compiled again with the address and
# undefined-behaviour sanitizers, which stop at the first overflow, shift of
# a negative value or out-of-bounds access (tests/test_fuzz.c says what it
# feeds them). SAN= (empty) builds it without, for a compiler that has none.
SAN      ?= -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer
SAN_UI   := $(patsubst $(UI)/src/%.c,$(BUILD)/san/ui/%.o,$(UI_SRC))
SAN_CORE := $(patsubst $(CORE)/src/%.c,$(BUILD)/san/core/%.o,$(CORE_SRC))

$(BUILD)/san/ui/%.o: $(UI)/src/%.c $(wildcard $(UI)/include/*.h $(UI)/src/*.h) $(CORE)/include/fractonica.h
	@mkdir -p $(dir $@)
	$(Q)$(CC) $(CFLAGS) $(SAN) $(INCLUDE) -c $< -o $@

$(BUILD)/san/core/%.o: $(CORE)/src/%.c $(CORE)/include/fractonica.h
	@mkdir -p $(dir $@)
	$(Q)$(CC) $(CFLAGS) $(SAN) -I$(CORE)/include -c $< -o $@

$(BUILD)/test_fuzz: tests/test_fuzz.c tests/sim_test.h $(SAN_UI) $(SAN_CORE)
	$(Q)$(CC) $(CFLAGS) $(SAN) $(INCLUDE) -Itests $< $(SAN_UI) $(SAN_CORE) -lm -o $@

# Every page of a card: $(call PAGES,<file stem>,<sim arguments>) writes
# <stem>.png for page 1 and <stem>-2.png, <stem>-3.png ... for the others
# (the simulator's status line says "page 1/3").
PAGES = n=$$($(SIM) $(2) --page 1 --out $(1).png | sed -n 's/.* page [0-9]*\/\([0-9]*\) .*/\1/p'); \
        p=2; while [ $$p -le $${n:-1} ]; do $(SIM) $(2) --page $$p --out $(1)-$$p.png >/dev/null || exit 1; p=$$((p + 1)); done

shots: $(SIM)
	@mkdir -p out out/focus out/state
	@for face in $(FACES); do for mode in $(MODES); do \
	    $(SIM) --face $$face --mode $$mode --utc-offset $(OFFSET) --out out/$$face-now-$$mode.png || exit 1; \
	    $(SIM) --face $$face --screen scales --mode $$mode --utc-offset $(OFFSET) --out out/$$face-scales-$$mode.png || exit 1; \
	    for card in lens sun stamp; do \
	        $(call PAGES,out/$$face-$$card-$$mode,--face $$face --screen $$card --mode $$mode --utc-offset $(OFFSET)); \
	    done; \
	done; done
	@for face in $(FACES); do for focus in 0 1 2 3 4 5 6 7 8 9 10 11 12 13; do \
	    $(SIM) --face $$face --focus $$focus --out out/focus/$$face-focus$$focus.png || exit 1; \
	done; done
	@for face in $(FACES); do \
	    $(SIM) --face $$face --t none --out out/state/$$face-time-not-set.png || exit 1; \
	    $(SIM) --face $$face --t none --events N --out out/state/$$face-time-not-set-level-named.png || exit 1; \
	    $(SIM) --face $$face --t 99999999999 --out out/state/$$face-out-of-catalogue.png || exit 1; \
	    $(SIM) --face $$face --events L --out out/state/$$face-mode-named.png || exit 1; \
	    $(SIM) --face $$face --screen sun --focus 0 --out out/state/$$face-sun-focus0.png || exit 1; \
	    $(call PAGES,out/state/$$face-lens-level29,--face $$face --screen lens --events NNNNNNNNNNNNNNNNNNNNNNN --mode earth --utc-offset $(OFFSET)); \
	done

# The pictures of docs/GUIDE.md, in ../docs/ (the repository's documentation
# folder). Unlike out/ they are kept: re-run after a drawing change, and look.
# Every face, on its screens (every page of each card), at SPEC vector A
# unless the name says otherwise. A picture that is no longer made is removed.
# docs/hero.jpg, the front picture of README.md, is not made here (laid out by
# hand from round240-now, rect240x320-now-earth and mono-now); being a JPEG it
# is left alone.
DOCS := ../docs
pictures: $(SIM)
	@mkdir -p $(DOCS)
	@rm -f $(DOCS)/*.png
	@for face in $(FACES); do \
	    $(SIM) --face $$face --out $(DOCS)/$$face-now.png >/dev/null || exit 1; \
	    $(SIM) --face $$face --mode earth --utc-offset $(OFFSET) --out $(DOCS)/$$face-now-earth.png >/dev/null || exit 1; \
	    $(call PAGES,$(DOCS)/$$face-lens,--face $$face --screen lens); \
	    $(call PAGES,$(DOCS)/$$face-lens-earth,--face $$face --screen lens --mode earth --utc-offset $(OFFSET)); \
	    $(call PAGES,$(DOCS)/$$face-sun,--face $$face --screen sun); \
	    $(call PAGES,$(DOCS)/$$face-sun-earth,--face $$face --screen sun --mode earth --utc-offset $(OFFSET)); \
	    $(call PAGES,$(DOCS)/$$face-stamp,--face $$face --screen stamp); \
	    $(SIM) --face $$face --t none --out $(DOCS)/$$face-time-not-set.png >/dev/null || exit 1; \
	done
	@$(SIM) --face round240 --screen scales --out $(DOCS)/round240-scales.png >/dev/null
	@$(SIM) --face round240 --focus 3 --out $(DOCS)/round240-focus-delta.png >/dev/null
	@$(SIM) --face round240 --focus 9 --out $(DOCS)/round240-focus-kappa.png >/dev/null
	@$(SIM) --face round240 --focus 2 --mode earth --utc-offset $(OFFSET) --out $(DOCS)/round240-now-earth-gamma.png >/dev/null
	@$(SIM) --face round240 --screen lens --focus 13 --events NNNNNNNNNNNNNNNN --out $(DOCS)/round240-lens-visible.png >/dev/null
	@$(SIM) --face round240 --t none --events N --out $(DOCS)/round240-time-not-set-level-named.png >/dev/null
	@$(SIM) --face round240 --t 99999999999 --out $(DOCS)/round240-out-of-catalogue.png >/dev/null
	@$(SIM) --face rect240 --t 99999999999 --out $(DOCS)/rect240-out-of-catalogue.png >/dev/null
	@python3 ../tools/png-compress.py $(DOCS)/*.png
	@ls $(DOCS)/*.png | wc -l | xargs echo "pictures in docs/:"

# The UI library, the application's loop and the button logic must not
# reference the heap: look at their objects, not their source.
check-noheap: $(UI_OBJ) $(APP_OBJ) $(HAL_OBJ)
	@if nm -u $(UI_OBJ) $(APP_OBJ) $(HAL_OBJ) | grep -E ' _?(malloc|calloc|realloc|free|strdup|aligned_alloc|posix_memalign)$$'; then \
	    echo "FAIL: fractonica_ui / main/app*.c reference the heap"; exit 1; \
	else echo "ok   no-heap: fractonica_ui and main/app*.c reference no allocator ($(words $(UI_OBJ) $(APP_OBJ) $(HAL_OBJ)) objects)"; fi

test: $(TEST_BIN) $(SIM) $(FWSIM) check-noheap
	@for t in $(TEST_BIN); do ./$$t || exit 1; done
	@python3 ../tools/genfont.py --check && echo "ok   fonts: generated tables match tools/fonts/*.txt"

golden: $(BUILD)/test_golden
	./$(BUILD)/test_golden --refresh

# An idle hour from SPEC vector A at the Helion (focus 6), every face, both
# modes, whole frame and bands: how often the UI task wakes and what it sends.
firmware: $(FWSIM)
	@for face in $(FACES); do for mode in $(MODES); do \
	    ./$(FWSIM) --face $$face --mode $$mode --utc-offset 120 --seconds 3600 --brief || exit 1; \
	done; done
	@./$(FWSIM) --face round240 --band 40 --seconds 3600 --brief
	@./$(FWSIM) --face rect240x320 --band 40 --seconds 3600 --brief
	@for focus in 0 3 8 10 13; do ./$(FWSIM) --face round240 --focus $$focus --seconds 3600 --brief || exit 1; done
	@./$(FWSIM) --face round240 --t none --seconds 3600 --brief

# One simulated hour without input from vector A, every face, focus 0..13.
wakes: $(FWSIM)
	@for face in $(FACES); do for focus in 0 1 2 3 4 5 6 7 8 9 10 11 12 13; do \
	    ./$(FWSIM) --face $$face --focus $$focus --seconds 3600 --brief || exit 1; \
	done; done

stack:
	python3 ../tools/stack-report.py

bench: $(SIM)
	./$(SIM) --bench

info: $(SIM)
	./$(SIM) --info

sizes:
	../tools/size-report.sh

fonts:
	python3 ../tools/genfont.py

clean:
	rm -rf $(BUILD) out

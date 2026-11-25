/*
 * test_golden.c - golden images: every scene below is rendered and its
 * pixels hashed (64-bit FNV-1a, the same for every canvas format); the
 * hashes are checked in as golden/hashes.txt. A drawing change of any kind
 * shows up here as a named scene.
 *
 *   build/test_golden              compare; a scene that differs is written
 *                                  to out/golden-diff/<scene>.png to look at
 *   build/test_golden --refresh    re-render and rewrite golden/hashes.txt
 *                                  (`make golden`); do it only after looking
 *                                  at the new pictures (`make shots`)
 *
 * Scenes: face x screen x mode at SPEC vector A (EARTH at UTC+2) with the
 * second page of each card in EARTH, every focus 0..13 on the round and the
 * one-bit face, the two "no reading" states and the labels shown over them,
 * the mode label, the lens on the visible rung and on a level between two
 * units, and one scene for each defect the stage-5 review found (the Sun at
 * focus 0, the Earth hallmark where the bezel is smallest). The 400 x 300
 * paper face has every focus too, its NOW, SCALES and cards at a step, and
 * the Pentad's III and the Hypopentad's square.
 * The hashes do not depend on the host: the only float code (arc geometry)
 * is compiled without fused multiply-add (see the Makefile).
 */
#include <string.h>
#include <sys/stat.h>

#include "sim_frame.h"
#include "sim_png.h"
#include "sim_test.h"

#define GOLDEN_FILE "golden/hashes.txt"
#define MAX_SCENES 256

typedef struct scene {
    char     name[64];
    uint64_t hash;
} scene_t;

static scene_t rendered[MAX_SCENES], golden[MAX_SCENES];
static int rendered_count, golden_count;
static sim_frame_t frame;
static uint8_t scene_step; /* fui_step_t of the next scene (0: none) */

/* Render one scene, remember its hash; returns the frame for a diff picture. */
static void scene(const char *name, fui_face_t face, fui_screen_t screen, fui_mode_t mode, uint8_t focus,
                  frc_time_t t, const char *events)
{
    fui_config_t config;
    fui_ui_t ui;
    uint32_t ms = 0;
    scene_t *s = &rendered[rendered_count++];

    memset(&config, 0, sizeof config);
    config.face = face;
    config.mode = mode;
    config.focus = focus;
    config.utc_offset_s = 7200;
    config.step = scene_step;
    fui_ui_init(&ui, &config);
    sim_frame_init(&frame, face);
    fui_ui_update(&ui, t, ms);
    sim_goto_screen(&ui, screen, ms);
    sim_script(&ui, events, &t, &ms);
    fui_ui_invalidate(&ui);
    sim_render(&ui, &frame, t, ms, 0);
    snprintf(s->name, sizeof s->name, "%s", name);
    s->hash = sim_frame_hash(&frame);
}

static void save_diff(const char *name)
{
    char path[128];
    int w, h;
    uint8_t *rgb = sim_frame_rgb(&frame, frame.face == FUI_FACE_MONO128 ? 4 : 2, &w, &h);

    mkdir("out", 0777);
    mkdir("out/golden-diff", 0777);
    snprintf(path, sizeof path, "out/golden-diff/%s.png", name);
    if (rgb) {
        sim_png_write(path, rgb, w, h);
        free(rgb);
    }
}

static const scene_t *find(const char *name)
{
    int i;

    for (i = 0; i < golden_count; i++) {
        if (strcmp(golden[i].name, name) == 0) {
            return &golden[i];
        }
    }
    return NULL;
}

static void load_golden(void)
{
    FILE *f = fopen(GOLDEN_FILE, "r");
    char line[128];

    if (!f) {
        return;
    }
    while (golden_count < MAX_SCENES && fgets(line, sizeof line, f)) {
        unsigned long long hash;

        if (line[0] != '#' && sscanf(line, "%63s %llx", golden[golden_count].name, &hash) == 2) {
            golden[golden_count++].hash = hash;
        }
    }
    fclose(f);
}

/* Render every scene; with `check`, compare each as it is rendered. */
static void render_all(int check)
{
    static const frc_time_t t_a = FRC_TIME_FROM_S(SIM_VECTOR_A_S);
    char name[64];
    int face, screen, mode, focus, before;

#define SCENE(...)                                                                   \
    do {                                                                             \
        before = rendered_count;                                                     \
        scene(__VA_ARGS__);                                                          \
        if (check) {                                                                 \
            const scene_t *g = find(rendered[before].name);                          \
            test_checks++;                                                           \
            if (!g || g->hash != rendered[before].hash) {                            \
                test_failures++;                                                     \
                printf("FAIL golden %-34s %016llx, golden %s\n", rendered[before].name, \
                       (unsigned long long)rendered[before].hash, g ? "differs" : "missing"); \
                save_diff(rendered[before].name);                                    \
            }                                                                        \
        }                                                                            \
    } while (0)

    for (face = 0; face < FUI_FACE_COUNT; face++) {
        const char *fname = fui_face_name((fui_face_t)face);

        for (screen = 0; screen < FUI_SCREEN_COUNT; screen++) {
            for (mode = 0; mode < 2; mode++) {
                snprintf(name, sizeof name, "%s-%s-%s", fname, fui_screen_name((fui_screen_t)screen),
                         fui_mode_name((fui_mode_t)mode));
                SCENE(name, (fui_face_t)face, (fui_screen_t)screen, (fui_mode_t)mode, 6, t_a, "");
            }
        }
        snprintf(name, sizeof name, "%s-time-not-set", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_NOW, FUI_MODE_PURE, 6, FRC_TIME_NONE, "");
        snprintf(name, sizeof name, "%s-out-of-catalogue", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_NOW, FUI_MODE_PURE, 6, FRC_TIME_FROM_S(99999999999LL), "");
        snprintf(name, sizeof name, "%s-mode-named", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_NOW, FUI_MODE_PURE, 6, t_a, "L");
        snprintf(name, sizeof name, "%s-lens-level29", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_LENS, FUI_MODE_EARTH, 6, t_a, "NNNNNNNNNNNNNNNNNNNNNNN");
        /* the second page of each card (a card with one page: the next card) */
        snprintf(name, sizeof name, "%s-lens-earth-page2", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_LENS, FUI_MODE_EARTH, 6, t_a, "S");
        snprintf(name, sizeof name, "%s-sun-earth-page2", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_SUN, FUI_MODE_EARTH, 6, t_a, "S");
        snprintf(name, sizeof name, "%s-stamp-earth-page2", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_STAMP, FUI_MODE_EARTH, 6, t_a, "S");
        /* a level between two units: "11η · 396ι · 25 740λ", the span said once */
        snprintf(name, sizeof name, "%s-lens-zeta", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_LENS, FUI_MODE_PURE, 5, t_a, "");
        /* the Sun's running slot is lit whatever the focus (it was not at 0..3) */
        snprintf(name, sizeof name, "%s-sun-focus0", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_SUN, FUI_MODE_PURE, 0, t_a, "");
        /* labels show without a reading */
        snprintf(name, sizeof name, "%s-time-not-set-level-named", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_NOW, FUI_MODE_PURE, 6, FRC_TIME_NONE, "N");
        snprintf(name, sizeof name, "%s-time-not-set-mode-named", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_NOW, FUI_MODE_PURE, 6, FRC_TIME_NONE, "L");
        /* EARTH on NOW where a factor of 5 pulls the bezel in (gamma) */
        snprintf(name, sizeof name, "%s-now-earth-gamma", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_NOW, FUI_MODE_EARTH, 2, t_a, "");
        /* a two-part span that once wrapped before its last part ("7λ") */
        snprintf(name, sizeof name, "%s-sun-valley-span", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_SUN, FUI_MODE_PURE, 6, FRC_TIME_FROM_S(1700000000LL), "");
        /* rates below one a Blink with a whole reciprocal: "1 per 25 Blinks"
         * (Flavon), "1 per 5 Blinks" (mu); the core wrote "0.04 pB", "0.2 pB" */
        snprintf(name, sizeof name, "%s-lens-flavon", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_LENS, FUI_MODE_PURE, 10, t_a, "");
        snprintf(name, sizeof name, "%s-lens-mu-earth", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_LENS, FUI_MODE_EARTH, 11, t_a, "");
        /* a threshold on another civil day, years away: "⊕ 14 JUN 2031 03:12"
         * style (frc_format_civil_text DAY_MONTH_YEAR + MINUTE) */
        snprintf(name, sizeof name, "%s-lens-alpha-earth", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_LENS, FUI_MODE_EARTH, 0, t_a, "");
        /* the last rung: nothing below it is named; "no band" (ruling 4) */
        snprintf(name, sizeof name, "%s-lens-last-rung", fname);
        SCENE(name, (fui_face_t)face, FUI_SCREEN_LENS, FUI_MODE_PURE, 0, t_a, "P");
        if (face == FUI_FACE_MONO128) {
            /* the longest level name in the dot font, clear of the ring and the edge */
            SCENE("mono-scales-nuclide", FUI_FACE_MONO128, FUI_SCREEN_SCALES, FUI_MODE_PURE, 4, t_a, "");
            /* delta beside epsilon in the dot font (vector C, focus delta) */
            SCENE("mono-delta-epsilon", FUI_FACE_MONO128, FUI_SCREEN_NOW, FUI_MODE_PURE, 3,
                  FRC_TIME_FROM_S(2886085800LL), "");
        }
        if (face == FUI_FACE_MONO400X300) {
            /* the paper face at the step it is made for (the Preon) and the
             * finest (the Flavon): the instant of the cycle's start, the
             * readings down to the step's unit, minutes or seconds */
            static const struct { const char *name; fui_screen_t screen; fui_mode_t mode; uint8_t step; } STEPS[] = {
                { "mono400x300-now-pure-preon", FUI_SCREEN_NOW, FUI_MODE_PURE, FUI_STEP_PREON },
                { "mono400x300-now-earth-preon", FUI_SCREEN_NOW, FUI_MODE_EARTH, FUI_STEP_PREON },
                { "mono400x300-now-pure-flavon", FUI_SCREEN_NOW, FUI_MODE_PURE, FUI_STEP_FLAVON },
                { "mono400x300-now-earth-flavon", FUI_SCREEN_NOW, FUI_MODE_EARTH, FUI_STEP_FLAVON },
                { "mono400x300-now-earth-kappa", FUI_SCREEN_NOW, FUI_MODE_EARTH, FUI_STEP_KAPPA },
                { "mono400x300-scales-preon", FUI_SCREEN_SCALES, FUI_MODE_PURE, FUI_STEP_PREON },
                { "mono400x300-lens-earth-preon", FUI_SCREEN_LENS, FUI_MODE_EARTH, FUI_STEP_PREON },
                { "mono400x300-sun-earth-preon", FUI_SCREEN_SUN, FUI_MODE_EARTH, FUI_STEP_PREON },
                { "mono400x300-stamp-earth-preon", FUI_SCREEN_STAMP, FUI_MODE_EARTH, FUI_STEP_PREON }
            };
            unsigned k;

            for (k = 0; k < sizeof STEPS / sizeof STEPS[0]; k++) {
                scene_step = STEPS[k].step;
                SCENE(STEPS[k].name, FUI_FACE_MONO400X300, STEPS[k].screen, STEPS[k].mode, 6, t_a, "");
            }
            scene_step = FUI_STEP_PREON;
            SCENE("mono400x300-pentad3", FUI_FACE_MONO400X300, FUI_SCREEN_NOW, FUI_MODE_PURE, 6,
                  t_a + FRC_TIME_FROM_S(79200), "");
            SCENE("mono400x300-hypopentad", FUI_FACE_MONO400X300, FUI_SCREEN_NOW, FUI_MODE_PURE, 6,
                  t_a + FRC_TIME_FROM_S(172800), "");
            scene_step = FUI_STEP_NONE;
        }
        if (face == FUI_FACE_ROUND240 || face == FUI_FACE_MONO128 || face == FUI_FACE_MONO400X300) {
            for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
                snprintf(name, sizeof name, "%s-focus%d", fname, focus);
                SCENE(name, (fui_face_t)face, FUI_SCREEN_NOW, FUI_MODE_PURE, (uint8_t)focus, t_a, "");
            }
        }
    }
#undef SCENE
}

int main(int argc, char **argv)
{
    int refresh = argc > 1 && strcmp(argv[1], "--refresh") == 0, i;

    if (refresh) {
        FILE *f;

        render_all(0);
        f = fopen(GOLDEN_FILE, "w");
        if (!f) {
            printf("cannot write %s (run from sim/)\n", GOLDEN_FILE);
            return 1;
        }
        fprintf(f, "# Golden image hashes: <scene> <FNV-1a 64 of the face's pixels>.\n"
                   "# Written by `make golden` (tests/test_golden.c --refresh). Do not edit by hand.\n");
        for (i = 0; i < rendered_count; i++) {
            fprintf(f, "%s %016llx\n", rendered[i].name, (unsigned long long)rendered[i].hash);
        }
        fclose(f);
        printf("wrote %s: %d scenes\n", GOLDEN_FILE, rendered_count);
        return 0;
    }
    load_golden();
    TEST_SECTION("golden images");
    CHECK(golden_count > 0); /* golden/hashes.txt must exist: run from sim/ */
    render_all(1);
    CHECK_EQ(rendered_count, golden_count); /* no scene dropped without a refresh */
    TEST_SUMMARY("golden");
}

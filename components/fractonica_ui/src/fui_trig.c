/*
 * fui_trig.c - the integer helpers of the rasteriser: sine, cosine, square
 * root, and points / parts of an arc.
 *
 * WHY OUR OWN SINE: arcs arrive from the core as floats (frc_arc_child) and
 * are converted to fixed point once (fui_glyph.c). After that the rasteriser
 * needs end points and cut directions many times per frame; an ESP32-C3 has
 * no FPU, so those come from this 65-entry quarter-wave table (130 bytes of
 * flash) with linear interpolation. Error below 1e-4, i.e. 0.012 px at the
 * largest ring (r = 116). This is drawing arithmetic only: no Fractonica
 * quantity is computed here.
 */
#include "fui_raster_priv.h"

/* round(16384 * sin(k * pi / 128)), k = 0..64 */
static const int16_t SIN_Q14[65] = {
    0, 402, 804, 1205, 1606, 2006, 2404, 2801, 3196, 3590,
    3981, 4370, 4756, 5139, 5520, 5897, 6270, 6639, 7005, 7366,
    7723, 8076, 8423, 8765, 9102, 9434, 9760, 10080, 10394, 10702,
    11003, 11297, 11585, 11866, 12140, 12406, 12665, 12916, 13160, 13395,
    13623, 13842, 14053, 14256, 14449, 14635, 14811, 14978, 15137, 15286,
    15426, 15557, 15679, 15791, 15893, 15986, 16069, 16143, 16207, 16261,
    16305, 16340, 16364, 16379, 16384
};

/* sin over the first quarter turn, `q` = 0..16384 (16384 = a quarter turn). */
static int32_t quarter_sin(uint32_t q)
{
    uint32_t i = q >> 8, f = q & 255u;
    int32_t a = SIN_Q14[i];

    if (i >= 64) {
        return a;
    }
    return a + (((SIN_Q14[i + 1] - a) * (int32_t)f + 128) >> 8);
}

int32_t fui_sin(uint32_t angle)
{
    uint32_t a = angle & 0xFFFFu, q = a & 0x3FFFu;

    switch (a >> 14) {
    case 0:  return quarter_sin(q);
    case 1:  return quarter_sin(0x4000u - q);
    case 2:  return -quarter_sin(q);
    default: return -quarter_sin(0x4000u - q);
    }
}

int32_t fui_cos(uint32_t angle)
{
    return fui_sin(angle + 0x4000u);
}

uint32_t fui_isqrt(uint32_t v)
{
    /* Digit-by-digit: 16 rounds of shifts and compares, no divide. */
    uint32_t root = 0, bit = 1u << 30;

    while (bit > v) {
        bit >>= 2;
    }
    while (bit != 0) {
        if (v >= root + bit) {
            v -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    return root;
}

/* The angle travelled at fraction t: floor(sweep * t / 65536). One rule for
 * points and parts, so a part's end is exactly the next part's start. */
static int32_t travelled(const fui_arc_t *arc, int32_t t)
{
    return (int32_t)(((int64_t)arc->sweep * t) >> 16);
}

void fui_arc_point(const fui_arc_t *arc, int32_t t, fui_fx_t *x, fui_fx_t *y)
{
    uint32_t a = (uint32_t)((int32_t)arc->start + travelled(arc, t));

    if (x) {
        *x = arc->cx + (fui_fx_t)(((int64_t)arc->r * fui_cos(a) + 8192) >> 14);
    }
    if (y) {
        *y = arc->cy + (fui_fx_t)(((int64_t)arc->r * fui_sin(a) + 8192) >> 14);
    }
}

fui_arc_t fui_arc_part(const fui_arc_t *arc, int32_t t0, int32_t t1)
{
    fui_arc_t part = *arc;
    int32_t a0 = travelled(arc, t0), a1 = travelled(arc, t1);

    part.start = (uint16_t)((int32_t)arc->start + a0);
    part.sweep = a1 - a0;
    return part;
}

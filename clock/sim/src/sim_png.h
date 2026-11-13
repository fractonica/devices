/*
 * sim_png.h - the simulator's own PNG writer (host only; no library).
 */
#ifndef SIM_PNG_H
#define SIM_PNG_H

#include <stdint.h>

/** Write `rgb` (w * h * 3 bytes, rows top to bottom) as an 8-bit RGB PNG.
 *  @return 0, or -1 when the file cannot be written. */
int sim_png_write(const char *path, const uint8_t *rgb, int w, int h);

#endif /* SIM_PNG_H */

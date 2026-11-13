/*
 * fui_theme.c - the palettes. Hex values are those of DESIGN.md S2; the macro
 * rounds each channel to RGB565 at compile time.
 */
#include "fui_theme.h"

const fui_theme_t fui_theme_astrolabe = {
    FUI_RGB565(0x04, 0x05, 0x06), /* void       */
    FUI_RGB565(0x12, 0x16, 0x1B), /* etch-1     */
    FUI_RGB565(0x26, 0x2D, 0x36), /* etch-2     */
    FUI_RGB565(0x48, 0x52, 0x5E), /* etch-3     */
    FUI_RGB565(0x8D, 0x96, 0xA3), /* ash        */
    FUI_RGB565(0xE9, 0xEC, 0xF0), /* bone       */
    FUI_RGB565(0x8D, 0xF3, 0xE9), /* lumen      */
    FUI_RGB565(0x4B, 0xB3, 0xAB), /* lumen-mid  */
    FUI_RGB565(0x24, 0x5A, 0x57), /* lumen-dim  */
    FUI_RGB565(0x1A, 0x45, 0x43), /* lumen-etch */
    FUI_RGB565(0xFF, 0xD6, 0x0A), /* sol        */
    FUI_RGB565(0x7D, 0x6A, 0x12), /* sol-dim    */
    FUI_RGB565(0x2A, 0x26, 0x16), /* empty sync slot */
    FUI_RGB565(0xFF, 0x4A, 0x3A), /* h-alpha    */
    FUI_RGB565(0x64, 0x66, 0x68), /* alidade: bone at 42 % over void */
    FUI_RGB565(0xFF, 0xFF, 0xFF)  /* core of the point of now */
};

const fui_theme_t fui_theme_mono = {
    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
};

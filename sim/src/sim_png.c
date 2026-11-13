/*
 * sim_png.c - a minimal PNG encoder: 8-bit RGB, filter 0, and a zlib stream
 * of STORED deflate blocks (no compression). About 3 bytes a pixel; simple
 * enough to be obviously right, which is what a test tool wants.
 */
#include "sim_png.h"

#include <stdio.h>

static uint32_t crc_table[256];

static void crc_init(void)
{
    uint32_t n, k;

    for (n = 0; n < 256; n++) {
        uint32_t c = n;

        for (k = 0; k < 8; k++) {
            c = (c & 1u) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        }
        crc_table[n] = c;
    }
}

typedef struct writer {
    FILE    *f;
    uint32_t crc;   /* of the chunk being written */
    uint32_t a, b;  /* Adler-32 of the image data */
} writer_t;

static void put(writer_t *w, const uint8_t *data, size_t n)
{
    size_t i;

    for (i = 0; i < n; i++) {
        w->crc = crc_table[(w->crc ^ data[i]) & 0xFFu] ^ (w->crc >> 8);
    }
    fwrite(data, 1, n, w->f);
}

static void put_u32(writer_t *w, uint32_t v)
{
    uint8_t b[4];

    b[0] = (uint8_t)(v >> 24);
    b[1] = (uint8_t)(v >> 16);
    b[2] = (uint8_t)(v >> 8);
    b[3] = (uint8_t)v;
    put(w, b, 4);
}

static void chunk_begin(writer_t *w, const char *type, uint32_t length)
{
    put_u32(w, length);
    w->crc = 0xFFFFFFFFu;
    put(w, (const uint8_t *)type, 4);
}

static void chunk_end(writer_t *w)
{
    uint32_t crc = w->crc ^ 0xFFFFFFFFu;

    put_u32(w, crc);
}

/* Image bytes: through Adler-32 and into the current stored block. */
static void put_data(writer_t *w, const uint8_t *data, size_t n)
{
    size_t i;

    for (i = 0; i < n; i++) {
        w->a = (w->a + data[i]) % 65521u;
        w->b = (w->b + w->a) % 65521u;
    }
    put(w, data, n);
}

int sim_png_write(const char *path, const uint8_t *rgb, int w, int h)
{
    static const uint8_t signature[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
    writer_t out;
    uint32_t row = 1u + 3u * (uint32_t)w; /* filter byte + pixels */
    uint8_t head[13], block[5];
    int y;

    /* One stored block per row keeps every block under 65535 bytes. */
    if (w <= 0 || h <= 0 || row > 65535u) {
        return -1;
    }
    out.f = fopen(path, "wb");
    if (!out.f) {
        return -1;
    }
    crc_init();
    out.a = 1;
    out.b = 0;
    fwrite(signature, 1, 8, out.f);

    head[0] = (uint8_t)(w >> 24); head[1] = (uint8_t)(w >> 16); head[2] = (uint8_t)(w >> 8); head[3] = (uint8_t)w;
    head[4] = (uint8_t)(h >> 24); head[5] = (uint8_t)(h >> 16); head[6] = (uint8_t)(h >> 8); head[7] = (uint8_t)h;
    head[8] = 8;  /* bit depth */
    head[9] = 2;  /* colour type: RGB */
    head[10] = 0; head[11] = 0; head[12] = 0;
    chunk_begin(&out, "IHDR", 13);
    put(&out, head, 13);
    chunk_end(&out);

    /* zlib: 2 header bytes, per row a 5-byte block header + the row, 4 Adler bytes */
    chunk_begin(&out, "IDAT", 2u + (uint32_t)h * (5u + row) + 4u);
    block[0] = 0x78; block[1] = 0x01;
    put(&out, block, 2);
    for (y = 0; y < h; y++) {
        uint8_t filter = 0;

        block[0] = (uint8_t)(y == h - 1); /* BFINAL on the last row, BTYPE 00 */
        block[1] = (uint8_t)row; block[2] = (uint8_t)(row >> 8);
        block[3] = (uint8_t)~row; block[4] = (uint8_t)(~row >> 8);
        put(&out, block, 5);
        put_data(&out, &filter, 1);
        put_data(&out, rgb + (size_t)y * 3u * (size_t)w, 3u * (size_t)w);
    }
    put_u32(&out, (out.b << 16) | out.a);
    chunk_end(&out);

    chunk_begin(&out, "IEND", 0);
    chunk_end(&out);
    return fclose(out.f) == 0 ? 0 : -1;
}

/*
 * sim_port.h - the host port of the application (main/app.h): the firmware's
 * loop running on a desk, with a clock that jumps and a panel that is an
 * array.
 *
 * The device's UI task is `for (;;) app_step(&app);`. Here the same app_step
 * runs against this port:
 *   - time is simulated: port.wait does not sleep, it moves the clock to the
 *     next scripted message or to the deadline, whichever is first. An hour
 *     of clock takes milliseconds, and every wake-up is counted.
 *   - messages (input events, console lines, "time was set") are scheduled
 *     in advance with sim_port_event / sim_port_line.
 *   - port.flush copies each window into a model of the panel's memory, the
 *     way the controller would, checking the window as the real driver does,
 *     and moves the clock on by the time the bus takes to carry it (SPI at
 *     40 MHz: 0.4 us a colour pixel, 23 ms a 240 x 240 frame; I2C at
 *     400 kHz: 2.8 us a one-bit pixel, 23 ms a frame). Rasterising is free.
 *   - console output is captured.
 * What this does NOT exercise: the drivers, FreeRTOS, interrupts, the chip.
 * Host only: uses the C library and the heap.
 */
#ifndef SIM_PORT_H
#define SIM_PORT_H

#include "app.h"
#include "sim_frame.h"

#define SIM_SCRIPT_MAX 256

typedef struct sim_script_item {
    uint64_t  at_us; /* monotonic time the message arrives */
    app_msg_t msg;
} sim_script_item_t;

typedef struct sim_port {
    /* the clocks */
    frc_time_t wall_us;   /* Unix microseconds, or FRC_TIME_NONE: not set   */
    uint64_t   mono_us;   /* since "boot"                                   */
    uint64_t   end_us;    /* the run stops here                             */
    uint32_t   late_us;   /* every deadline wake is this late (tick jitter) */
    uint32_t   bus_ns_per_px; /* a flush takes this long per pixel: the clock
                             moves on while the panel is fed (sim_port_init
                             sets the bus of the face; 0: a free bus)       */
    int        ended;     /* the run reached end_us                         */
    unsigned   end_wakes; /* app_step returns caused by the END of a run:
                             the app counts them as deadline wakes          */
    /* scripted messages, in time order */
    sim_script_item_t script[SIM_SCRIPT_MAX];
    int        script_count, script_next;
    /* the panel's memory, as the glass shows it */
    sim_frame_t panel;
    uint16_t    panel_memory[240 * 320];
    fui_format_t format;       /* the format the app flushes in             */
    unsigned    flush_errors;  /* windows the real driver would refuse      */
    /* console output */
    char   *out;
    size_t  out_length, out_room;
    /* what the app asked of the platform */
    app_settings_t stored;
    unsigned saves, restarts, time_sets;
    int      brightness;
} sim_port_t;

/** A fresh device at "boot": clock `wall` (FRC_TIME_NONE: not set), dark panel. */
void sim_port_init(sim_port_t *port, fui_face_t face, fui_format_t format, frc_time_t wall);
void sim_port_free(sim_port_t *port);

/** The app_port_t that leads here. */
app_port_t sim_port_api(sim_port_t *port);

/** Schedule a message `at_ms` after boot. Call in time order. 0, or -1 when full.
 *  A line must stay valid until it has been run. */
int sim_port_event(sim_port_t *port, uint64_t at_ms, fui_event_t event);
int sim_port_line(sim_port_t *port, uint64_t at_ms, const char *line);
int sim_port_time_changed(sim_port_t *port, uint64_t at_ms);

/** Run app_step until `until_ms` after boot, then refresh once so the panel
 *  shows that instant. */
void sim_port_run(sim_port_t *port, app_t *app, uint64_t until_ms);

/** Forget the captured console output. */
void sim_port_clear_output(sim_port_t *port);

/**
 * Decode the last complete `shot` in `text` (the format of main/app_shot.c)
 * into `frame`'s canvas. Returns 0, or -1 when there is none, it is damaged,
 * or its hash does not match.
 */
int sim_shot_decode(const char *text, sim_frame_t *frame, uint16_t *memory);

#endif /* SIM_PORT_H */

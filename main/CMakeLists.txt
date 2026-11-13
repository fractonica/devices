# main - the application.
#
#   app.c app_console.c app_shot.c   PORTABLE C99: the UI task's loop, the
#                                    console commands, the screenshot. The host
#                                    simulator builds these same three files.
#   app_main.c                       the ESP-IDF port: app_main, the UI task,
#                                    the queue, and app_port_t on the HAL.
#   Kconfig.projbuild                every hardware choice.
idf_component_register(
    SRCS app.c app_console.c app_shot.c app_main.c
    INCLUDE_DIRS .
    PRIV_REQUIRES fractonica fractonica_ui fractonica_hal esp_timer esp_system esp_hw_support
)

# Warning-free under ESP-IDF's default flags plus these (hard rule 4).
# Compiled as ESP-IDF compiles C (gnu17): its own headers need C11 (they use
# static_assert), so -std=gnu99 cannot be set here. Our code in these files
# keeps to C99 all the same (no _Static_assert: see APP_CHECK in app_main.c);
# the portable files are also compiled -std=c99 -Wpedantic by sim/Makefile.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra)

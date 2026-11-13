# fractonica_hal - everything ESP-IDF specific: display drivers, input, time
# sources, settings, the console's line reader, light sleep.
#
# One display back end and one network file are compiled, chosen by Kconfig
# (main/Kconfig.projbuild). The REQUIRES list cannot depend on Kconfig (ESP-IDF
# reads it before sdkconfig exists), so every driver component is named; the
# linker drops what the chosen files do not call (the Wi-Fi stack is linked
# only with CONFIG_FRACTONICA_WIFI_SNTP).

set(sources
    src/fhal_button.c
    src/fhal_console.c
    src/fhal_input.c
    src/fhal_power.c
    src/fhal_settings.c
    src/fhal_time.c
)

if(CONFIG_FRACTONICA_DISPLAY_SSD1306)
    list(APPEND sources src/fhal_display_ssd1306.c)
else()
    list(APPEND sources src/fhal_display_spi.c)
    if(CONFIG_FRACTONICA_DISPLAY_GC9A01)
        list(APPEND sources src/fhal_panel_gc9a01.c)
    endif()
endif()

if(CONFIG_FRACTONICA_WIFI_SNTP)
    list(APPEND sources src/fhal_net.c)
else()
    list(APPEND sources src/fhal_net_off.c)
endif()

idf_component_register(
    SRCS ${sources}
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS src
    REQUIRES esp_common freertos
    PRIV_REQUIRES
        esp_driver_gpio esp_driver_i2c esp_driver_ledc esp_driver_pcnt esp_driver_spi
        esp_driver_uart esp_driver_usb_serial_jtag
        esp_event esp_hw_support esp_lcd esp_netif esp_pm esp_timer esp_wifi lwip nvs_flash
)

# Warning-free under ESP-IDF's default flags plus these (hard rule 4).
# Compiled as ESP-IDF compiles C (gnu17): its own headers need C11 (they use
# static_assert), so -std=gnu99 cannot be set here. Our code in these files
# keeps to C99 all the same (no _Static_assert: see APP_CHECK in app_main.c);
# the portable files are also compiled -std=c99 -Wpedantic by sim/Makefile.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra)

#!/usr/bin/env bash
# build-all.sh - the build matrix: every chip with the default display, and
# every other display, input kind and option at least once. Fails on any
# compiler or Kconfig warning.
#
#   tools/build-all.sh                all idf.py builds
#   tools/build-all.sh esp32s3 ...    only the named builds (see MATRIX below)
#   tools/build-all.sh --pio          also `pio run -e esp32-gc9a01` (PlatformIO
#                                     downloads its own copy of ESP-IDF and the
#                                     toolchains on first use: over 1 GB)
#   tools/build-all.sh --clean        remove the build directories first (with
#                                     --pio also PlatformIO's build and sdkconfig)
#   tools/build-all.sh --pio --clean pio-only    just the PlatformIO build
#                                     (a name that matches no idf.py build)
#
# Needs ESP-IDF 5.5: `source ~/esp/v5.5.1/esp-idf/export.sh` (the script does
# it when idf.py is not on the PATH and IDF_PATH or that directory exists).
# Each build has its own directory and its own sdkconfig under build/<name>/,
# so they never disturb each other or a hand-made sdkconfig.
#
# Nothing here flashes a board.
set -u
cd "$(dirname "$0")/.."

# name | target | defaults files added to sdkconfig.defaults (configs/<x>.defaults)
# (ci-wifi gives the Wi-Fi rows a placeholder network name: with none the
# linker drops the Wi-Fi stack, and its code would go unlinked.)
MATRIX="
esp32                      esp32    -
esp32s3                    esp32s3  -
esp32c3                    esp32c3  -
esp32-wifi-demo            esp32    wifi,ci-wifi,demo
esp32-st7789x320           esp32    st7789-240x320,buttons3
esp32s3-st7789-wifi        esp32s3  st7789-240x240,wifi,ci-wifi,button1
esp32c3-st7789-band        esp32c3  st7789-240x240,band,button1
esp32c3-ssd1306-wifi       esp32c3  ssd1306,buttons2,wifi,ci-wifi
esp32-ssd1306-lightsleep   esp32    ssd1306,lightsleep
esp32c3-lightsleep         esp32c3  lightsleep
esp32s3-ssd1306-lightsleep esp32s3  ssd1306,lightsleep
"

pio=0; clean=0; only=""
for arg in "$@"; do
    case "$arg" in
        --pio) pio=1 ;;
        --clean) clean=1 ;;
        -h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d'; exit 0 ;;
        *) only="$only $arg" ;;
    esac
done

if ! command -v idf.py >/dev/null 2>&1; then
    export_sh="${IDF_PATH:-$HOME/esp/v5.5.1/esp-idf}/export.sh"
    if [ -f "$export_sh" ]; then
        # shellcheck disable=SC1090
        . "$export_sh" >/dev/null 2>&1
    fi
fi
command -v idf.py >/dev/null 2>&1 || { echo "idf.py not found: source <esp-idf>/export.sh first" >&2; exit 2; }

failed=0
printf '%-28s %-8s %-8s %-9s %s\n' build target result warnings "app bytes"
while read -r name target extra; do
    [ -z "$name" ] && continue
    if [ -n "$only" ] && ! printf '%s\n' $only | grep -qx "$name"; then
        continue
    fi
    dir="build/$name"
    [ "$clean" = 1 ] && rm -rf "$dir"
    mkdir -p "$dir"
    defaults="sdkconfig.defaults"
    if [ "$extra" != "-" ]; then
        for piece in $(printf '%s' "$extra" | tr ',' ' '); do
            defaults="$defaults;configs/$piece.defaults"
        done
    fi
    if idf.py -B "$dir" -DIDF_TARGET="$target" -DSDKCONFIG="$dir/sdkconfig" \
              -DSDKCONFIG_DEFAULTS="$defaults" build >"$dir/build.log" 2>&1; then
        result=ok
    else
        result=FAILED; failed=1
    fi
    # Compiler, linker, CMake and Kconfig all say "warning".
    warnings=$(grep -ci 'warning' "$dir/build.log")
    [ "$warnings" != 0 ] && failed=1
    # Where ESP-IDF isolates every pin in light sleep (C3 / S3), the display
    # back end must exempt its own (fhal_power_keep_pin -> gpio_sleep_sel_dis),
    # or the panel's RST / CS / bus float during each sleep.
    if [ "$result" = ok ] && grep -q '^CONFIG_PM_SLP_DISABLE_GPIO=y' "$dir/sdkconfig"; then
        nm_tool=xtensa-esp-elf-nm
        grep -q '^CONFIG_IDF_TARGET_ARCH_RISCV=y' "$dir/sdkconfig" && nm_tool=riscv32-esp-elf-nm
        if ! "$nm_tool" -u "$dir/esp-idf/fractonica_hal/libfractonica_hal.a" 2>/dev/null | grep -q ' gpio_sleep_sel_dis$'; then
            echo "$name: light sleep isolates the pins, but the display driver keeps none of them" >&2
            result=NO-PINS; failed=1
        fi
    fi
    size=$(wc -c <"$dir/fractonica-clock.bin" 2>/dev/null | tr -d ' ')
    printf '%-28s %-8s %-8s %-9s %s\n' "$name" "$target" "$result" "$warnings" "${size:--}"
done <<EOF_MATRIX
$MATRIX
EOF_MATRIX

if [ "$pio" = 1 ]; then
    if command -v pio >/dev/null 2>&1; then
        mkdir -p build
        # --clean: PlatformIO keeps its build in .pio/ and one sdkconfig per
        # environment beside platformio.ini. It does not re-read
        # main/Kconfig.projbuild into an existing build, so a NEW option fails
        # to compile there ("CONFIG_FRACTONICA_... undeclared") until both go.
        [ "$clean" = 1 ] && rm -rf .pio/build/esp32-gc9a01 sdkconfig.esp32-gc9a01
        # PlatformIO brings its own ESP-IDF: it must not see the one sourced above.
        if env -u IDF_PATH -u IDF_PYTHON_ENV_PATH -u ESP_IDF_VERSION pio run -e esp32-gc9a01 >build/pio.log 2>&1; then
            result=ok
        else
            result=FAILED; failed=1
        fi
        warnings=$(grep -ci 'warning' build/pio.log)
        printf '%-28s %-8s %-8s %-9s %s\n' "pio:esp32-gc9a01" esp32 "$result" "$warnings" "(build/pio.log)"
    else
        echo "pio not found: PlatformIO build skipped" >&2
    fi
fi

[ "$failed" = 0 ] && echo "build matrix: all ok, no warnings" || echo "build matrix: FAILED (logs in build/<name>/build.log)"
exit "$failed"

#!/usr/bin/env bash
# size.sh - flash and RAM of the firmware, per component, for the builds that
# tools/build-all.sh (or you) left under build/, and the proof that the
# core's tables and our fonts are in flash, not in RAM.
#
#   tools/size.sh                  every build/<name>/ that has a map file
#   tools/size.sh esp32 esp32c3    the named builds
#
# For each build it prints (from ESP-IDF's size tool, the same numbers as
# `idf.py -B build/<name> size-components`):
#   - static RAM used and free, the flash image size
#   - the four archives of this project: RAM (.data + .bss) and flash
#     (code, constants)
# and CHECKS, failing the script otherwise:
#   - libfractonica.a (the core) and libfractonica_ui.a (the UI library)
#     contribute 0 bytes of RAM: no .data, no .bss
#   - the eclipse catalogue (SAROS_141_MS, FRC_SAROS_141) and both fonts
#     (fui_font_small, fui_font_text and their GLYPHS tables) are symbols of
#     the section .flash.rodata, which ESP-IDF maps from flash (DROM)
#
# Needs an ESP-IDF environment (sourced here if idf.py is not on the PATH).
# The companion for the UI library alone, without ESP-IDF, is
# tools/size-report.sh.
set -u
cd "$(dirname "$0")/.."

if [ -z "${IDF_PYTHON_ENV_PATH:-}" ]; then
    export_sh="${IDF_PATH:-$HOME/esp/v5.5.1/esp-idf}/export.sh"
    # shellcheck disable=SC1090
    [ -f "$export_sh" ] && . "$export_sh" >/dev/null 2>&1
fi
python="${IDF_PYTHON_ENV_PATH:-}/bin/python"
[ -x "$python" ] || { echo "ESP-IDF environment not found: source <esp-idf>/export.sh first" >&2; exit 2; }

if [ $# -gt 0 ]; then builds="$*"; else builds=$(cd build 2>/dev/null && ls -d */ 2>/dev/null | tr -d '/'); fi
failed=0
for name in $builds; do
    map="build/$name/fractonica-clock.map"
    elf="build/$name/fractonica-clock.elf"
    [ -f "$map" ] || continue
    target=$(sed -n 's/^CONFIG_IDF_TARGET="\(.*\)"/\1/p' "build/$name/sdkconfig")
    case "$target" in
        esp32c3) objdump=riscv32-esp-elf-objdump ;;
        *)       objdump=xtensa-$target-elf-objdump ;;
    esac
    echo "== $name ($target) =="
    "$python" -m esp_idf_size --format csv "$map" 2>/dev/null \
        | awk -F, '/^Used stat/ || /^Total image size/ { printf "  %-18s %s\n", $1, $2 }'
    # Columns differ per chip: find them by name in the header row.
    "$python" -m esp_idf_size --archives --format csv "$map" 2>/dev/null | awk -F, -v name="$name" '
        /^Archive File/ {
            for (i = 1; i <= NF; i++) {
                if ($i == "ram_st_total") ram = i
                if ($i == "Flash .text") code = i
                if ($i == "& .rodata") rodata = i
            }
            printf "  %-22s %10s %12s %14s\n", "archive", "RAM", "flash code", "flash rodata"
        }
        /^lib(main|fractonica|fractonica_ui|fractonica_hal)\.a,/ {
            printf "  %-22s %10d %12d %14d\n", $1, $ram, $code, $rodata
            if (($1 == "libfractonica.a" || $1 == "libfractonica_ui.a") && $ram != 0) bad = 1
            seen++
        }
        END {
            if (seen != 4) { print "  FAIL: expected four project archives in the map"; exit 1 }
            if (bad) { print "  FAIL: the core or the UI library uses RAM"; exit 1 }
            print "  ok   core and UI library: 0 bytes of RAM (.data + .bss)"
        }' || failed=1
    # Where the tables are: every one must be an object of .flash.rodata.
    tables=$("$objdump" -t "$elf" | awk '$NF ~ /^(SAROS_141_MS|FRC_SAROS_141|fui_font_small|fui_font_text|GLYPHS)$/')
    count=$(printf '%s\n' "$tables" | grep -c . )
    outside=$(printf '%s\n' "$tables" | grep -v '\.flash\.rodata' | grep -c . )
    if [ "$count" -ge 6 ] && [ "$outside" = 0 ]; then
        echo "  ok   catalogue and fonts: $count tables, all in .flash.rodata (flash, DROM)"
    else
        echo "  FAIL: $outside of $count tables are outside .flash.rodata"; printf '%s\n' "$tables"; failed=1
    fi
done
[ "$failed" = 0 ] && echo "size: all checks passed" || echo "size: FAILED"
exit "$failed"

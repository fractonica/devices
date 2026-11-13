#!/usr/bin/env bash
# size-report.sh - flash and RAM of fractonica_ui on the real targets.
#
#   tools/size-report.sh            (or `make sizes` in sim/)
#
# Compiles every source of components/fractonica_ui with the ESP-IDF cross
# compilers at -Os (the toolchains are found on PATH or under ~/.espressif;
# a missing one is skipped), then prints, per target:
#   - code + constants per object, and the fonts alone
#   - static RAM of the library itself (.data + .bss: must be 0)
#   - the size of the state the caller owns (fui_ui_t, fui_canvas_t)
#   - any reference to the heap (must be none)
# Every file is compiled with -Wall -Wextra -Werror, as the firmware build does.
# Objects only: nothing is linked and nothing is flashed.
set -u

here=$(cd "$(dirname "$0")/.." && pwd)
ui="$here/components/fractonica_ui"
core="${CORE:-}"
if [ -z "$core" ]; then
    # devices/core if present, else the organisation's sibling checkout
    if [ -f "$here/../core/include/fractonica.h" ]; then core="$here/../core"; else core="$here/../../core"; fi
fi
out="${TMPDIR:-/tmp}/fractonica-ui-size.$$"
status=0

# The compiler the firmware is built with: on the PATH (after export.sh), else
# the version ESP-IDF's tools.json recommends - never "the newest installed",
# whose figures would not be the firmware's (tools/stack-report.py does the same).
find_cc() { # find_cc <esp-idf tool> <compiler names...>
    local tool=$1 name found version
    shift
    for name in "$@"; do
        if command -v "$name" >/dev/null 2>&1; then
            command -v "$name"
            return 0
        fi
    done
    version=$(python3 -c 'import json,sys
for t in json.load(open(sys.argv[1]))["tools"]:
    if t["name"] == sys.argv[2]:
        print(next(v["name"] for v in t["versions"] if v.get("status") == "recommended"))' \
        "${IDF_PATH:-$HOME/esp/v5.5.1/esp-idf}/tools/tools.json" "$tool" 2>/dev/null)
    [ -n "$version" ] || return 1
    for name in "$@"; do
        found=$(ls -d "${IDF_TOOLS_PATH:-$HOME/.espressif}/tools/$tool/$version"/*/bin/"$name" 2>/dev/null | head -1)
        if [ -n "$found" ]; then
            echo "$found"
            return 0
        fi
    done
    return 1
}

report() { # report <label> <gcc> <flags...>
    local label=$1 cc=$2
    shift 2
    local size="${cc%gcc}size" nm="${cc%gcc}nm" dir="$out/$label" src obj
    mkdir -p "$dir"
    echo "== $label: gcc $("$cc" -dumpversion), -Os $* ($cc)"
    for src in "$ui"/src/*.c; do
        obj="$dir/$(basename "${src%.c}").o"
        if ! "$cc" -std=c99 -Os -ffunction-sections -fdata-sections -Wall -Wextra -Werror "$@" \
                -I"$ui/include" -I"$ui/src" -I"$core/include" -c "$src" -o "$obj"; then
            echo "FAIL: $(basename "$src") does not compile cleanly for $label"
            status=1
        fi
    done
    # Berkeley columns: text (code + constants) data bss
    "$size" "$dir"/*.o | awk -v label="$label" '
        NR > 1 { n = split($NF, path, "/"); name = path[n];
                 printf "   %-22s %6d\n", name, $1; text += $1; data += $2; bss += $3;
                 if (name ~ /^fui_font_(small|text)\.o$/) fonts += $1 }
        END    { printf "   %-22s %6d bytes of flash (code + constants)\n", "TOTAL", text;
                 printf "   %-22s %6d bytes (both tables)\n", "of which fonts", fonts;
                 printf "   %-22s %6d bytes (.data %d + .bss %d)\n", "library static RAM", data + bss, data, bss;
                 if (data + bss != 0) exit 1 }' || { echo "FAIL: the library has static RAM"; status=1; }
    # the caller-owned state, measured by the target compiler itself
    cat > "$dir/probe.c" <<'EOF'
#include "fui_ui.h"
fui_ui_t probe_ui;
fui_canvas_t probe_canvas;
fui_reading_t probe_reading;
fui_ring_t probe_ring;
EOF
    "$cc" -std=c99 -Os -fno-common "$@" -I"$ui/include" -I"$core/include" -c "$dir/probe.c" -o "$dir/probe.o"
    "$nm" -S "$dir/probe.o" | grep ' probe_' | sort -k4 | while read -r _ hex _ name; do
        printf '   sizeof(%-14s %5d bytes (static RAM the caller provides)\n' "fui_${name#probe_}_t)" "$((16#$hex))"
    done
    if "$nm" -u "$dir"/fui_*.o | grep -E ' (malloc|calloc|realloc|free|strdup)$'; then
        echo "FAIL: heap reference"
        status=1
    else
        echo "   no reference to malloc / calloc / realloc / free"
    fi
    echo "   other symbols the library needs: $("$nm" -u "$dir"/fui_*.o | awk '$1 == "U" && $2 !~ /^(fui_|frc_|FRC_)/ { print $2 }' | sort -u | tr '\n' ' ')"
    echo
}

if cc=$(find_cc xtensa-esp-elf xtensa-esp32-elf-gcc xtensa-esp-elf-gcc); then
    report "esp32 (xtensa)" "$cc" -mlongcalls
else
    echo "esp32 (xtensa): skipped, ESP-IDF's xtensa-esp-elf-gcc not found (source export.sh)"
fi
if cc=$(find_cc riscv32-esp-elf riscv32-esp-elf-gcc); then
    report "esp32-c3 (riscv32 rv32imc)" "$cc" -march=rv32imc_zicsr_zifencei -mabi=ilp32
else
    echo "esp32-c3 (riscv32): skipped, ESP-IDF's riscv32-esp-elf-gcc not found (source export.sh)"
fi
rm -rf "$out"
exit $status

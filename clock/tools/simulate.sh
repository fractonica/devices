#!/usr/bin/env bash
# simulate.sh - build the host simulator if needed and run it.
#
#   tools/simulate.sh --face round240 --screen now --mode pure --out now.png
#   tools/simulate.sh --face mono --screen lens --events "N N N" --out lens.png
#   tools/simulate.sh --info        tools/simulate.sh --bench
#
# Every option of sim/src/sim_main.c passes through; see its header comment
# or run without arguments. Needs only the system C compiler.
set -e
sim="$(cd "$(dirname "$0")/../sim" && pwd)"
make -s -C "$sim" build/fractonica-sim >&2
exec "$sim/build/fractonica-sim" "$@"

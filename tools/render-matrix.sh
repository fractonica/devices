#!/usr/bin/env bash
# render-matrix.sh - the COMPLETE simulator matrix, for a review by eye.
#
#   tools/render-matrix.sh [out-dir]          default: sim/out/matrix
#
# For each of SPEC S12's vectors A, B and C:
#   screens/  every face x mode: NOW, SCALES, and EVERY PAGE of LENS, SUN, STAMP
#   focus/    every face x focus level 0..13, NOW, both modes   (112)
#   lens/     every face x mode x every page of the LENS card of level
#             0 5 12 13 29 30 62 (5: between two units; 29: the visible rung)
#   sun/      every face x mode: SUN at focus 0 and 13 (one picture of an
#             instant, whatever the focus)
# and for the two states without a reading, every face x mode: NOW, a level
# and a mode just named over it, and each card's pages:
#   unset/    the time is not known
#   outside/  an instant outside the catalogue
# About 1,100 PNGs, a few seconds. `make shots` is the short version of this.
#
# Each PNG has its text beside it in <name>.txt (what the page says, as the
# core wrote it): grep those for a wording; look at the pictures for the rest.
# EARTH pictures use UTC+2 so the offset shows in every translation.
# Nothing here judges a picture: look at them (tools/contact-sheet.py lays
# many on one sheet), then check the numbers against `sim/build/probe`.
set -eu
cd "$(dirname "$0")/../sim"
out="${1:-out/matrix}"
make -s build/fractonica-sim
sim=build/fractonica-sim

FACES="round240 rect240 rect240x320 mono"
CARDS="lens sun stamp"
MODES="pure earth"
OFFSET=7200

# name:unix seconds (SPEC S12)
VECTORS="A:1791460800 B:946684800 C:2886085800"

# The LENS card of level L: the lens starts on the focus (0..13) and N goes
# one level finer without moving the focus.
lens_args() {
    case "$1" in
        0|5|12|13) echo "--focus $1" ;;
        29) echo "--focus 13 --events NNNNNNNNNNNNNNNN" ;;
        30) echo "--focus 13 --events NNNNNNNNNNNNNNNNN" ;;
        62) echo "--focus 0 --events P" ;;
    esac
}

count=0
shot() { # shot <file.png> <args...>: the picture, and what it says beside it
    file="$1"; shift
    "$sim" "$@" --utc-offset "$OFFSET" --lines --out "$file" | sed '1s/^[^:]*: //' > "${file%.png}.txt"
    count=$((count + 1))
}
pages() { # shot_pages <file stem> <args...>: one picture per page of a card
    stem="$1"; shift
    shot "$stem-p1.png" "$@" --page 1
    n=$(sed -n '1s/.* page [0-9]*\/\([0-9]*\) .*/\1/p' "$stem-p1.txt")
    p=2
    while [ "$p" -le "${n:-1}" ]; do
        shot "$stem-p$p.png" "$@" --page "$p"
        p=$((p + 1))
    done
}

for vector in $VECTORS; do
    name="${vector%%:*}"; t="${vector##*:}"
    mkdir -p "$out/$name/screens" "$out/$name/focus" "$out/$name/lens" "$out/$name/sun"
    for face in $FACES; do for mode in $MODES; do
        shot "$out/$name/screens/$face-now-$mode.png" --face "$face" --mode "$mode" --t "$t"
        shot "$out/$name/screens/$face-scales-$mode.png" --face "$face" --screen scales --mode "$mode" --t "$t"
        for card in $CARDS; do
            pages "$out/$name/screens/$face-$card-$mode" --face "$face" --screen "$card" --mode "$mode" --t "$t"
        done
        for focus in 0 1 2 3 4 5 6 7 8 9 10 11 12 13; do
            shot "$out/$name/focus/$face-focus$(printf %02d "$focus")-$mode.png" --face "$face" --mode "$mode" --t "$t" --focus "$focus"
        done
        for level in 0 5 12 13 29 30 62; do
            # shellcheck disable=SC2046
            pages "$out/$name/lens/$face-level$(printf %02d "$level")-$mode" --face "$face" --screen lens --mode "$mode" --t "$t" $(lens_args "$level")
        done
        for focus in 0 13; do
            shot "$out/$name/sun/$face-sun-focus$(printf %02d "$focus")-$mode.png" --face "$face" --screen sun --mode "$mode" --t "$t" --focus "$focus"
        done
    done; done
done

# 99999999999 s is the year 5138: after the catalogue's closing eclipse
for state in unset:none outside:99999999999; do
    name="${state%%:*}"; t="${state##*:}"
    mkdir -p "$out/$name"
    for face in $FACES; do for mode in $MODES; do
        shot "$out/$name/$face-now-$mode.png" --face "$face" --mode "$mode" --t "$t"
        shot "$out/$name/$face-level-named-$mode.png" --face "$face" --mode "$mode" --t "$t" --events N
        shot "$out/$name/$face-mode-named-$mode.png" --face "$face" --mode "$mode" --t "$t" --events L
        for card in $CARDS; do
            pages "$out/$name/$face-$card-$mode" --face "$face" --screen "$card" --mode "$mode" --t "$t"
        done
    done; done
done

echo "$count pictures in sim/$out (each with its text in a .txt beside it)"

#!/usr/bin/env python3
"""stack-report.py - the UI task's worst-case stack, from the compiler's own figures.

    tools/stack-report.py            both targets
    tools/stack-report.py -v         also the ten largest frames of each

Compiles the core, the UI library and the portable application (main/app*.c)
with the ESP-IDF cross compilers at -Os and `-fstack-usage
-fcallgraph-info=su`, then walks the call graph the compiler wrote (*.ci) from
the UI task's entry, app_step, and prints the deepest chain of frames.

What the figure covers: every function of this repository and of the core that
the UI task can reach. Calls through a pointer are followed where we know the
target (INDIRECT below). What it does NOT cover, because it is not compiled
here: the platform behind app_port_t (the display flush into esp_lcd and the
SPI / I2C driver, NVS, the queue), newlib (snprintf / vsnprintf, which
app_printf and the console commands use), libgcc's 64-bit division helpers,
and the interrupt frame FreeRTOS pushes on the running task's stack. The
docs/GUIDE.md adds allowances for those; the device prints the measured high-water
mark with the console command `info`.

THE COMPILER is the one the firmware is built with, or the figure is not the
firmware's (a newer gcc inlines differently: 2,064 bytes instead of 2,032 on
the same sources). It is found, in this order: on the PATH (after `source
<esp-idf>/export.sh`); else the version ESP-IDF itself installs, read from
$IDF_PATH/tools/tools.json (IDF_PATH defaults to ~/esp/v5.5.1/esp-idf), under
$IDF_TOOLS_PATH (default ~/.espressif). Never "the newest one installed".
Without either, the target is skipped and the report says why. The report
prints the compiler's path. Objects only: nothing is linked, nothing is
flashed.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.environ.get("CORE", os.path.join(HERE, "..", "core"))
UI = os.path.join(HERE, "components", "fractonica_ui")
MAIN = os.path.join(HERE, "main")

# label, (ESP-IDF tool name, compiler names), flags
TARGETS = [
    ("esp32 / esp32-s3 (xtensa)", "xtensa-esp-elf", ["xtensa-esp32-elf-gcc", "xtensa-esp-elf-gcc"], ["-mlongcalls"]),
    ("esp32-c3 (riscv32 rv32imc)", "riscv32-esp-elf", ["riscv32-esp-elf-gcc"],
     ["-march=rv32imc_zicsr_zifencei", "-mabi=ilp32"]),
]

ENTRY = "app_step"

# Calls through a pointer, by caller: where they can land. The compiler
# cannot know; we do. (static functions are named "file.c:function")
INDIRECT = {
    # the core hands each glyph segment to the sink the UI gave it
    "frc_glyph.c:emit_path": ["fui_glyph.c:collect"],
    # a card runs the parts its screen gave it (any screen's, to be safe)
    "fui_i_card_run": [
        "fui_screen_lens.c:part_identity", "fui_screen_lens.c:part_size", "fui_screen_lens.c:part_threshold",
        "fui_screen_lens.c:part_wave", "fui_screen_lens.c:part_media", "fui_screen_lens.c:part_status",
        "fui_screen_sun.c:part_pentad", "fui_screen_sun.c:part_sync", "fui_screen_sun.c:part_civil",
        "fui_screen_stamp.c:part_moment", "fui_screen_stamp.c:part_majors", "fui_screen_stamp.c:part_no_reading",
    ],
    # (fui_i_text calls painter->sink only under fui_ui_lines: tests and the simulator, not the UI task)
}
# app_port_t: the platform. Not compiled here; counted as a leaf and reported.
PORT_CALLERS_NOTE = "calls through app_port_t (flush, write, save ...) end the chain here"


def idf_tool_version(tool):
    """The version of `tool` ESP-IDF recommends (and installs), from its tools.json."""
    idf = os.environ.get("IDF_PATH", os.path.expanduser("~/esp/v5.5.1/esp-idf"))
    try:
        with open(os.path.join(idf, "tools", "tools.json")) as f:
            tools = json.load(f)["tools"]
    except (OSError, ValueError, KeyError):
        return None
    for entry in tools:
        if entry.get("name") == tool:
            for version in entry.get("versions", []):
                if version.get("status") == "recommended":
                    return version["name"]
    return None


def find_cc(tool, names):
    """(path, how it was found) of the compiler the firmware build uses, or (None, why not)."""
    for name in names:
        path = shutil.which(name)
        if path:
            return path, "on the PATH"
    version = idf_tool_version(tool)
    if not version:
        return None, "not on the PATH, and no ESP-IDF tools.json to say which version to use"
    root = os.environ.get("IDF_TOOLS_PATH", os.path.expanduser("~/.espressif"))
    for name in names:
        found = glob.glob(os.path.join(root, "tools", tool, version, "*", "bin", name))
        if found:
            return found[0], "ESP-IDF's version " + version
    return None, "ESP-IDF's version %s is not installed under %s" % (version, root)


def compile_all(cc, flags, out):
    sources = (sorted(glob.glob(os.path.join(CORE, "src", "*.c"))) + sorted(glob.glob(os.path.join(UI, "src", "*.c")))
               + [os.path.join(MAIN, f) for f in ("app.c", "app_console.c", "app_shot.c")])
    include = ["-I" + os.path.join(CORE, "include"), "-I" + os.path.join(UI, "include"), "-I" + os.path.join(UI, "src"),
               "-I" + MAIN]
    for src in sources:
        obj = os.path.join(out, os.path.basename(src)[:-2] + ".o")
        cmd = [cc, "-std=gnu99", "-Os", "-ffunction-sections", "-fdata-sections", "-fstack-usage",
               "-fcallgraph-info=su"] + flags + include + ["-c", src, "-o", obj]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            sys.exit("cannot compile %s:\n%s" % (src, result.stderr))


NODE = re.compile(r'node: \{ title: "([^"]+)" label: "([^"]*)"')
EDGE = re.compile(r'edge: \{ sourcename: "([^"]+)" targetname: "([^"]+)"')
BYTES = re.compile(r"(\d+) bytes")


def read_graph(out):
    frame, calls, dynamic = {}, {}, set()
    for path in glob.glob(os.path.join(out, "*.ci")):
        with open(path) as f:
            for line in f:
                m = NODE.search(line)
                if m:
                    size = BYTES.search(m.group(2))
                    if size:  # a function defined in this file
                        frame[m.group(1)] = int(size.group(1))
                        if "dynamic" in m.group(2):
                            dynamic.add(m.group(1))
                    continue
                m = EDGE.search(line)
                if m:
                    calls.setdefault(m.group(1), set()).add(m.group(2))
    # A static function is titled "<path as compiled>/file.c:function": name
    # it "file.c:function" everywhere, so the tables above and the report can.
    short = {name: (os.path.basename(name.split(":")[0]) + ":" + name.split(":")[1] if ":" in name else name)
             for name in set(frame) | set(calls) | {t for ts in calls.values() for t in ts}}
    frame = {short[n]: size for n, size in frame.items()}
    calls = {short[n]: {short[t] for t in ts} for n, ts in calls.items()}
    dynamic = {short[n] for n in dynamic}
    for caller, targets in INDIRECT.items():
        calls.setdefault(caller, set()).update(targets)
    return frame, calls, dynamic


def deepest(name, frame, calls, memo, path):
    """(bytes, chain) of the deepest chain starting at `name`."""
    if name in memo:
        return memo[name]
    if name in path:
        sys.exit("recursion: " + " -> ".join(path + [name]))
    best, chain = 0, []
    for target in calls.get(name, ()):
        if target not in frame:  # external or indirect: a leaf we cannot size
            continue
        depth, sub = deepest(target, frame, calls, memo, path + [name])
        if depth > best:
            best, chain = depth, sub
    memo[name] = (frame[name] + best, [name] + chain)
    return memo[name]


def main():
    verbose = "-v" in sys.argv[1:]
    status = 0
    for label, tool, names, flags in TARGETS:
        cc, how = find_cc(tool, names)
        if not cc:
            print("== %s: skipped: %s" % (label, how))
            status = 1
            continue
        out = tempfile.mkdtemp(prefix="fractonica-stack.")
        try:
            compile_all(cc, flags, out)
            frame, calls, dynamic = read_graph(out)
        finally:
            shutil.rmtree(out, ignore_errors=True)
        version = subprocess.run([cc, "-dumpversion"], capture_output=True, text=True).stdout.strip()
        print("== %s: gcc %s, -Os (%s: %s)" % (label, version, how, cc))
        if ENTRY not in frame:
            sys.exit("no call graph for " + ENTRY)
        if dynamic:
            print("   FAIL: frames of unknown size (alloca / VLA): " + ", ".join(sorted(dynamic)))
            status = 1
        memo = {}
        total, chain = deepest(ENTRY, frame, calls, memo, [])
        print("   deepest chain from %s: %d bytes in %d frames" % (ENTRY, total, len(chain)))
        for name in chain:
            print("      %5d  %s" % (frame[name], name))
        for start in ("fui_ui_update", "fui_ui_draw", "app_console_line"):
            if start in frame:
                depth, sub = deepest(start, frame, calls, memo, [])
                print("   from %-17s %5d bytes  (%s)" % (start + ":", depth, " > ".join(n.split(":")[-1] for n in sub)))
        reach = set()
        todo = [ENTRY]
        while todo:
            name = todo.pop()
            if name in reach or name not in frame:
                continue
            reach.add(name)
            todo.extend(calls.get(name, ()))
        external = sorted({t for n in reach for t in calls.get(n, ()) if t not in frame and t != "__indirect_call"})
        pointer = sorted(n for n in reach if "__indirect_call" in calls.get(n, ()))
        print("   calls through a pointer in: " + " ".join(pointer))
        print("   %d functions reachable; no recursion; %s" % (len(reach), PORT_CALLERS_NOTE))
        print("   not sized here (libc / libgcc): " + " ".join(external))
        if verbose:
            print("   largest frames reachable:")
            for name in sorted(reach, key=lambda n: -frame[n])[:10]:
                print("      %5d  %s" % (frame[name], name))
        print()
    return status


if __name__ == "__main__":
    sys.exit(main())

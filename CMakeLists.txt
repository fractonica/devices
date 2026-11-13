# Fractonica clock for ESP32 - the ESP-IDF project (also what PlatformIO builds).
#
#   idf.py -B build/esp32   -DIDF_TARGET=esp32   -DSDKCONFIG=build/esp32/sdkconfig   build
#   idf.py -B build/esp32s3 -DIDF_TARGET=esp32s3 -DSDKCONFIG=build/esp32s3/sdkconfig build
#   tools/build-all.sh          every target and display, warning-free
#
# WHERE THE CLOCK CORE COMES FROM
#   The firmware holds no Fractonica arithmetic: it links the C core, which is
#   another repository. ESP-IDF names a component after its DIRECTORY, and the
#   components here ask for one called "fractonica", so components/fractonica/
#   is a three-line wrapper that registers the core's sources from wherever
#   the checkout is. The first of these that exists is used:
#     1. -DFRACTONICA_CORE_DIR=<path>  on the idf.py / cmake command line
#     2. the environment variable FRACTONICA_CORE_DIR
#     3. ./core       a git submodule of this repository
#     4. ../core      the sibling checkout of the organisation (the default)
#   (A submodule checked out AT components/fractonica also works: the core's
#   own CMakeLists.txt then replaces the wrapper.)
cmake_minimum_required(VERSION 3.16)

if(NOT FRACTONICA_CORE_DIR)
    if(DEFINED ENV{FRACTONICA_CORE_DIR} AND NOT "$ENV{FRACTONICA_CORE_DIR}" STREQUAL "")
        set(FRACTONICA_CORE_DIR "$ENV{FRACTONICA_CORE_DIR}")
    elseif(EXISTS "${CMAKE_CURRENT_LIST_DIR}/core/include/fractonica.h")
        set(FRACTONICA_CORE_DIR "${CMAKE_CURRENT_LIST_DIR}/core")
    else()
        set(FRACTONICA_CORE_DIR "${CMAKE_CURRENT_LIST_DIR}/../core")
    endif()
endif()
get_filename_component(FRACTONICA_CORE_DIR "${FRACTONICA_CORE_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_LIST_DIR}")
if(NOT EXISTS "${FRACTONICA_CORE_DIR}/include/fractonica.h")
    message(FATAL_ERROR
        "The Fractonica core was not found at ${FRACTONICA_CORE_DIR}.\n"
        "Check it out beside this repository (../core), add it as the submodule ./core,\n"
        "or pass -DFRACTONICA_CORE_DIR=<path>. See docs/GUIDE.md, \"Build, flash, watch\".")
endif()
# ESP-IDF reads each component's CMakeLists.txt once in a separate cmake
# process (to learn its requirements) where cache variables are not visible:
# the environment is what reaches components/fractonica/CMakeLists.txt.
set(ENV{FRACTONICA_CORE_DIR} "${FRACTONICA_CORE_DIR}")

set(PROJECT_VER "0.1.0")

# Build only what main needs (and what it requires, transitively): a shorter
# build, and no Kconfig menus of components the clock never links.
set(COMPONENTS main)
if(EXISTS "$ENV{IDF_PATH}/components/__pio_env")
    # PlatformIO puts a component of its own into its copy of ESP-IDF and
    # reads the build settings from it: it must stay in the build.
    list(APPEND COMPONENTS __pio_env)
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(fractonica-clock)

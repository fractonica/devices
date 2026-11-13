# components/fractonica - the clock core, registered under the name the other
# components REQUIRE.
#
# The core is NOT in this directory: it is a separate repository (the sibling
# checkout beside the devices repository by default). ESP-IDF names a component after its directory,
# so a checkout called "core" could not be required as "fractonica"; this
# wrapper gives it the name without a symlink or a copy. The project's
# CMakeLists.txt decides where the core is and passes the path in the
# environment (see the comment there). Nothing under the core is modified.
#
# With a git submodule checked out AT components/fractonica this file does not
# exist: the core's own CMakeLists.txt registers the same sources.

set(core "$ENV{FRACTONICA_CORE_DIR}")
if(core STREQUAL "")
    # Built without the project file's help (e.g. as an extra component).
    # clock/components/fractonica -> devices/core, else the organisation's sibling checkout.
    get_filename_component(core "${CMAKE_CURRENT_LIST_DIR}/../../../core" ABSOLUTE)
    if(NOT EXISTS "${core}/include/fractonica.h")
        get_filename_component(core "${CMAKE_CURRENT_LIST_DIR}/../../../../core" ABSOLUTE)
    endif()
endif()

file(GLOB core_sources "${core}/src/*.c")

idf_component_register(
    SRCS ${core_sources}
    INCLUDE_DIRS "${core}/include"
    PRIV_INCLUDE_DIRS "${core}/src"
)

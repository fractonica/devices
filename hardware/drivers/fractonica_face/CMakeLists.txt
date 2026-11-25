# fractonica_face (design face-f1 D5): hal::Face over the clock library. The only component that includes it, so a
# profile without a face links neither the library nor the core.
idf_component_register(SRCS "src/fractonica_face.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES fractonica_ui fractonica)

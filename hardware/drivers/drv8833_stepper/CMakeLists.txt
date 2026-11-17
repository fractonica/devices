# drv8833_stepper (design stepper-s1 D7-D9): hal::Stepper on a DRV8833 module by bare pins. Drivers are the only code
# that includes driver/*.h (spec 03 §3.2); the public headers expose fr_core types only, and drv8833_bridge.hpp (the
# duty mapping, IDF-free) is tested on the host. linker.lf keeps the step and fault ISR paths in IRAM.
idf_component_register(SRCS "src/drv8833_stepper.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_gpio esp_driver_ledc esp_driver_gptimer
                       LDFRAGMENTS "linker.lf")

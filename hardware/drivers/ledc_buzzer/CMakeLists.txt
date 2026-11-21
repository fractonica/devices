# ledc_buzzer (design buzzer-b1 D4): hal::ToneOutput on one GPIO through LEDC. Drivers are the only code that includes
# driver/*.h (spec 03 §3.2); the public header exposes fr_core types only.
idf_component_register(SRCS "src/ledc_buzzer.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_gpio esp_driver_ledc)

# button_pin (design face-f1 D16): button_gpio's ButtonGpio on a bare pin; the code is button_gpio's component, which
# codegen puts on the component path with it (driver.yaml `uses`).
idf_component_register(INCLUDE_DIRS "include"
                       REQUIRES fr_core button_gpio)

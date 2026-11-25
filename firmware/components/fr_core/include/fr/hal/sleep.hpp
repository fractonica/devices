// hal::Sleep (design face-f1 D13-D15): power save's platform. Whether this boot runs offline (no network at all, kept
// in NVS), why the chip woke, and deep sleep with wake pins and held pins. The ESP runtime implements it
// (fr::core::sleep(), core.cpp); the host suite fakes it. Every call is for the core task.
#pragma once

#include <cstdint>

#include "fr/base.hpp"

namespace fr::hal {

enum class WakeCause : uint8_t {
    power_on = 0,  // power-on or brown-out: the RAM kept in deep sleep is not to be trusted
    reset = 1,     // a software reset, a crash, a watchdog, the reset button
    timer = 2,     // the deep-sleep timer
    pin = 3,       // a wake pin (wake_pins() says which)
};

class Sleep
{
public:
    virtual WakeCause wake_cause() const = 0;
    /** GPIO bit mask of the wake pins that woke the chip (WakeCause::pin). */
    virtual uint64_t wake_pins() const = 0;
    /** This boot runs with no network: no Wi-Fi, ESP-NOW or hub link was started. */
    virtual bool offline() const = 0;
    /** Saves the offline flag for the next boot (NVS); this boot is not changed. */
    virtual Status set_offline(bool on) = 0;
    /** A restart once the command being answered has gone out (BYE `sleep` first when `sleeping`). */
    virtual void restart(bool sleeping) = 0;
    /**
     * Deep sleep until `after_us` passes (0: no timer) or any GPIO in `wake_low` reads low; the GPIOs in `hold` keep
     * their levels while asleep. Never returns on the target (the wake is a fresh boot); the host fake records it.
     */
    virtual void deep_sleep(uint64_t after_us, uint64_t wake_low, uint64_t hold) = 0;
    /** The level of a GPIO now (a wake pin: a button still held through the boot). */
    virtual bool pin_low(int gpio) const = 0;

protected:
    ~Sleep() = default;
};

}  // namespace fr::hal

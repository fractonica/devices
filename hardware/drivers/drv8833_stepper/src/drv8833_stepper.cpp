// fr:realtime
// drv8833_stepper (design stepper-s1 D7-D9): see include/fr/drv/drv8833_stepper.hpp. This file is only the IDF glue:
// pins, LEDC, the gptimer, the two ISRs and the safe-off hook. The motion arithmetic is fr::motion's and the duty
// mapping drv8833_bridge.hpp's, both tested on the host.
//
// linker.lf maps this object `noflash`: the gptimer alarm ISR (CONFIG_GPTIMER_ISR_CACHE_SAFE) and the nFAULT ISR (on
// an ESP_INTR_FLAG_IRAM GPIO ISR service when the firmware's one service has it) run while flash is busy, so their code,
// the inlined hal/ledc_ll.h and hal/gpio_ll.h writes and whatever -Og leaves out of line sit in IRAM, and the object's
// rodata in DRAM. The driver object is static (fr_board.cpp), so the engine's table and the alarm config are in DRAM.
//
// Context of each path:
//   gptimer alarm ISR   a step (engine.on_alarm, four LEDC duty writes, the next alarm) or the wake check
//   GPIO ISR on nFAULT  the cut: pads low, nSLEEP low, engine.fault(), alarm off, the input slot
//   core task           every hal::Stepper method; on_fault through the input slot
//   restart, panic      pads low, nSLEEP low (register writes, no lock)
#include "fr/drv/drv8833_stepper.hpp"

#include <cstdio>

#include "driver/gpio.h"
#include "driver/gptimer.h"
#include "driver/ledc.h"
#include "esp_attr.h"
#include "esp_intr_alloc.h"
#include "esp_log.h"
#include "fr/drv/drv8833_bridge.hpp"
#include "fr/platform/gpio_isr.hpp"
#include "fr/platform/safe_off.hpp"
#include "freertos/FreeRTOS.h"
#include "hal/gpio_ll.h"
#include "hal/ledc_ll.h"
#include "hal/ledc_periph.h"
#include "sdkconfig.h"
#include "soc/gpio_sig_map.h"
#include "soc/gpio_struct.h"
#include "soc/ledc_struct.h"

// driver.yaml's `sdkconfig` list sets both in every profile that binds the driver (design stepper-s1 D7). With flash
// auto-suspend the cache stays on during flash writes and the ISR-cache-safe option does not exist.
#if !CONFIG_GPTIMER_ISR_CACHE_SAFE && !CONFIG_SPI_FLASH_AUTO_SUSPEND
#error "drv8833_stepper steps from the gptimer ISR while flash is busy: CONFIG_GPTIMER_ISR_CACHE_SAFE=y"
#endif
#if !CONFIG_GPTIMER_CTRL_FUNC_IN_IRAM
#error "drv8833_stepper arms the next step from its ISR: CONFIG_GPTIMER_CTRL_FUNC_IN_IRAM=y"
#endif

namespace fr::drv {
namespace {

constexpr const char *TAG = "drv8833_stepper";

// LEDC low-speed timer 0 and channels 0-3, fixed (design stepper-s1 D8, risks): AIN1, AIN2, BIN1, BIN2 in that order,
// sharing the timer so their duties latch at the same period boundary.
constexpr ledc_mode_t kMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t kLedcTimer = LEDC_TIMER_0;
constexpr int kChannels = 4;
// The step timer's resolution: 1 MHz, so counts are microseconds and the 54-bit counter never wraps.
constexpr uint32_t kTimerHz = 1'000'000;

// Guards the engine and the ISR state: the task side's methods and both ISRs (design stepper-s1 D9, the lock). On the
// single-core C3 a critical section is a few dozen cycles with interrupts off.
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
// The alarm config gptimer_set_alarm_action reads: static DRAM, as CONFIG_GPTIMER_CTRL_FUNC_IN_IRAM requires
// (esp_ptr_internal), written only under s_mux.
gptimer_alarm_config_t s_alarm = {};
// The pins the cut and the safe-off hook drive low, constant-initialized (-1 = none). One instance per node.
int8_t s_pads[kChannels] = {-1, -1, -1, -1};
int8_t s_sleep = -1;
bool s_taken = false;

/** Every IN pad back on the GPIO output register, driven low, off the LEDC signal, and nSLEEP low: register writes
 *  only, no lock, IRAM. The fault cut, and the restart and panic hooks (a CPU reset keeps LEDC and the GPIO matrix). */
IRAM_ATTR void pads_low()
{
    for (const int8_t pin : s_pads) {
        if (pin < 0) {
            continue;
        }
        gpio_ll_set_level(&GPIO, pin, 0);
        gpio_ll_output_enable(&GPIO, pin);
        gpio_ll_set_output_enable_ctrl(&GPIO, static_cast<uint8_t>(pin), false, false);
        gpio_ll_set_output_signal_matrix_source(&GPIO, pin, SIG_GPIO_OUT_IDX, false);
    }
    if (s_sleep >= 0) {
        gpio_ll_set_level(&GPIO, s_sleep, 0);
    }
}

/** The four channels' duties, latched at their next period boundary: inline register writes (ledc_set_duty is
 *  neither ISR-safe nor in IRAM). */
IRAM_ATTR void write_duties(const drv8833::Duties &d)
{
    for (int i = 0; i < kChannels; ++i) {
        const auto ch = static_cast<ledc_channel_t>(i);
        ledc_ll_set_duty_int_part(&LEDC, kMode, ch, d.in[i]);
        ledc_ll_set_duty_start(&LEDC, kMode, ch);
        ledc_ll_ls_channel_update(&LEDC, kMode, ch);
    }
}

IRAM_ATTR bool reads_low(int8_t pin)
{
    return gpio_ll_get_level(&GPIO, pin) == 0;
}

}  // namespace

struct Drv8833Stepper::Isr {
    /** The gptimer alarm (IRAM; CONFIG_GPTIMER_ISR_CACHE_SAFE checks it is). */
    static IRAM_ATTR bool alarm(gptimer_handle_t, const gptimer_alarm_event_data_t *e, void *ctx)
    {
        auto *self = static_cast<Drv8833Stepper *>(ctx);
        portENTER_CRITICAL_ISR(&s_mux);
        const bool cut = self->alarm_locked(e->count_value);
        portEXIT_CRITICAL_ISR(&s_mux);
        if (cut) {
            self->notify_fault();
        }
        return false;  // the input slot yields itself when it wakes the core task
    }

    /** nFAULT fell (IRAM, on the GPIO ISR service). Ignored while the bridge sleeps or wakes: the wake alarm reads the
     *  line once t_WAKE has passed. A line already high again was a glitch, not a fault: the DRV8833 holds it low for
     *  as long as the fault lasts (over-current: until its retry, about a millisecond later). */
    static IRAM_ATTR void fault(void *arg)
    {
        auto *self = static_cast<Drv8833Stepper *>(arg);
        if (!reads_low(self->cfg_.fault)) {
            return;
        }
        bool cut = false;
        portENTER_CRITICAL_ISR(&s_mux);
        if (self->power_ == Power::on) {
            self->cut_locked();
            cut = true;
        }
        portEXIT_CRITICAL_ISR(&s_mux);
        if (cut) {
            self->notify_fault();
        }
    }
};

// ---- under s_mux ----

IRAM_ATTR void Drv8833Stepper::drive_locked()
{
    const auto e = static_cast<uint8_t>((engine_.phase() + phase_offset_) & (motion::kPhaseIndexes - 1u));
    write_duties(drv8833::drive(engine_.vector(e), peak_));
}

uint64_t Drv8833Stepper::now_locked() const
{
    uint64_t now = 0;
    gptimer_get_raw_count(timer_, &now);
    return now;
}

void Drv8833Stepper::wake_locked()
{
    if (cfg_.sleep < 0) {
        power_ = Power::on;  // the module holds nSLEEP high: the bridge never slept
        return;
    }
    gpio_ll_set_level(&GPIO, cfg_.sleep, 1);
    power_ = Power::waking;
    const uint64_t now = now_locked();
    arm_locked(now + kWakeUs, now, Alarm::wake);
}

IRAM_ATTR void Drv8833Stepper::arm_locked(uint64_t at, uint64_t now, Alarm kind)
{
    // Absolute counts, so rounding never accumulates; one set in the past fires at once.
    if (at < now + kLeadUs) {
        at = now + kLeadUs;
    }
    s_alarm.alarm_count = at;
    s_alarm.reload_count = 0;
    s_alarm.flags.auto_reload_on_alarm = 0;
    gptimer_set_alarm_action(timer_, &s_alarm);
    due_ = at;
    alarm_ = kind;
}

IRAM_ATTR void Drv8833Stepper::disarm_locked()
{
    gptimer_set_alarm_action(timer_, nullptr);
    alarm_ = Alarm::none;
}

IRAM_ATTR void Drv8833Stepper::step_locked(uint64_t due, uint64_t now)
{
    const uint64_t late = now > due ? now - due : 0;
    const motion::Tick t = engine_.on_alarm(late > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(late));
    if (t.stepped) {
        drive_locked();
    }
    if (!t.again) {
        disarm_locked();  // at rest (or nothing ran): the coils hold the last vector at run power
        return;
    }
    // The next step is `interval` after this one's due time; when that has passed already, after now: no catch-up
    // bursts (the engine re-ramps when a step was late enough to slip).
    uint64_t next = due + t.interval_us;
    if (next <= now) {
        next = now + t.interval_us;
    }
    arm_locked(next, now, Alarm::step);
}

IRAM_ATTR bool Drv8833Stepper::alarm_locked(uint64_t now)
{
    // An interrupt raised by an alarm the task side has since replaced or taken away finds a later due time, or none.
    if (alarm_ == Alarm::none || now < due_) {
        return false;
    }
    if (alarm_ == Alarm::wake) {
        alarm_ = Alarm::none;
        if (cfg_.fault >= 0 && reads_low(cfg_.fault)) {
            cut_locked();  // the bridge woke into a fault (design stepper-s1 D9, D11)
            return true;
        }
        power_ = Power::on;
        step_locked(now, now);  // a motion waiting for the wake takes its first step now; none: nothing happens
        return false;
    }
    step_locked(due_, now);
    return false;
}

IRAM_ATTR void Drv8833Stepper::cut_locked()
{
    pads_low();  // the pads off LEDC, driven low, and nSLEEP low: within microseconds
    write_duties(drv8833::Duties{});  // coast on LEDC too, so clear_fault() hands the pads back at duty 0
    engine_.fault();
    disarm_locked();
    power_ = Power::off;
    cut_ = true;
}

IRAM_ATTR void Drv8833Stepper::notify_fault()
{
    if (slot_ != nullptr) {
        slot_->update_from_isr(false, 0);  // IRAM-safe (fr_core's linker.lf); from a task it notifies normally
    }
}

// ---- core task ----

Status Drv8833Stepper::init(Core &core, Callback<void(), 24> on_fault)
{
    if (ready_) {
        return std::unexpected(Err::failed);
    }
    const uint8_t pads[kChannels] = {cfg_.ain1, cfg_.ain2, cfg_.bin1, cfg_.bin2};
    for (const uint8_t pin : pads) {
        if (!GPIO_IS_VALID_OUTPUT_GPIO(pin)) {
            return std::unexpected(Err::invalid_args);
        }
    }
    if ((cfg_.sleep >= 0 && !GPIO_IS_VALID_OUTPUT_GPIO(cfg_.sleep)) || (cfg_.fault >= 0 && !GPIO_IS_VALID_GPIO(cfg_.fault))) {
        return std::unexpected(Err::invalid_args);
    }
    if (s_taken) {
        ESP_LOGE(TAG, "LEDC timer 0 and channels 0-3 are taken by another instance: one stepper per node");
        return std::unexpected(Err::failed);
    }
    s_taken = true;

    // 1. The bridge asleep before anything else (an input then cannot drive a coil), and the pin readable for selftest.
    gpio_config_t io = {};
    io.mode = GPIO_MODE_INPUT_OUTPUT;
    io.pull_up_en = GPIO_PULLUP_DISABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;
    if (cfg_.sleep >= 0) {
        gpio_set_level(static_cast<gpio_num_t>(cfg_.sleep), 0);
        io.pin_bit_mask = 1ULL << cfg_.sleep;
        if (gpio_config(&io) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        s_sleep = cfg_.sleep;
    }
    // 2. The four inputs low as GPIOs (coast) before LEDC takes them.
    io.pin_bit_mask = 0;
    for (int i = 0; i < kChannels; ++i) {
        gpio_set_level(static_cast<gpio_num_t>(pads[i]), 0);
        io.pin_bit_mask |= 1ULL << pads[i];
        s_pads[i] = static_cast<int8_t>(pads[i]);
    }
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    // 3. LEDC at duty 0, then the pads to LEDC (ledc_channel_config routes them through the GPIO matrix).
    ledc_timer_config_t t = {};
    t.speed_mode = kMode;
    t.duty_resolution = static_cast<ledc_timer_bit_t>(drv8833::kPwmBits);
    t.timer_num = kLedcTimer;
    t.freq_hz = cfg_.pwm_hz;
    t.clk_cfg = LEDC_AUTO_CLK;  // 80 MHz: a fractional divider of 1.5625 for 25 kHz x 2^11
    if (ledc_timer_config(&t) != ESP_OK) {
        ESP_LOGE(TAG, "LEDC timer: %u Hz at %u bits refused", unsigned{cfg_.pwm_hz}, unsigned{drv8833::kPwmBits});
        return std::unexpected(Err::failed);
    }
    for (int i = 0; i < kChannels; ++i) {
        ledc_channel_config_t c = {};
        c.gpio_num = pads[i];
        c.speed_mode = kMode;
        c.channel = static_cast<ledc_channel_t>(i);
        c.timer_sel = kLedcTimer;
        c.duty = 0;
        c.hpoint = 0;
        if (ledc_channel_config(&c) != ESP_OK) {
            ESP_LOGE(TAG, "GPIO%u: LEDC channel %d refused", unsigned{pads[i]}, i);
            return std::unexpected(Err::failed);
        }
        gpio_input_enable(static_cast<gpio_num_t>(pads[i]));  // selftest reads the pad back
    }
    // 4. nFAULT: open drain, an input with the internal pull-up unless the module pulls it up to 3.3 V itself.
    if (cfg_.fault >= 0) {
        gpio_config_t in = {};
        in.pin_bit_mask = 1ULL << cfg_.fault;
        in.mode = GPIO_MODE_INPUT;
        in.pull_up_en = cfg_.fault_pullup ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE;
        in.pull_down_en = GPIO_PULLDOWN_DISABLE;
        in.intr_type = GPIO_INTR_DISABLE;  // enabled below, once the handler is in place
        if (gpio_config(&in) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
    }
    // 5. The restart and panic hooks: none left means the motor never runs (a restart could leave a coil driven).
    if (!platform::register_safe_off(&pads_low, &pads_low)) {
        ESP_LOGE(TAG, "no restart hook slot left; the coils stay off");
        return std::unexpected(Err::failed);
    }
    // 6. The step timer at 1 MHz, running freely from here, with no alarm.
    gptimer_config_t tc = {};
    tc.clk_src = GPTIMER_CLK_SRC_DEFAULT;
    tc.direction = GPTIMER_COUNT_UP;
    tc.resolution_hz = kTimerHz;
    if (gptimer_new_timer(&tc, &timer_) != ESP_OK) {
        ESP_LOGE(TAG, "no general-purpose timer left");
        return std::unexpected(Err::failed);
    }
    gptimer_event_callbacks_t cbs = {};
    cbs.on_alarm = &Isr::alarm;
    if (gptimer_register_event_callbacks(timer_, &cbs, this) != ESP_OK || gptimer_set_alarm_action(timer_, nullptr) != ESP_OK ||
        gptimer_enable(timer_) != ESP_OK || gptimer_start(timer_) != ESP_OK) {
        ESP_LOGE(TAG, "gptimer: callback, enable or start refused");
        return std::unexpected(Err::failed);
    }
    // 7. The input slot (the cut's way to the core task: nFAULT, the wake check, inject_fault), then the nFAULT ISR.
    on_fault_ = on_fault;
    slot_ = core.input_slot([this](const InputSample &) { on_fault_(); });
    if (slot_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (cfg_.fault >= 0) {
        const auto pin = static_cast<gpio_num_t>(cfg_.fault);
        // ESP_INTR_FLAG_IRAM keeps the cut working while flash is busy; fr::platform::gpio_isr_service installs the
        // one service with its first caller's flags and says which.
        const auto flags = platform::gpio_isr_service(ESP_INTR_FLAG_IRAM);
        if (!flags) {
            return std::unexpected(Err::failed);
        }
        if ((*flags & ESP_INTR_FLAG_IRAM) == 0) {
            ESP_LOGW(TAG, "GPIO ISR service installed without ESP_INTR_FLAG_IRAM: an nFAULT edge waits while flash is "
                          "busy (the DRV8833 protects itself meanwhile)");
        }
        if (gpio_isr_handler_add(pin, &Isr::fault, this) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        if (gpio_set_intr_type(pin, GPIO_INTR_NEGEDGE) != ESP_OK || gpio_intr_enable(pin) != ESP_OK) {
            gpio_isr_handler_remove(pin);
            return std::unexpected(Err::failed);
        }
    }
    ready_ = true;
    ESP_LOGI(TAG, "IN GPIO%u/%u/%u/%u on LEDC channels 0-3 (timer 0, %u Hz, %u bits), nSLEEP %d, nFAULT %d",
             unsigned{cfg_.ain1}, unsigned{cfg_.ain2}, unsigned{cfg_.bin1}, unsigned{cfg_.bin2}, unsigned{cfg_.pwm_hz},
             unsigned{drv8833::kPwmBits}, int{cfg_.sleep}, int{cfg_.fault});
    return {};
}

Status Drv8833Stepper::shape(const hal::StepperShape &s)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (s.microsteps_log2 > max_microsteps_log2()) {
        return std::unexpected(Err::invalid_args);
    }
    Status st;
    portENTER_CRITICAL(&s_mux);
    if (engine_.snapshot().running) {
        st = std::unexpected(Err::busy);
    } else {
        const uint8_t before = engine_.phase();
        engine_.shape(s.microsteps_log2, s.invert);
        phase_offset_ = static_cast<uint8_t>(phase_offset_ + before - engine_.phase());
        run_permille_ = s.run_permille;
    }
    portEXIT_CRITICAL(&s_mux);
    return st;
}

Status Drv8833Stepper::energise(uint16_t permille)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    Status st;
    portENTER_CRITICAL(&s_mux);
    if (cut_ || fault_asserted()) {
        st = std::unexpected(Err::busy);
    } else {
        peak_ = drv8833::peak(permille);
        drive_locked();
        if (power_ == Power::off) {
            wake_locked();
        }
    }
    portEXIT_CRITICAL(&s_mux);
    return st;
}

void Drv8833Stepper::release()
{
    if (!ready_) {
        return;
    }
    portENTER_CRITICAL(&s_mux);
    engine_.release();
    disarm_locked();
    write_duties(drv8833::kCoast);
    if (cfg_.sleep >= 0) {
        gpio_ll_set_level(&GPIO, cfg_.sleep, 0);
    }
    power_ = Power::off;
    portEXIT_CRITICAL(&s_mux);
}

Status Drv8833Stepper::command(const motion::Request &r)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    Status st;
    portENTER_CRITICAL(&s_mux);
    if (cut_) {
        st = std::unexpected(Err::busy);
    } else {
        const motion::Start s = engine_.submit(r);
        if (s.arm || engine_.snapshot().running) {
            // A motion runs: at run power, the bridge woken first (its first step after t_WAKE, from the wake alarm).
            peak_ = drv8833::peak(run_permille_);
            drive_locked();
            if (power_ == Power::off) {
                wake_locked();
            }
            if (s.arm && power_ == Power::on) {
                const uint64_t now = now_locked();
                arm_locked(now + s.delay_us, now, Alarm::step);
            }
        } else if (alarm_ == Alarm::step) {
            disarm_locked();  // halted: no step is due any more (a wake alarm stays, and finds nothing to start)
        }
    }
    portEXIT_CRITICAL(&s_mux);
    return st;
}

motion::Snapshot Drv8833Stepper::snapshot() const
{
    portENTER_CRITICAL(&s_mux);
    const motion::Snapshot s = engine_.snapshot();
    portEXIT_CRITICAL(&s_mux);
    return s;
}

Status Drv8833Stepper::set_position(int32_t position)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    portENTER_CRITICAL(&s_mux);
    const uint8_t before = engine_.phase();
    const Status st = engine_.set_position(position);
    if (st) {
        phase_offset_ = static_cast<uint8_t>(phase_offset_ + before - engine_.phase());
    }
    portEXIT_CRITICAL(&s_mux);
    return st;
}

bool Drv8833Stepper::fault_asserted() const
{
    return cfg_.fault >= 0 && reads_low(cfg_.fault);
}

Status Drv8833Stepper::clear_fault()
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    Status st;
    portENTER_CRITICAL(&s_mux);
    if (fault_asserted()) {
        st = std::unexpected(Err::busy);
    } else {
        if (cut_) {
            // The pads back to LEDC, whose duties the cut set to 0 (coast); the bridge stays asleep.
            for (int i = 0; i < kChannels; ++i) {
                const auto pin = static_cast<uint32_t>(s_pads[i]);
                gpio_ll_set_output_signal_matrix_source(&GPIO, pin, ledc_periph_signal[0].speed_mode[kMode].sig_out_idx[i], false);
                gpio_ll_set_output_enable_ctrl(&GPIO, static_cast<uint8_t>(pin), true, false);
            }
            cut_ = false;
        }
        engine_.clear_fault();
    }
    portEXIT_CRITICAL(&s_mux);
    return st;
}

void Drv8833Stepper::inject_fault()
{
    if (!ready_) {
        return;
    }
    // The cut path whatever the bridge's state (the ISR's ignores a sleeping bridge; an injected fault is the test).
    portENTER_CRITICAL(&s_mux);
    cut_locked();
    portEXIT_CRITICAL(&s_mux);
    notify_fault();
}

hal::Selftest Drv8833Stepper::selftest()
{
    if (!ready_) {
        return {false, "not initialized"};
    }
    portENTER_CRITICAL(&s_mux);
    const Power power = power_;
    const bool cut = cut_;
    portEXIT_CRITICAL(&s_mux);
    const char *latched = cut ? ", fault latched" : "";
    // Never energises a coil: only an asleep bridge is checked.
    if (power != Power::off) {
        std::snprintf(detail_, sizeof(detail_), "energised, not checked; LEDC timer 0 channels 0-3 at %u Hz, gptimer allocated",
                      unsigned{cfg_.pwm_hz});
        return {true, detail_};
    }
    bool pads_low_ok = true;
    for (const int8_t pin : s_pads) {
        pads_low_ok = pads_low_ok && reads_low(pin);
    }
    const bool sleep_ok = cfg_.sleep < 0 || reads_low(cfg_.sleep);
    const bool fault_ok = cfg_.fault < 0 || !reads_low(cfg_.fault);
    const char *state = !fault_ok      ? "nFAULT low while asleep: a missing pull-up or a wiring fault"
                        : !sleep_ok    ? "nSLEEP reads high while asleep (a pull-up on EEP?)"
                        : !pads_low_ok ? "an IN pad reads high while asleep"
                        : cfg_.sleep < 0 ? "released: IN pads low (no nSLEEP pin: the bridge stays awake)"
                                         : "asleep: IN pads low, nSLEEP low";
    std::snprintf(detail_, sizeof(detail_), "%s%s; LEDC timer 0 channels 0-3 at %u Hz, gptimer allocated", state,
                  latched, unsigned{cfg_.pwm_hz});
    return {fault_ok && sleep_ok && pads_low_ok, detail_};
}

}  // namespace fr::drv

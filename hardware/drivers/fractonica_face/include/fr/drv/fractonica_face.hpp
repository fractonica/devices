// fractonica_face (design face-f1 D5): hal::Face over the clock library (clock/components/fractonica_ui), which reads
// every Fractonica number and word from the core. One fui_ui_t (1.5 KB, static in the generated glue as this driver),
// no heap. The face is the library's FUI_FACE_MONO400X300 (black ink on white paper, theme fui_theme_paper), drawn
// into the panel's frame as FUI_FMT_MONO_ROW (MSB the leftmost pixel, a set bit white).
#pragma once

#include <cstdint>
#include <optional>
#include <span>

#include "fr/hal/face.hpp"

namespace fr::drv {

class FractonicaFace final : public hal::Face
{
public:
    struct Config {};

    explicit FractonicaFace(const Config &cfg);

    Status init(uint16_t width, uint16_t height, uint8_t mode, uint8_t focus, uint8_t step_level,
                int16_t utc_offset_min) override;
    hal::FaceFrame update(std::optional<int64_t> unix_us, uint32_t now_ms) override;
    void draw(std::span<uint8_t> frame, uint16_t width, uint16_t height, int x0, int y0, int x1, int y1) override;
    bool input(Input in, uint32_t now_ms) override;
    void invalidate() override;
    uint8_t rollover(int64_t from_us, int64_t to_us, uint8_t step_level) override;

    void set_mode(uint8_t mode) override;
    void set_focus(uint8_t focus) override;
    void set_screen(uint8_t screen) override;
    void set_step(uint8_t level) override;
    void set_utc_offset_min(int16_t minutes) override;

    uint8_t mode() const override;
    uint8_t focus() const override;
    uint8_t screen() const override;

private:
    bool ready_ = false;
};

}  // namespace fr::drv

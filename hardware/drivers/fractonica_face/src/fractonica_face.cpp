// fractonica_face (fr/drv/fractonica_face.hpp, design face-f1 D5).
#include "fr/drv/fractonica_face.hpp"

#include "esp_log.h"
#include "fui_canvas.h"
#include "fui_ui.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "face";
// The library's state: one face per node (the library keeps no heap; this is its caller-owned fui_ui_t).
fui_ui_t s_ui;

}  // namespace

FractonicaFace::FractonicaFace(const Config &cfg)
{
    static_cast<void>(cfg);
}

Status FractonicaFace::init(uint16_t width, uint16_t height, uint8_t mode, uint8_t focus, uint8_t step_level,
                            int16_t utc_offset_min)
{
    const fui_face_info_t *info = fui_face_info(FUI_FACE_MONO400X300);
    if (info == nullptr || info->width != width || info->height != height || !info->mono) {
        ESP_LOGE(TAG, "no face for a %ux%u panel", width, height);
        return std::unexpected(Err::unsupported);
    }
    fui_config_t cfg{};
    cfg.face = FUI_FACE_MONO400X300;
    cfg.catalogue = nullptr;  // FRC_SAROS_141
    cfg.theme = nullptr;      // fui_theme_paper
    cfg.utc_offset_s = static_cast<int32_t>(utc_offset_min) * 60;
    cfg.min_frame_us = 0;
    cfg.mode = mode == 1 ? FUI_MODE_EARTH : FUI_MODE_PURE;
    cfg.focus = focus;
    cfg.step = step_level;
    fui_ui_init(&s_ui, &cfg);
    ready_ = true;
    ESP_LOGI(TAG, "%s %ux%u, %s, focus %u, step %u", fui_face_name(FUI_FACE_MONO400X300), width, height,
             fui_mode_name(static_cast<fui_mode_t>(cfg.mode)), focus, step_level);
    return {};
}

hal::FaceFrame FractonicaFace::update(std::optional<int64_t> unix_us, uint32_t now_ms)
{
    hal::FaceFrame out;
    if (!ready_) {
        return out;
    }
    const fui_frame_t *f = fui_ui_update(&s_ui, unix_us ? static_cast<frc_time_t>(*unix_us) : FRC_TIME_NONE, now_ms);
    out.redraw = f->redraw != 0;
    // The library's rectangles are half-open; hal::FaceFrame's are inclusive.
    out.x0 = f->dirty.x0;
    out.y0 = f->dirty.y0;
    out.x1 = f->dirty.x1 - 1;
    out.y1 = f->dirty.y1 - 1;
    out.sleep_us = f->sleep_us;
    return out;
}

void FractonicaFace::draw(std::span<uint8_t> frame, uint16_t width, uint16_t height, int x0, int y0, int x1, int y1)
{
    if (!ready_ || frame.size() < fui_canvas_bytes(FUI_FMT_MONO_ROW, width, height)) {
        return;
    }
    fui_canvas_t c;
    fui_canvas_init(&c, frame.data(), FUI_FMT_MONO_ROW, width, height);
    const fui_rect_t clip{static_cast<int16_t>(x0), static_cast<int16_t>(y0), static_cast<int16_t>(x1 + 1),
                          static_cast<int16_t>(y1 + 1)};
    fui_canvas_set_clip(&c, &clip);
    fui_ui_draw(&s_ui, &c);  // clears the frame's dirty rectangle to the ground (white), then draws it
}

bool FractonicaFace::input(Input in, uint32_t now_ms)
{
    return ready_ && fui_ui_event(&s_ui, static_cast<fui_event_t>(static_cast<uint8_t>(in)), now_ms) != 0;
}

void FractonicaFace::invalidate()
{
    fui_ui_invalidate(&s_ui);
}

uint8_t FractonicaFace::rollover(int64_t from_us, int64_t to_us, uint8_t step_level)
{
    // D19: the cycles' global indices from the core, on the face's catalogue. The step's cycle must be the very next
    // one (a time that jumped, or went back, chimes nothing); then the coarsest level whose cycle is another one.
    if (!ready_ || to_us <= from_us || step_level > FRC_CLOCK_MAX_LEVEL) {
        return kNoLevel;
    }
    frc_cycle_t a;
    frc_cycle_t b;
    if (frc_cycle_at(s_ui.cat, from_us, step_level, &a) != FRC_OK || frc_cycle_at(s_ui.cat, to_us, step_level, &b) != FRC_OK ||
        b.cycle != a.cycle + 1) {
        return kNoLevel;
    }
    for (uint8_t level = 0; level < step_level; ++level) {
        if (frc_cycle_at(s_ui.cat, from_us, level, &a) == FRC_OK && frc_cycle_at(s_ui.cat, to_us, level, &b) == FRC_OK &&
            a.cycle != b.cycle) {
            return level;
        }
    }
    return step_level;
}

void FractonicaFace::set_mode(uint8_t mode)
{
    fui_ui_set_mode(&s_ui, mode == 1 ? FUI_MODE_EARTH : FUI_MODE_PURE);
}

void FractonicaFace::set_focus(uint8_t focus)
{
    fui_ui_set_focus(&s_ui, focus);
}

void FractonicaFace::set_screen(uint8_t screen)
{
    fui_ui_set_screen(&s_ui, static_cast<fui_screen_t>(screen));
}

void FractonicaFace::set_step(uint8_t level)
{
    (void)fui_ui_set_step(&s_ui, level);
}

void FractonicaFace::set_utc_offset_min(int16_t minutes)
{
    fui_ui_set_utc_offset(&s_ui, static_cast<int32_t>(minutes) * 60);
}

uint8_t FractonicaFace::mode() const
{
    return s_ui.mode;
}

uint8_t FractonicaFace::focus() const
{
    return s_ui.focus;
}

uint8_t FractonicaFace::screen() const
{
    return s_ui.screen;
}

}  // namespace fr::drv

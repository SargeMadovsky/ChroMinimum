//! Event-driven native button images using the current CEF theme palette.
use cef::*;

#[derive(Clone, Copy)]
pub enum Icon {
    Back,
    Forward,
    Reload,
    Stop,
    Download,
    DownloadHidden,
    Menu,
}

fn mask(icon: Icon) -> &'static [u8; 576] {
    match icon {
        Icon::Back => include_bytes!("../assets/icons/back.alpha"),
        Icon::Forward => include_bytes!("../assets/icons/forward.alpha"),
        Icon::Reload => include_bytes!("../assets/icons/reload.alpha"),
        Icon::Stop => include_bytes!("../assets/icons/stop.alpha"),
        Icon::Download => include_bytes!("../assets/icons/download.alpha"),
        Icon::DownloadHidden => &[0; 576],
        Icon::Menu => include_bytes!("../assets/icons/menu.alpha"),
    }
}

pub fn configure(button: &LabelButton, icon: Icon) {
    button.set_focusable(1);
    button.set_ink_drop_enabled(1);
    apply(button, icon, false);
}

pub fn apply_view(view: Option<&mut View>, icon: Icon, focused: bool) {
    if let Some(button) = view
        .and_then(|v| v.as_button())
        .and_then(|b| b.as_label_button())
    {
        apply(&button, icon, focused);
    }
}

pub fn apply(button: &LabelButton, icon: Icon, focused: bool) {
    use sys::cef_color_id_t::*;
    let foreground = button.theme_color(CEF_ColorPrimaryForeground as i32);
    let disabled = button.theme_color(CEF_ColorDisabledForeground as i32);
    let accent =
        button.theme_color(CEF_ColorAccentWithGuaranteedContrastAtopPrimaryBackground as i32);
    for (state, color) in [
        (
            ButtonState::NORMAL,
            if focused { accent } else { foreground },
        ),
        (ButtonState::HOVERED, accent),
        (ButtonState::PRESSED, accent),
        (ButtonState::DISABLED, disabled),
    ] {
        // CEF owns the hover/press background and keyboard focus border.
        // The bitmap contains only the glyph, avoiding nested square outlines.
        let mut pixels = Vec::with_capacity(24 * 24 * 4);
        for alpha in mask(icon).iter().copied() {
            pixels.extend_from_slice(&[
                (color >> 16) as u8,
                (color >> 8) as u8,
                color as u8,
                (u32::from(alpha) * (color >> 24) / 255) as u8,
            ]);
        }
        if let Some(mut image) = image_create()
            && image.add_bitmap(
                1.0,
                24,
                24,
                ColorType::RGBA_8888,
                AlphaType::POSTMULTIPLIED,
                Some(&pixels),
            ) != 0
        {
            button.set_image(state, Some(&mut image));
        }
    }
}

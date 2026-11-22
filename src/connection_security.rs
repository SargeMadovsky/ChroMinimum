//! CEF owns certificate verification. This module only presents its result.
use cef::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum State {
    #[default]
    Unknown,
    Secure,
    Http,
    Local,
    Warning,
    CertificateError,
    LoadError,
}

impl State {
    pub fn text(self) -> &'static str {
        match self {
            Self::Unknown => "Состояние соединения ещё не подтверждено",
            Self::Secure => {
                "Защищённое соединение: сертификат проверен Chromium. Это не гарантия безопасности сайта"
            }
            Self::Http => "Незащищённое соединение HTTP",
            Self::Local => "Локальная или внутренняя страница: сертификат сайта не применяется",
            Self::Warning => {
                "Предупреждение: небезопасное содержимое или непроверенное TLS-соединение"
            }
            Self::CertificateError => "Ошибка сертификата: защищённое соединение не подтверждено",
            Self::LoadError => "Ошибка загрузки: состояние соединения не подтверждено",
        }
    }
}

pub fn read(browser: Option<&Browser>) -> State {
    let Some(entry) = browser
        .and_then(|b| b.host())
        .and_then(|h| h.visible_navigation_entry())
    else {
        return State::Unknown;
    };
    let url = CefString::from(&entry.url()).to_string();
    let scheme = url.split(':').next().unwrap_or_default();
    if scheme.eq_ignore_ascii_case("http") {
        return State::Http;
    }
    if !scheme.eq_ignore_ascii_case("https") {
        return State::Local;
    }
    let Some(ssl) = entry.sslstatus() else {
        return State::Unknown;
    };
    classify(
        ssl.is_secure_connection() != 0,
        is_cert_status_error(ssl.cert_status()) != 0,
        ssl.x509_certificate().is_some(),
        ssl.content_status() != SslContentStatus::NORMAL_CONTENT,
    )
}

fn classify(secure: bool, cert_error: bool, certificate: bool, mixed: bool) -> State {
    if cert_error {
        State::CertificateError
    } else if !secure || !certificate || mixed {
        State::Warning
    } else {
        State::Secure
    }
}

// Shape and color both carry state; theme events repaint the small native image.
pub fn paint(button: &LabelButton, state: State) {
    use sys::cef_color_id_t::*;
    let color = match state {
        State::Secure => 0xff16813d,
        State::CertificateError | State::LoadError => 0xffd32f2f,
        State::Warning | State::Http => 0xffb26a00,
        _ => button.theme_color(CEF_ColorPrimaryForeground as i32),
    };
    let mut pixels = Vec::with_capacity(24 * 24 * 4);
    for y in 0_i32..24 {
        for x in 0_i32..24 {
            let ink = if state == State::Secure {
                ((6..18).contains(&x) && (10..21).contains(&y))
                    || ((x == 7 || x == 16) && (5..11).contains(&y))
                    || ((8..16).contains(&x) && (y == 3 || y == 4))
            } else {
                let ring = (x - 12).pow(2) + (y - 12).pow(2);
                (70..100).contains(&ring)
                    || ((11..14).contains(&x) && ((6..14).contains(&y) || y == 17))
            };
            pixels.extend_from_slice(&[
                (color >> 16) as u8,
                (color >> 8) as u8,
                color as u8,
                if ink { 255 } else { 0 },
            ]);
        }
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
        button.set_image(ButtonState::NORMAL, Some(&mut image));
    }
    let text = CefString::from(state.text());
    button.set_tooltip_text(Some(&text));
    button.set_accessible_name(Some(&text));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_green_without_verified_certificate_and_clean_content() {
        for secure in [false, true] {
            for error in [false, true] {
                for certificate in [false, true] {
                    for mixed in [false, true] {
                        assert_eq!(
                            classify(secure, error, certificate, mixed) == State::Secure,
                            secure && !error && certificate && !mixed
                        );
                    }
                }
            }
        }
    }
}

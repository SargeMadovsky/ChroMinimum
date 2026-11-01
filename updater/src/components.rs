//! Local installation intent. This does not authenticate or install update packages.
use crate::Result;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs::File, io::Read, path::Path};

const MAX_CONFIG: u64 = 4096;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum Locale {
    #[serde(rename = "en-US")]
    EnUs,
    #[serde(rename = "ru")]
    Ru,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InstallConfig {
    pub format: u32,
    pub ui_locale: Locale,
    pub locales: Vec<Locale>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Component {
    Core {},
    Locale { locale: Locale },
}

#[derive(Debug, Serialize)]
pub struct InstallPlan {
    pub format: u32,
    pub platform: &'static str,
    pub ui_locale: Locale,
    pub components: Vec<Component>,
}

impl InstallConfig {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() as u64 > MAX_CONFIG {
            return Err("Installation config too large".into());
        }
        let config: Self = serde_json::from_slice(bytes)?;
        config.plan()?;
        Ok(config)
    }

    pub fn read(path: &Path) -> Result<Self> {
        let mut bytes = Vec::new();
        File::open(path)?
            .take(MAX_CONFIG + 1)
            .read_to_end(&mut bytes)?;
        Self::parse(&bytes)
    }

    pub fn plan(&self) -> Result<InstallPlan> {
        if self.format != 1 {
            return Err("Unsupported installation config format".into());
        }
        let mut locales: BTreeSet<_> = self.locales.iter().copied().collect();
        if locales.len() != self.locales.len() {
            return Err("Duplicate installation locale".into());
        }
        if !locales.contains(&self.ui_locale) {
            return Err("UI locale must be selected for installation".into());
        }
        locales.insert(Locale::EnUs);
        let mut components = vec![Component::Core {}];
        components.extend(
            locales
                .into_iter()
                .map(|locale| Component::Locale { locale }),
        );
        Ok(InstallPlan {
            format: 1,
            platform: "windows-x64",
            ui_locale: self.ui_locale,
            components,
        })
    }
}

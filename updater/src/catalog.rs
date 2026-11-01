//! Authenticated component catalog and offline selection. No download or installation.
use crate::{
    Envelope, Result,
    components::{Component, InstallConfig, Locale},
    unhex,
};
use ring::signature;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs::File, io::Read, path::Path};

pub const MAX_CATALOG: u64 = 64 * 1024;
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Package {
    pub component: Component,
    pub sequence: u64,
    pub engine_version: String,
    pub adapter_sha256: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    pub format: u32,
    pub purpose: String,
    pub launcher_api: u32,
    pub sequence: u64,
    pub min_safe_sequence: u64,
    pub platform: String,
    pub engine_version: String,
    pub adapter_sha256: String,
    pub issued: u64,
    pub expires: u64,
    pub packages: Vec<Package>,
}

/// Only signature verification can construct this type.
pub struct VerifiedCatalog(Catalog);

#[derive(Debug, Serialize)]
pub struct PackagePlan {
    pub sequence: u64,
    pub min_safe_sequence: u64,
    pub engine_version: String,
    pub adapter_sha256: String,
    pub ui_locale: Locale,
    pub total_download_bytes: u64,
    pub packages: Vec<Package>,
}

fn permitted_source(url: &str) -> bool {
    let Some(path) =
        url.strip_prefix("https://github.com/SargeMadovsky/ChroMinimum/releases/download/")
    else {
        return false;
    };
    let parts: Vec<_> = path.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}

pub fn read_verified(
    path: &Path,
    key: &[u8; 32],
    timestamp: u64,
    highest: u64,
    min_safe: u64,
) -> Result<VerifiedCatalog> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_CATALOG + 1)
        .read_to_end(&mut bytes)?;
    verify(&bytes, key, timestamp, highest, min_safe)
}

pub fn verify(
    bytes: &[u8],
    key: &[u8; 32],
    timestamp: u64,
    highest: u64,
    min_safe: u64,
) -> Result<VerifiedCatalog> {
    if bytes.len() as u64 > MAX_CATALOG {
        return Err("Catalog too large".into());
    }
    let envelope: Envelope = serde_json::from_slice(bytes)?;
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(
            envelope.payload.as_bytes(),
            &unhex::<64>(&envelope.signature)?,
        )
        .map_err(|_| "Catalog signature invalid")?;
    let catalog: Catalog = serde_json::from_str(&envelope.payload)?;
    if catalog.format != 2
        || catalog.purpose != "chrominimum-components"
        || catalog.launcher_api != 2
        || catalog.platform != "windows-x64"
    {
        return Err("Incompatible component catalog".into());
    }
    if min_safe > highest
        || catalog.sequence == 0
        || catalog.sequence < highest
        || catalog.sequence < min_safe
        || catalog.min_safe_sequence < min_safe
        || catalog.min_safe_sequence > catalog.sequence
    {
        return Err("Catalog rollback rejected".into());
    }
    if catalog.issued > timestamp.saturating_add(300)
        || catalog.expires <= timestamp
        || catalog.expires <= catalog.issued
        || catalog.expires - catalog.issued > 45 * 86400
    {
        return Err("Catalog expired or system clock incorrect".into());
    }
    unhex::<32>(&catalog.adapter_sha256)?;
    if catalog.engine_version.is_empty()
        || catalog.engine_version.len() > 160
        || !catalog.engine_version.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err("Invalid engine identity".into());
    }
    if catalog.packages.is_empty() || catalog.packages.len() > 3 {
        return Err("Invalid package count".into());
    }
    let mut ids = BTreeSet::new();
    let mut urls = BTreeSet::new();
    for package in &catalog.packages {
        if !ids.insert(package.component.clone()) || !urls.insert(&package.url) {
            return Err("Duplicate component or package source".into());
        }
        if package.sequence != catalog.sequence
            || package.engine_version != catalog.engine_version
            || package.adapter_sha256 != catalog.adapter_sha256
        {
            return Err("Package belongs to a different core release".into());
        }
        if package.size == 0 || package.size > MAX_DOWNLOAD || !permitted_source(&package.url) {
            return Err("Invalid package size or source".into());
        }
        unhex::<32>(&package.sha256)?;
    }
    if !ids.contains(&Component::Core {}) {
        return Err("Catalog is missing mandatory core".into());
    }
    Ok(VerifiedCatalog(catalog))
}

impl VerifiedCatalog {
    pub fn plan(&self, config: &InstallConfig) -> Result<PackagePlan> {
        let selection = config.plan()?;
        let mut packages = Vec::new();
        let mut total = 0_u64;
        for component in selection.components {
            let package = self
                .0
                .packages
                .iter()
                .find(|p| p.component == component)
                .ok_or("Selected component unavailable in this release")?;
            total = total
                .checked_add(package.size)
                .ok_or("Download size overflow")?;
            if total > MAX_DOWNLOAD {
                return Err("Combined download too large".into());
            }
            packages.push(package.clone());
        }
        Ok(PackagePlan {
            sequence: self.0.sequence,
            min_safe_sequence: self.0.min_safe_sequence,
            engine_version: self.0.engine_version.clone(),
            adapter_sha256: self.0.adapter_sha256.clone(),
            ui_locale: selection.ui_locale,
            total_download_bytes: total,
            packages,
        })
    }
}

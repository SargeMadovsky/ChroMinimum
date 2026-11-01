//! Offline assembly into a new, caller-owned directory; never changes active state.
use crate::{
    Result,
    catalog::VerifiedCatalog,
    components::{Component, InstallConfig, Locale},
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const CORE: &[&str] = &[
    "chrominimum.exe",
    "chrominimum.dll",
    "chrominimum.exe.manifest",
    "libcef.dll",
    "chrome_elf.dll",
    "icudtl.dat",
    "v8_context_snapshot.bin",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "resources.pak",
    "d3dcompiler_47.dll",
    "dxcompiler.dll",
    "dxil.dll",
    "vk_swiftshader.dll",
    "vk_swiftshader_icd.json",
    "vulkan-1.dll",
    "CREDITS.html",
    "LICENSES-RUST.html",
    "LICENSE",
    "THIRD_PARTY.md",
    "third_party/cef/LICENSE",
    "third_party/cef-rs/LICENSE-APACHE",
    "third_party/cef-rs/LICENSE-MIT",
];

fn expected(component: &Component) -> BTreeSet<String> {
    match component {
        Component::Core {} => CORE.iter().map(|s| (*s).to_owned()).collect(),
        Component::Locale { locale } => {
            let locale = match locale {
                Locale::EnUs => "en-US",
                Locale::Ru => "ru",
            };
            ["", "_FEMININE", "_MASCULINE", "_NEUTER"]
                .iter()
                .map(|suffix| format!("locales/{locale}{suffix}.pak"))
                .collect()
        }
    }
}

pub(crate) fn plain_path(path: &Path) -> Result<()> {
    for part in path.ancestors() {
        let metadata = fs::symlink_metadata(part)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Reparse path rejected".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("Symlink path rejected".into());
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct AssemblyReport {
    pub sequence: u64,
    pub ui_locale: Locale,
    pub packages: usize,
    pub files: u32,
    pub expanded_bytes: u64,
}

impl VerifiedCatalog {
    /// Caller must own the output parent and prevent concurrent filesystem mutation.
    pub fn stage_local(
        &self,
        config: &InstallConfig,
        archives: &Path,
        destination: &Path,
    ) -> Result<AssemblyReport> {
        let plan = self.plan(config)?;
        let archives = std::path::absolute(archives)?;
        let destination = std::path::absolute(destination)?;
        plain_path(&archives)?;
        plain_path(destination.parent().ok_or("Output parent required")?)?;
        let mut inputs = Vec::new();
        for package in &plan.packages {
            let name = package
                .url
                .rsplit('/')
                .next()
                .ok_or("Package filename missing")?;
            let path = archives.join(name);
            plain_path(&path)?;
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                // Keep the verified handle open and deny concurrent write/delete access.
                options.share_mode(1);
            }
            let mut file = options.open(path)?;
            if !file.metadata()?.is_file() {
                return Err("Package is not a regular file".into());
            }
            let (size, hash) = crate::hash_reader((&mut file).take(package.size + 1))?;
            if size != package.size || hash != package.sha256 {
                return Err("Local package size or hash mismatch".into());
            }
            file.seek(SeekFrom::Start(0))?;
            inputs.push(file);
        }
        // Never reuse an existing directory, even if it looks empty.
        fs::create_dir(&destination)?;
        let mut report = AssemblyReport {
            sequence: plan.sequence,
            ui_locale: plan.ui_locale,
            packages: plan.packages.len(),
            files: 0,
            expanded_bytes: 0,
        };
        let mut all_names = BTreeSet::new();
        for (package, file) in plan.packages.iter().zip(inputs) {
            let required = expected(&package.component);
            let mut seen = BTreeSet::new();
            let mut tar = tar::Archive::new(flate2::read::MultiGzDecoder::new(file));
            for entry in tar.entries()? {
                let mut entry = entry?;
                let name = std::str::from_utf8(entry.path_bytes().as_ref())?.to_owned();
                if !entry.header().entry_type().is_file()
                    || !required.contains(&name)
                    || !seen.insert(name.clone())
                    || !all_names.insert(name.clone())
                {
                    return Err("Unexpected, duplicate or overlapping component file".into());
                }
                crate::safe_path(Path::new(&name))?;
                report.files = report.files.checked_add(1).ok_or("File count overflow")?;
                report.expanded_bytes = report
                    .expanded_bytes
                    .checked_add(entry.size())
                    .ok_or("Size overflow")?;
                if report.files > 4096 || report.expanded_bytes > 2 * 1024 * 1024 * 1024 {
                    return Err("Combined extraction limit exceeded".into());
                }
                let target = destination.join(&name);
                let parent = target.parent().ok_or("No parent")?;
                fs::create_dir_all(parent)?;
                plain_path(parent)?;
                let mut out = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)?;
                let copied = std::io::copy(&mut entry, &mut out)?;
                if copied != entry.size() {
                    return Err("Truncated component file".into());
                }
                out.sync_all()?;
            }
            if seen != required {
                return Err("Component is incomplete".into());
            }
            // Finish gzip to check CRC; reject hidden data beyond tar's end marker.
            let mut decoded = tar.into_inner();
            let mut buffer = [0_u8; 64 * 1024];
            let mut tail = 0_u64;
            loop {
                let count = decoded.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                tail += count as u64;
                if buffer[..count].iter().any(|b| *b != 0) || tail > 1024 * 1024 {
                    return Err("Unexpected data after tar end".into());
                }
            }
        }
        let (_, adapter) = crate::hash_file(&destination.join("chrominimum.dll"))?;
        if adapter != plan.adapter_sha256 {
            return Err("Assembled adapter identity mismatch".into());
        }
        Ok(report)
    }
}

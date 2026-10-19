// Loader sequence follows CEF's cefclient_win.cc at 14c5a08.
// Upstream BSD license: third_party/cef/LICENSE.
#include "include/base/cef_logging.h"
#include "include/wrapper/cef_certificate_util_win.h"
#include "include/wrapper/cef_library_loader.h"
#include "include/wrapper/cef_util_win.h"

extern "C" int cm_load_engine(cef_version_info_t* info, bool managed) {
  cef::logging::ScopedEarlySupport logging({});
  // Keep libcef loaded through bootstrap/sandbox shutdown, including onexit.
  static auto* loader = new CefScopedLibraryLoader();
  if (loader->LoadInSubProcessAssert(info)) {
    return 1;
  }
  if (managed) {
    // No adjacent unsigned fallback or unchecked path in managed builds.
    if (!info || info->size < CEF_VERSION_INFO_SIZE_WITH_INSTALLER_ERROR ||
        info->installer_error_code || !info->libcef_path ||
        info->libcef_is_bundled) {
      return 0;
    }
    cef_certificate_util::ThumbprintsInfo signer;
    cef_certificate_util::ValidateCodeSigningAssert(
        cef_util::GetExePath(), nullptr, false, &signer);
    if (!signer.IsSignedAndValid() || signer.valid_thumbprints.empty()) {
      return 0;
    }
    HMODULE client = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                               GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           reinterpret_cast<LPCWSTR>(&cm_load_engine), &client)) {
      return 0;
    }
    cef_certificate_util::ValidateCodeSigningAssert(
        cef_util::GetModulePath(client), signer.valid_thumbprints[0].c_str(), false);
    return loader->LoadInMainAssert(
        info->libcef_path, "3906F72B1D5FA45A6334A8590495FAEB93347E5B", false, info);
  }
  // Existing portable distribution: only its adjacent, version-checked engine.
  const auto exe = cef_util::GetExePath();
  const auto path = exe.substr(0, exe.find_last_of(L"/\\") + 1) + L"libcef.dll";
  return loader->LoadInMainAssert(path.c_str(), nullptr, true, info);
}

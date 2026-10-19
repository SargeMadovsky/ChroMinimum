#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CHROMINIMUM_DATA_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/chrominimum-smoke-$$"
url="file://$PWD/tests/fixtures/smoke.html"
if [[ "$(uname -s)" == Darwin ]]; then
  target/release-bundle/chrominimum.app/Contents/MacOS/chrominimum --smoke-test "--url=$url"
else
  target/release-bundle/run.sh --smoke-test "--url=$url"
fi
python3 - "$CHROMINIMUM_DATA_DIR/smoke.log" <<'PY'
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
print(text)
for expected in ('toolbar_created', 'main_frame_loaded; status=200', 'fixture_javascript_ok',
                 'navigation_controls_drawn', 'address_enter_navigated', 'back_button_navigated',
                 'forward_button_navigated', 'reload_button_navigated', 'browser_closed', 'shutdown_complete'):
    if expected not in text:
        raise SystemExit(f'Missing smoke evidence: {expected}')
if 'main_frame_error;' in text:
    raise SystemExit('Page load error')
PY

'use strict';

// Same-origin POST calls; the browser process checks the caller (D046).
async function call(path) {
  const response = await fetch(path, { method: 'POST', cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const $ = (id) => document.getElementById(id);
const prewarm = $('prewarm');
const updates = $('updates-check');

function say(text) {
  $('status').textContent = text;
}

function render(state) {
  prewarm.checked = state.prewarmOn;
  prewarm.disabled = !state.prewarmAvailable;
  $('prewarm-unavailable').hidden = state.prewarmAvailable;
  $('updates-label').textContent = state.updatesLabel;
  $('updates-hint').textContent = state.updatesHint;
  updates.disabled = !state.updatesEnabled;
  $('version').textContent = state.version;
  $('engine').textContent = state.engine;
}

async function refresh() {
  try {
    render(await call('api/state'));
  } catch {
    say('Не удалось прочитать настройки.');
  }
}

prewarm.addEventListener('change', async () => {
  const wanted = prewarm.checked;
  prewarm.disabled = true;
  try {
    const state = await call(`api/prewarm?on=${wanted ? 1 : 0}`);
    render(state);
    say(state.prewarmOn === wanted
      ? (wanted ? 'Ускорение первого запуска включено.' : 'Ускорение первого запуска выключено.')
      : 'Не удалось сохранить настройку.');
  } catch {
    say('Не удалось сохранить настройку.');
    refresh();
  }
});

updates.addEventListener('click', async () => {
  updates.disabled = true;
  try {
    render(await call('api/updates/check'));
  } catch {
    say('Не удалось начать проверку.');
    refresh();
  }
});

for (const button of document.querySelectorAll('[data-target]')) {
  button.addEventListener('click', () => {
    call(`api/open?target=${encodeURIComponent(button.dataset.target)}`)
      .catch(() => say('Не удалось открыть страницу движка.'));
  });
}

// The browser process signals shell state changes (core update progress).
document.addEventListener('chrominimum-state', refresh);
// Back from an engine page may restore this page from the back/forward cache.
window.addEventListener('pageshow', (event) => { if (event.persisted) refresh(); });

refresh();

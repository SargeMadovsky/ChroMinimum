"""Publish the audited 2026-10-24 measurements; no new browser runs."""
import json
import os
from pathlib import Path
import sys
import csv
import statistics
import argparse

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'.local/plot-python'), str(ROOT/'.local/benchmark-python')]
os.environ['MPLCONFIGDIR'] = str(ROOT/'.local/matplotlib-cache')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

SOURCE = ROOT/'docs/reports/resource-comparison-20261024'
OUT = ROOT/'assets/benchmarks/2026-10-24'
NAMES = ['CM', 'UC', 'Chrome']
LABELS = ['ChroMinimum', 'ungoogled-chromium', 'Google Chrome']
LANGUAGE = 'ru'
ENGLISH = {
    'Запуск до готовности страницы':'Startup to page readiness',
    'Память в простое':'Idle memory',
    'Память в игре':'Game memory',
    'Память при видео':'Video memory',
    'CPU в игре':'Game CPU',
    'CPU при видео':'Video CPU',
    'мс · 10 повторов':'ms · 10 runs',
    'private bytes, МиБ · 5 повторов':'private bytes, MiB · 5 runs',
    '% одного логического ядра · 5 повторов':'% of one logical core · 5 runs',
    '  ·  меньше — лучше':'  ·  lower is better',
    'ChroMinimum в сравнении':'ChroMinimum compared',
    'Запуск, память и CPU · 24 октября 2026':'Startup, memory and CPU · October 24, 2026',
    '75 из 75 попыток приняты · отдельная Windows-учётка · локальные сценарии':'75 of 75 runs accepted · separate Windows test account · local workloads',
    'Столбец — медиана · точки — повторы · линия — минимум и максимум':'Bars: medians · dots: individual runs · lines: minimum to maximum',
    'Плавность сохранена у всех трёх браузеров':'All three browsers maintained smooth playback and rendering',
    'Видео: 0 зарегистрированных пропусков кадров. Игра: p99 интервала рендера ≈6,2 мс.':'Video: 0 reported dropped frames. Game: p99 render-loop interval ≈6.2 ms.',
    'Windows 10 · Ryzen 7 3700X · 32 ГиБ · RX580 · 165 Гц · измеряемая область 1000×600.':'Windows 10 · Ryzen 7 3700X · 32 GiB · RX580 · 165 Hz · measured viewport: 1000×600.',
    'Запуск: прогретый кэш ОС, клон подготовленного профиля, сигнал HTML после двух rAF.':'Startup: warm OS cache, cloned prepared profile, HTML readiness signal after two rAF callbacks.',
    'Private bytes — выделенная приватная память процессов, не общий физический расход RAM.':'Private bytes: committed private process memory, not total physical RAM usage.',
    'CPU: 100% = одно логическое ядро; доля всего 16-поточного ПК в 16 раз меньше.':'CPU: 100% = one logical core; whole-machine percentages on this 16-thread PC are 16 times lower.',
    'Сравнение конкретных сборок на одном ПК. GPU load и реальные интернет-сайты здесь не измерялись.':'Specific builds on one PC. GPU load and real Internet sites were not measured in this series.',
}


def text(value):
    return ENGLISH.get(value, value) if LANGUAGE == 'en' else value
PANELS = [
    ('startup', 'readyMs', 'Запуск до готовности страницы', 'мс · 10 повторов', 1, 0),
    ('idle', 'privateBytesMedian', 'Память в простое', 'private bytes, МиБ · 5 повторов', 2**20, 1),
    ('game', 'privateBytesMedian', 'Память в игре', 'private bytes, МиБ · 5 повторов', 2**20, 1),
    ('video', 'privateBytesMedian', 'Память при видео', 'private bytes, МиБ · 5 повторов', 2**20, 1),
    ('game', 'cpuPercentOneCore', 'CPU в игре', '% одного логического ядра · 5 повторов', 1, 2),
    ('video', 'cpuPercentOneCore', 'CPU при видео', '% одного логического ядра · 5 повторов', 1, 2),
]

def chart(ax, values, panel, theme):
    scenario, key, title, unit, scale, decimals = panel
    colors = ['#237cbb', '#8b6bb9', '#5e7f9e'] if theme == 'light' else ['#42cbb6', '#a196ec', '#6ab4f0']
    ink = '#172743' if theme == 'light' else '#edf3ff'
    muted = '#52647e' if theme == 'light' else '#b4c4db'
    line = '#dce4f2' if theme == 'light' else '#30415b'
    ax.set_facecolor('#ffffff' if theme == 'light' else '#142137')
    numbers = [[x/scale for x in values[scenario][name]['metrics'][key]['values']] for name in NAMES]
    medians = [statistics.median(xs) for xs in numbers]
    top = max(max(xs) for xs in numbers)
    ax.bar(range(3), medians, width=.57, color=colors, alpha=.94, zorder=2)
    for i, xs in enumerate(numbers):
        ax.vlines(i, min(xs), max(xs), color=ink, linewidth=1.25, alpha=.75, zorder=3)
        jitter = np.linspace(-.18, .18, len(xs))
        ax.scatter(i+jitter, xs, s=21, color='#ffffff' if theme=='light' else '#e4eeff', edgecolors=ink, linewidth=.5, alpha=.86, zorder=4)
        label = f'{medians[i]:.{decimals}f}'
        if LANGUAGE == 'ru':
            label = label.replace('.', ',')
        ax.text(i, max(xs)+top*.055, label, ha='center', va='bottom', fontsize=16, fontweight='bold', color=ink)
    ax.set_ylim(0, top*1.28)
    ax.set_xlim(-.58, 2.58)
    ax.set_xticks(range(3), LABELS, fontsize=10.5, color=ink)
    ax.tick_params(axis='x', length=0, pad=12)
    ax.tick_params(axis='y', colors=muted, labelsize=10)
    ax.set_axisbelow(True)
    ax.grid(axis='y', color=line, linewidth=.7)
    for side in ['top','right']:
        ax.spines[side].set_visible(False)
    for side in ['bottom','left']:
        ax.spines[side].set_color(line)
    ax.set_title(text(title), loc='left', color=ink, fontsize=17, fontweight='bold', pad=37)
    ax.text(0, 1.035, text(unit)+text('  ·  меньше — лучше'), transform=ax.transAxes, color=muted, fontsize=10)

def render(values, theme):
    dark = theme == 'dark'
    bg, ink, muted = ('#0d1526','#edf3ff','#b4c4db') if dark else ('#f6faff','#172743','#52647e')
    fig, axes = plt.subplots(3, 2, figsize=(15,16.7), dpi=150)
    fig.patch.set_facecolor(bg)
    fig.subplots_adjust(left=.075, right=.965, top=.825, bottom=.19, hspace=.67, wspace=.24)
    fig.text(.075,.958,text('ChroMinimum в сравнении'),fontsize=32,fontweight='bold',color=ink)
    fig.text(.075,.927,text('Запуск, память и CPU · 24 октября 2026'),fontsize=18,color=muted)
    fig.text(.075,.896,text('75 из 75 попыток приняты · отдельная Windows-учётка · локальные сценарии'),fontsize=12,color=muted)
    fig.text(.075,.873,text('Столбец — медиана · точки — повторы · линия — минимум и максимум'),fontsize=11,color=muted)
    for ax, panel in zip(axes.flat, PANELS):
        chart(ax,values,panel,theme)
    fig.text(.075,.135,text('Плавность сохранена у всех трёх браузеров'),fontsize=16,fontweight='bold',color=ink)
    fig.text(.075,.113,text('Видео: 0 зарегистрированных пропусков кадров. Игра: p99 интервала рендера ≈6,2 мс.'),fontsize=11,color=muted)
    lines = [
        'Windows 10 · Ryzen 7 3700X · 32 ГиБ · RX580 · 165 Гц · измеряемая область 1000×600.',
        'CM: Chromium 154.0.8037.98 · UC: 155.0.8059.79 · Chrome: 155.0.8059.85.',
        'Запуск: прогретый кэш ОС, клон подготовленного профиля, сигнал HTML после двух rAF.',
        'Private bytes — выделенная приватная память процессов, не общий физический расход RAM.',
        'CPU: 100% = одно логическое ядро; доля всего 16-поточного ПК в 16 раз меньше.',
        'Сравнение конкретных сборок на одном ПК. GPU load и реальные интернет-сайты здесь не измерялись.',
    ]
    for i, line in enumerate(lines):
        fig.text(.075,.084-i*.012,text(line),fontsize=9,color=muted)
    stem = 'browser-comparison-2026-10-24'+('-en' if LANGUAGE == 'en' else '')+('-dark' if dark else '')
    fig.savefig(OUT/(stem+'.png'),facecolor=bg)
    fig.savefig(OUT/(stem+'.svg'),facecolor=bg,metadata={'Title':'ChroMinimum / UC / Chrome — 2026-10-24'})
    plt.close(fig)
    with Image.open(OUT/(stem+'.png')) as image:
        image.save(OUT/(stem+'.webp'),quality=92,method=6)

def main():
    global OUT, LANGUAGE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--language', choices=['ru','en'], default='ru')
    parser.add_argument('--output', type=Path, default=OUT)
    args = parser.parse_args()
    OUT, LANGUAGE = args.output.resolve(), args.language
    OUT.mkdir(parents=True,exist_ok=True)
    run=json.loads((SOURCE/'run.json').read_text(encoding='utf-8'))
    values=json.loads((SOURCE/'aggregates.json').read_text(encoding='utf-8'))
    assert run['complete'] and run['allAccepted'] and len(run['results'])==75
    for scenario,key,*_ in PANELS:
        for name in NAMES:
            assert values[scenario][name]['accepted']==(10 if scenario=='startup' else 5)
    plt.rcParams['font.family']='DejaVu Sans'
    plt.rcParams['svg.fonttype']='path'
    for theme in ['light','dark']:
        render(values,theme)
    # Publish only aggregate numbers; local user paths and profile data stay out.
    (OUT/'results.json').write_text(json.dumps(values,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    with (OUT/'results.csv').open('w',newline='',encoding='utf-8-sig') as stream:
        writer=csv.writer(stream)
        writer.writerow(['scenario','browser','metric','unit','accepted','median','min','max'])
        for scenario in ['startup','idle','video','game']:
            for name in NAMES:
                for key,metric in values[scenario][name]['metrics'].items():
                    scale=2**20 if 'Bytes' in key else 1
                    unit='MiB' if scale>1 else 'ms' if key=='readyMs' else '% one logical core' if key=='cpuPercentOneCore' else '% whole machine'
                    writer.writerow([scenario,name,key,unit,values[scenario][name]['accepted'],*[metric[k]/scale for k in ['median','min','max']]])
    print(OUT)

if __name__=='__main__':
    main()

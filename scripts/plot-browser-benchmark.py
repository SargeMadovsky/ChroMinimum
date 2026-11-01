"""Render a benchmark JSON into a standalone HTML report and PNG using Matplotlib."""
import argparse
import base64
import csv
import html
import json
import os
from pathlib import Path
import statistics as stats
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'.local/plot-python'))
sys.path.insert(0, str(ROOT/'.local/benchmark-python'))
os.environ['MPLCONFIGDIR'] = str(ROOT/'.local/matplotlib-cache')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT/'docs/reports/browser-comparison-2026-10-20')
    args = parser.parse_args()
    rows = json.loads((args.input/'results.json').read_text(encoding='utf-8'))
    meta = json.loads((args.input/'metadata.json').read_text(encoding='utf-8'))
    failures = json.loads((args.input/'failed-attempts.json').read_text(encoding='utf-8')) if (args.input/'failed-attempts.json').exists() else []
    args.output.mkdir(parents=True, exist_ok=False)
    names = ['chrominimum', 'ungoogled-chromium', 'chrome']
    labels = ['ChroMinimum\nChromium 154', 'ungoogled-chromium\n155.0.8059.79', 'Google Chrome\n155.0.8059.85']
    colors = ['#45d6b2','#9d9bff','#64b5ff']
    metrics = [('startup_ms','Запуск → готовность страницы','мс'),
               ('idle_private_mib','Private bytes всего браузера','МиБ, committed memory'),
               ('idle_working_set_sum_mib','Сумма working set процессов','МиБ, общие страницы могут повторяться'),
               ('idle_cpu_machine_percent','CPU · ранний простой (5–10 с)','% от всех логических процессоров')]
    plt.rcParams.update({'font.family':'DejaVu Sans','text.color':'#e9effb','axes.labelcolor':'#aebed4',
                         'xtick.color':'#b6c6dc','ytick.color':'#b6c6dc','axes.edgecolor':'#32415d'})
    fig, axs = plt.subplots(2,2,figsize=(14,10),facecolor='#0d1526')
    summary = {}
    for ax,(key,title,unit) in zip(axs.flat,metrics):
        ax.set_facecolor('#142035')
        medians = []
        for i,name in enumerate(names):
            values = [r[key] for r in rows if r['browser']==name]
            if len(values)!=meta['runs']:
                raise ValueError(f'Incomplete series: {name}: {len(values)}')
            med = stats.median(values)
            medians.append(med)
            summary.setdefault(name,{})[key]={'median':med,'min':min(values),'max':max(values),'n':len(values)}
            ax.bar(i,med,color=colors[i],width=.52,alpha=.82,zorder=2)
            ax.plot([i,i],[min(values),max(values)],color='#eaf1ff',lw=1,zorder=3)
            xs = [i+(j-(len(values)-1)/2)*.025 for j in range(len(values))]
            ax.scatter(xs,values,s=18,color='#eaf1ff',alpha=.75,zorder=4,edgecolors='#142035',linewidths=.4)
            ax.text(i,max(values)+max(max(values),med)*.055,f'{med:.2f}' if med<10 else f'{med:.0f}',ha='center',weight='bold',fontsize=12)
        ax.set_title(title,loc='left',fontsize=14,pad=20,weight='bold')
        ax.set_ylabel(unit,fontsize=10)
        ax.set_xticks(range(3),labels,fontsize=10)
        ax.set_ylim(0,max(summary[n][key]['max'] for n in names)*1.28 or 1)
        ax.yaxis.grid(True,color='#32415d',alpha=.5)
        ax.set_axisbelow(True)
        ax.spines[['top','right']].set_visible(False)
    fig.suptitle('Одна локальная страница · три браузера',x=.07,ha='left',fontsize=24,weight='bold')
    foreground = sum(s['foreground'] for r in rows for s in r['samples'])
    total = sum(len(r['samples']) for r in rows)
    fig.text(.07,.915,f'ПРЕДВАРИТЕЛЬНО  •  по {meta["runs"]} успешных запусков  •  viewport 1000 × 600  •  меньше — лучше',fontsize=11,color='#aebed4')
    fig.text(.07,.045,'Столбец — медиана; точки — отдельные прогоны; линия — минимум–максимум.\n'
             'Прогретый кэш ОС; новый клон профиля на каждый запуск; 200 карточек; 5 с стабилизации + 5 с простоя.\n'
             f'Разные версии движка. Фокус: {foreground}/{total} отсчётов. Рабочий ПК, фон не изолирован. Неуспешных попыток: {len(failures)}.',
             fontsize=9,color='#aebed4',linespacing=1.6)
    fig.subplots_adjust(left=.08,right=.97,top=.85,bottom=.16,hspace=.5,wspace=.28)
    png=args.output/'comparison.png'
    fig.savefig(png,dpi=160,facecolor=fig.get_facecolor())
    fig.savefig(args.output/'comparison.svg',facecolor=fig.get_facecolor())
    plt.close(fig)
    (args.output/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    for filename in ('results.json','metadata.json','fixture.html'):
        (args.output/filename).write_bytes((args.input/filename).read_bytes())
    (args.output/'failed-attempts.json').write_text(json.dumps(failures,indent=2),encoding='utf-8')
    with (args.output/'runs.csv').open('w',newline='',encoding='utf-8-sig') as f:
        fields=['browser','iteration']+[m[0] for m in metrics]+['system_cpu_percent']
        writer=csv.DictWriter(f,fieldnames=fields);writer.writeheader()
        writer.writerows({k:r[k] for k in fields} for r in rows)
    table=''.join('<tr><td>'+html.escape(n)+'</td>'+''.join(f'<td>{summary[n][k]["median"]:.2f}</td>' for k,_,_ in metrics)+
                  '<td>'+str(sum(s['foreground'] for r in rows if r['browser']==n for s in r['samples']))+'/'+str(sum(len(r['samples']) for r in rows if r['browser']==n))+'</td></tr>' for n in names)
    image=base64.b64encode(png.read_bytes()).decode()
    report=f'''<!doctype html><html lang="ru"><meta charset="utf-8"><title>Сравнение браузеров — 20 октября 2026</title>
<style>body{{background:#0d1526;color:#e9effb;font:16px/1.6 system-ui;margin:32px auto;max-width:1200px;padding:0 24px}}img{{width:100%}}table{{width:100%;border-collapse:collapse}}td,th{{text-align:left;padding:12px;border-bottom:1px solid #32415d}}p{{color:#b6c6dc}}a{{color:#64b5ff}}</style>
<h1>Предварительное сравнение браузеров</h1><p>20 октября 2026 · Windows · один локальный документ · {meta['runs']} успешных повторов каждого браузера.</p>
<img alt="Измеренные значения с разбросом" src="data:image/png;base64,{image}">
<table><tr><th>Браузер</th><th>Запуск, мс</th><th>Private bytes, МиБ</th><th>Σ working set, МиБ</th><th>CPU, % машины</th><th>Отсчёты с фокусом</th></tr>{table}</table>
<p>Запуск: время от вызова создания процесса до получения локальным сервером сообщения JavaScript после двух requestAnimationFrame при viewport 1000×600. Включает управление окном и HTTP-сообщение; это не чистая скорость движка и не гарантия появления пикселей на мониторе.</p>
<p>Ресурсы: 5 секунд стабилизации, затем 6 отсчётов с шагом 1 с. Для каждого запуска память — медиана отсчётов. Private bytes — частная committed memory, а не физическая RAM. Σ working set повторно учитывает общие страницы. CPU — прирост user+kernel времени процессов, делённый на время интервала и число логических CPU. Краткоживущие процессы между отсчётами могут быть пропущены.</p>
<p>Каждый запуск получает новый клон инициализированного тестового профиля. Кэш ОС не очищается; сначала выполняется калибровка каждого браузера, результаты калибровки исключены. Порядок ABC/BCA/CAB чередуется. Окно закреплено поверх других окон, видимость и viewport проверяются. Активность окна при отсчётах: {foreground}/{total}; фокус не удерживается на протяжении всего интервала.</p>
<p>Это рабочий компьютер: другие приложения продолжают работать, фоновые соединения браузеров не блокируются. Различаются версии Chromium и оболочки, Chrome распакован без системной установки. Проверки Speedometer, загрузки реальных сайтов, холодного запуска и независимая проверка sandbox не входят в эту серию. Данные не доказывают общего превосходства какого-либо браузера.</p>
<p>Загрузка CPU всей системы во время интервалов: {min(r['system_cpu_percent'] for r in rows):.1f}–{max(r['system_cpu_percent'] for r in rows):.1f}%. Это дополнительная причина повторить серию на свободном компьютере. В первой серии один готовый прогон Chrome отклонён при дополнительном требовании фокуса в момент сигнала; после снятия требования повторён с новым профилем. Успешные результаты сохранены; это изменение условия приёмки, а не измерительной формулы.</p>
<p>Неуспешных попыток основной серии: {len(failures)}; они не входят в графики и сохранены в failed-attempts.json. В том числе у ChroMinimum превышен лимит штатного завершения 30 секунд; позже процессы завершились самостоятельно. Поэтому графики отражают успешные повторы, а не надёжность браузеров. Принудительное завершение не использовалось.</p>
<p>Оборудование: {html.escape(meta.get('cpu_model',meta['cpu']))}; {meta['physical_cpus']} ядер / {meta['logical_cpus']} потоков; {meta['ram_bytes']/2**30:.1f} ГиБ RAM. ОС: {html.escape(meta['os'])}. Датчик батареи: {html.escape(meta['power'])}; None означает отсутствие доступных данных датчика. Схема питания записана в metadata.json.</p>
<p>Рядом с отчётом: runs.csv, results.json, metadata.json, summary.json и fixture.html. Все значения и пути относятся только к тестовым сборкам и профилям.</p></html>'''
    (args.output/'report.html').write_text(report,encoding='utf-8')
    print(json.dumps(summary,indent=2))
    print(args.output/'report.html')


if __name__=='__main__':
    main()

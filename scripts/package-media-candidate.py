"""Collect the pinned local media candidate without rebuilding, signing or publishing."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SETUP = 'ac427e0903fc71d03d3172436272b06981acd6211815d3f1861f1be203e1ec71'
EXPECTED_ENGINE = 'ef8d6219fb826b586ca25b60f6583ba0c1453cb9172051521a02f5fb8057e020'


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def regular(file):
    for part in [file,*file.parents]:
        if part.is_symlink() or getattr(part.lstat(),'st_file_attributes',0)&0x400:
            raise ValueError(f'Reparse source refused: {part}')
    if not file.is_file():
        raise ValueError(f'Regular source required: {file}')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--install-result',type=Path,required=True)
    parser.add_argument('--media-en',type=Path,required=True)
    parser.add_argument('--media-ru',type=Path,required=True)
    args=parser.parse_args()
    output=args.output.resolve()
    if not output.is_relative_to(ROOT/'dist') or output==ROOT/'dist' or output.exists():
        raise ValueError('Use a new directory inside workspace dist; old candidates are preserved')
    setup=ROOT/'dist/ChroMinimum-0.0.1-alpha.8-setup-x64.exe'
    regular(setup)
    if digest(setup)!=EXPECTED_SETUP:
        raise ValueError('Installer differs from the accepted candidate')
    payload=ROOT/'.local/alpha8-installer-20261023/payload-final'
    inspection=json.loads((ROOT/'docs/reports/alpha8-installer-20261023/payload-inspection.json').read_text())
    for name,entry in inspection.items():
        file=(payload/name).resolve()
        if not file.is_relative_to(payload.resolve()):
            raise ValueError('Escaped payload path')
        regular(payload/name)
        if file.stat().st_size!=entry['bytes'] or digest(file)!=entry['sha256']:
            raise ValueError(f'Payload identity mismatch: {name}')
    policy=json.loads((payload/'core/seed/installer-seed.json').read_text())
    if policy.get('media_codecs') is not True or policy['files']['libcef.dll']!=EXPECTED_ENGINE:
        raise ValueError('Pinned media CEF policy required')
    install=json.loads(args.install_result.read_text(encoding='utf-8'))
    test_setup=ROOT/'dist/ChroMinimum-0.0.1-alpha.8-test-setup-x64.exe'
    if install.get('installer_sha256')!=digest(test_setup):
        raise ValueError('Acceptance belongs to a different TestInstall executable')
    for locale,directory in [('en-US',args.media_en),('ru',args.media_ru)]:
        if directory.resolve()!=(args.install_result.parent/locale/'media').resolve():
            raise ValueError('Do not mix media evidence from another installer acceptance')
    for locale in ['en-US','ru']:
        for field in ['installed','uninstalled','installed_media_checked','payload_hashes_checked','defaults_unchanged','user_data_preserved','owner_application_registration_unchanged']:
            if install[locale].get(field) is not True:
                raise ValueError(f'Installer acceptance missing {locale}/{field}')
    if not install['en-US'].get('alpha7_upgrade_checked'):
        raise ValueError('Real alpha.7 upgrade acceptance required')
    # Re-evaluate actual decoded-frame and nonzero PCM evidence.
    import importlib.util
    spec=importlib.util.spec_from_file_location('media_check',ROOT/'scripts/check-media-report.py')
    checker=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    media={locale:checker.check(directory) for locale,directory in [('en-US',args.media_en),('ru',args.media_ru)]}
    if not all(result['passed'] for result in media.values()):
        raise ValueError(f'Media acceptance failed: {media}')
    for directory in [args.media_en,args.media_ru]:
        if json.loads((directory/'visibility.json').read_text()).get('visibility')!='visible':
            raise ValueError('Visible installed-media acceptance required')
    materials_dir=ROOT/'dist/alpha8-source-materials'
    materials=json.loads((materials_dir/'source-materials.json').read_text())
    files={setup.name:setup,'LICENSE':payload/'LICENSE','THIRD_PARTY.md':payload/'THIRD_PARTY.md',
           'LICENSES-RUST.html':payload/'LICENSES-RUST.html','LICENSES-UPDATER.html':payload/'LICENSES-UPDATER.html',
           'CREDITS.html':payload/'core/seed/CREDITS.html','sources/source-materials.json':materials_dir/'source-materials.json',
           'verification/install-result.json':args.install_result}
    for locale,directory in [('en-US',args.media_en),('ru',args.media_ru)]:
        for name in ['playback.json','visibility.json','smoke.log']:
            files[f'verification/{locale}/{name}']=directory/name
    for name in ['cef/LICENSE','cef-rs/LICENSE-APACHE','cef-rs/LICENSE-MIT']:
        files['third_party/'+name]=payload/'third_party'/name
    for name,entry in materials['archives'].items():
        if Path(entry['path']).name!=entry['path']:
            raise ValueError('Source archive must be a plain filename')
        file=materials_dir/entry['path'];regular(file)
        if file.stat().st_size!=entry['bytes'] or digest(file)!=entry['sha256']:
            raise ValueError('Source archive hash mismatch: '+name)
        with zipfile.ZipFile(file) as archive:
            if archive.testzip() is not None:
                raise ValueError('Invalid source archive: '+name)
        files['sources/'+file.name]=file
    for file in files.values():
        regular(file)
    output.mkdir(parents=True)
    for name,source in files.items():
        target=output/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
    (output/(setup.name+'.sha256')).write_text(EXPECTED_SETUP+'  '+setup.name+'\n',encoding='utf-8')
    (output/'README-RU.txt').write_text('''ChroMinimum 0.0.1-alpha.8 — локальный media-кандидат, Windows x64

Установщик: ChroMinimum-0.0.1-alpha.8-setup-x64.exe.
Сохранён принятый бинарный состав; новой компиляции ядра не выполнялось.
Дата сборки оболочки в About остаётся 22.10.2026, дата комплектации — 24.10.2026.
H.264/AAC и WebM проверены через установленный launcher на локальных fixtures.
Владелец ранее подтвердил воспроизведение hdrezka и fullscreen.
Это не обещание поддержки всех сайтов, DRM-сервисов или всех кодеков.

Включены доработки About, сохранения состояния окна и fullscreen видео.
Установщик per-user; окно выбора языка EN/RU. Подробности проверок — verification/.
Установщик не подписан Authenticode. SHA256SUMS.txt проверяет целостность,
но не является подписью издателя.

ПУБЛИЧНАЯ ГОТОВНОСТЬ: НЕ ПОДТВЕРЖДЕНА.
Media-канал обновлений пока не опубликован: его проверка может вернуть ошибку.
Переход на stock CEF без кодеков запрещён политикой этого кандидата.
Нужны решение условий распространения кодеков, полнота LGPL/relinking
материалов и приёмка публичной подписанной доставки обновлений.
sources/ содержит проверенные исходные материалы и сведения о сборке,
но не объявляется полным подтверждением выполнения этих обязательств.

312 мс в сравнительной серии — прямой запуск core bootstrap на прогретом
кэше ОС, не отдельный замер установленного launcher/updater.
''',encoding='utf-8')
    (output/'RELEASE-NOTES.md').write_text('''# ChroMinimum 0.0.1-alpha.8 — media-кандидат

- H.264/AAC и WebM в проверенном media CEF.
- Полноэкранное видео со скрытием панели навигации.
- Доработки About и восстановления состояния окна.
- Политика обновления сохраняет требуемую поддержку media-кодеков.

Проверены изолированные установка EN/RU, обновление alpha.7, HTML/PDF,
NetworkService Low/AppContainer, сохранение данных и удаление.
На обоих языках через установленный launcher подтверждены MP4/WebM
и декодирование AAC в ненулевой PCM. Это локальная проверка, не гарантия
совместимости со всеми сайтами и DRM.

Публичная готовность не подтверждена: см. README-RU.txt и sources/source-materials.json.
''',encoding='utf-8')
    (output/'verification/media-checks.json').write_text(json.dumps(media,indent=2)+'\n',encoding='utf-8')
    manifest={'version':'0.0.1-alpha.8','variant':'official-release-media','media_codecs_required':True,
              'rebuilt':False,'public_distribution_ready':False,'authenticode_signed':False,
              'update_channel_published':False,'complete_source_relinking_compliance_verified':False,
              'patent_requirements_verified':False,'files':{}}
    for file in sorted(output.rglob('*')):
        if file.is_file():
            manifest['files'][file.relative_to(output).as_posix()]={'bytes':file.stat().st_size,'sha256':digest(file)}
    (output/'candidate-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    sums={name:entry['sha256'] for name,entry in manifest['files'].items()}
    sums['candidate-manifest.json']=digest(output/'candidate-manifest.json')
    (output/'SHA256SUMS.txt').write_text(''.join(f'{sha}  {name}\n' for name,sha in sorted(sums.items())),encoding='utf-8')
    print(json.dumps({'output':str(output),'files':len(manifest['files'])+2,'bytes':sum(p.stat().st_size for p in output.rglob('*') if p.is_file()),'public_distribution_ready':False}))


if __name__=='__main__':
    main()

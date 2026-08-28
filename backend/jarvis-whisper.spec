# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files

faster_whisper_data = collect_data_files("faster_whisper")

analysis = Analysis(
    ["whisper_service.py"],
    pathex=[],
    binaries=[],
    datas=faster_whisper_data,
    hiddenimports=["faster_whisper", "ctranslate2", "av", "tokenizers"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
archive = PYZ(analysis.pure)

executable = EXE(
    archive,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="jarvis-whisper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
)

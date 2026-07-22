import json
from pathlib import Path

exclude_dirs = {'.claude', '.agents', 'src', '_bmad', '_bmad-output'}
d = json.loads(Path('D:/WINCODE/Inventory Management System_2/graphify-out/.graphify_detect.json').read_bytes().decode('utf-8'))
scan_root = Path(d['scan_root'])

filtered = {
    'scan_root': d['scan_root'],
    'total_files': 0,
    'total_words': d.get('total_words', 0),
    'skipped_sensitive': d.get('skipped_sensitive', []),
    'files': {}
}
for category, files in d.get('files', {}).items():
    kept = []
    for f in files:
        rel = Path(f).relative_to(scan_root)
        if len(rel.parts) > 1:
            top = rel.parts[0]
        else:
            top = '(root)'
        if top in exclude_dirs:
            continue
        kept.append(f)
    filtered['files'][category] = kept
    filtered['total_files'] += len(kept)

Path('D:/WINCODE/Inventory Management System_2/graphify-out/.graphify_detect_filtered.json').write_bytes(
    json.dumps(filtered, ensure_ascii=False).encode('utf-8')
)
print('Filtered:', filtered['total_files'], 'files kept')
cats = {k: len(v) for k, v in filtered['files'].items()}
print('Categories:', cats)

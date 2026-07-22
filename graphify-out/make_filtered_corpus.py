import json
import shutil
from pathlib import Path

exclude_dirs = {'.claude', '.agents', 'src', '_bmad', '_bmad-output'}
project_root = Path('D:/WINCODE/Inventory Management System_2')
filtered_root = project_root / 'graphify-out' / 'filtered-corpus'
filtered_root.mkdir(parents=True, exist_ok=True)

d = json.loads((project_root / 'graphify-out' / '.graphify_detect.json').read_bytes().decode('utf-8'))
scan_root = Path(d['scan_root'])

copied = 0
for category, files in d.get('files', {}).items():
    for f in files:
        src = Path(f)
        rel = src.relative_to(scan_root)
        if len(rel.parts) > 1:
            top = rel.parts[0]
        else:
            top = '(root)'
        if top in exclude_dirs:
            continue
        dst = filtered_root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1

print(f'Copied {copied} files to {filtered_root}')

import json
from pathlib import Path
from collections import defaultdict

d = json.loads(Path('D:/WINCODE/Inventory Management System_2/graphify-out/.graphify_detect.json').read_bytes().decode('utf-8'))
code_set = set(d.get('files', {}).get('code', []))
non_code = []
with open('D:/WINCODE/Inventory Management System_2/graphify-out/.graphify_uncached.txt', 'r', encoding='utf-8') as f:
    for line in f:
        fp = line.strip()
        if fp and fp not in code_set:
            non_code.append(fp)

# Group by first two path components
groups = defaultdict(list)
for f in non_code:
    rel = Path(f).relative_to(Path('D:/WINCODE/Inventory Management System_2'))
    if len(rel.parts) >= 2:
        key = rel.parts[0] + '/' + rel.parts[1]
    else:
        key = '(root)'
    groups[key].append(f)

# Sort groups by size (largest first) for better distribution
sorted_groups = sorted(groups.items(), key=lambda x: -len(x[1]))

chunks = [[], []]
chunk_sizes = [0, 0]
target = 25

for name, files in sorted_groups:
    # Find the chunk with more room
    if chunk_sizes[0] <= chunk_sizes[1]:
        target_chunk = 0
    else:
        target_chunk = 1
    chunks[target_chunk].extend(files)
    chunk_sizes[target_chunk] += len(files)

# Write chunks
for i, chunk in enumerate(chunks, 1):
    out = {
        'chunk_num': i,
        'total_chunks': len(chunks),
        'files': chunk
    }
    Path(f'D:/WINCODE/Inventory Management System_2/graphify-out/.graphify_chunk_{i:02d}.json').write_text(
        json.dumps(out, indent=2, ensure_ascii=False), encoding='utf-8'
    )
    print(f'Chunk {i}: {len(chunk)} files')

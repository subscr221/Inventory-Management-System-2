from pathlib import Path
from graphify.llm import extract_corpus_parallel

files = []
filtered_root = Path('D:/WINCODE/Inventory Management System_2/graphify-out/filtered-corpus')
for f in filtered_root.rglob('*'):
    if f.is_file():
        files.append(f)

print(f'Found {len(files)} files in filtered corpus')

result = extract_corpus_parallel(
    files=files,
    backend='claude-cli',
    root=Path('D:/WINCODE/Inventory Management System_2/graphify-out/filtered-corpus'),
    chunk_size=20,
    max_concurrency=2,
    deep_mode=False,
    cache_root=Path('.'),
)
print('Result:', result)

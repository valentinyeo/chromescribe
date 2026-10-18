import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def load() -> tuple[str, str]:
    keys = ('CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET')
    values = {key: os.environ.get(key) for key in keys}
    env_file = Path(os.environ.get('CHROMESCRIBE_ENV_FILE') or Path(__file__).resolve().parent / '.env.chromescribe')
    if not all(values.values()) and shutil.which('yeo-key'):
        item = os.environ.get('CHROMESCRIBE_KEY_ITEM') or 'Chromescribe Access'
        for key in keys:
            if not values[key]:
                try:
                    result = subprocess.run(['yeo-key', item, key], stdout=subprocess.PIPE,
                                            stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
                    if result.returncode == 0:
                        values[key] = result.stdout.rstrip('\n')
                except OSError:
                    pass
    if not all(values.values()) and env_file.is_file():
        try:
            for line in env_file.read_text(encoding='utf-8').splitlines():
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if line.startswith('export '):
                    line = line[7:].lstrip()
                key, separator, value = line.partition('=')
                key = key.strip()
                if separator and key in keys and not values[key]:
                    parts = shlex.split(value, comments=True)
                    values[key] = parts[0] if len(parts) == 1 else ''
        except (OSError, ValueError):
            print(f'Cannot read Cloudflare Access credentials from {env_file}', file=sys.stderr)
            sys.exit(1)
    for key in keys:
        if not values[key]:
            print(f'{key} is required (env, yeo-key or {env_file})', file=sys.stderr)
            sys.exit(1)
    return values[keys[0]], values[keys[1]]

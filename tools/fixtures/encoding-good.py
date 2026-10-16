import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

with open('example.txt', encoding='utf-8') as stream:
    print(stream.read())

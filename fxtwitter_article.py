#!/usr/bin/env python3
import json
import re
import sys
from urllib.parse import urlsplit


def status_id(url):
    parsed = urlsplit(url)
    if parsed.hostname not in {
        'x.com', 'www.x.com', 'mobile.x.com',
        'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
    }:
        return ''
    match = re.fullmatch(r'/(?:[^/]+/status|i/article)/(\d+)(?:/.*)?', parsed.path)
    return match.group(1) if match else ''


def render(payload):
    tweet = payload['tweet']
    author = tweet.get('author', {}).get('name', 'Unknown author')
    article = tweet.get('article')
    if article:
        title = article['title']
        prefixes = {'header-one': '# ', 'header-two': '## ',
                    'unordered-list-item': '- ', 'ordered-list-item': '1. '}
        body = '\n\n'.join(prefixes.get(block.get('type'), '') + block['text']
                           for block in article['content']['blocks'] if block.get('text'))
    else:
        title = f'Post by {author}'
        body = tweet.get('text', '')
    if not body.strip():
        raise ValueError('FXTwitter returned no article or post text')
    return f'# {title}\n\n**Author:** {author}\n\n{body}\n'


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if len(sys.argv) == 3 and sys.argv[1] == '--status-id':
        print(status_id(sys.argv[2]))
    else:
        try:
            print(render(json.load(sys.stdin)), end='')
        except (ValueError, KeyError, TypeError) as error:
            print(f'FXTwitter extraction failed: {error}', file=sys.stderr)
            sys.exit(1)

"""Hold a synthetic Windows destination without delete sharing, like an open Office file."""
import sys
with open(sys.argv[1], 'r+', encoding='utf8') as locked:
    print('locked', flush=True)
    sys.stdin.readline()

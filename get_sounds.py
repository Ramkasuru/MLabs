"""Fetch the free VCSL drum and percussion library (CC0, about 1.5 GB) into samples/VCSL.
Only the Membranophones (drums) and Idiophones (percussion) folders are downloaded. Needs git.
Run: python get_sounds.py"""
import os
import subprocess
import sys

DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples", "VCSL")

if os.path.isdir(DEST):
    sys.exit(f"Already there: {DEST}")
subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
                "https://github.com/sgossner/VCSL.git", DEST], check=True)
subprocess.run(["git", "-C", DEST, "sparse-checkout", "set", "Membranophones", "Idiophones"], check=True)
print(f"Done: {DEST}")

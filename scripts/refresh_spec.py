#!/usr/bin/env python3
"""Refresh the checked-in OpenAPI snapshot from the live endpoint.

Usage:
    python scripts/refresh_spec.py                # fetch from prod
    python scripts/refresh_spec.py --input f.json # prune a local file instead

Defense in depth: whatever the upstream schema serves, the snapshot
keeps only the public contract. components.schemas is reduced to the
transitive closure of $refs actually reachable from the /api/v1 paths.
Output is written to openapi.json at the repo root with sorted keys,
so diffs between refreshes are stable and reviewable.

Stdlib only; no dependencies.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

LIVE_URL = "https://convexityos.com/api/v1/openapi.json"
SCHEMA_REF_PREFIX = "#/components/schemas/"
REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "openapi.json"


def collect_refs(node: object, found: set[str]) -> None:
    """Walk any JSON structure and record referenced schema names."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith(SCHEMA_REF_PREFIX):
            found.add(ref[len(SCHEMA_REF_PREFIX):])
        for value in node.values():
            collect_refs(value, found)
    elif isinstance(node, list):
        for item in node:
            collect_refs(item, found)


def prune(spec: dict) -> dict:
    schemas = (spec.get("components") or {}).get("schemas") or {}

    # Seed with refs reachable from paths, then chase refs inside the
    # kept schemas until the set stops growing.
    keep: set[str] = set()
    collect_refs(spec.get("paths") or {}, keep)
    frontier = set(keep)
    while frontier:
        nxt: set[str] = set()
        for name in frontier:
            collect_refs(schemas.get(name), nxt)
        frontier = nxt - keep
        keep |= nxt

    missing = sorted(k for k in keep if k not in schemas)
    if missing:
        sys.exit(f"error: paths reference schemas absent from components: {missing}")

    pruned = dict(spec)
    components = dict(spec.get("components") or {})
    components["schemas"] = {k: schemas[k] for k in sorted(keep)}
    pruned["components"] = components
    return pruned, len(schemas), len(keep)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=LIVE_URL)
    parser.add_argument("--input", help="prune a local spec file instead of fetching")
    args = parser.parse_args()

    if args.input:
        raw = json.loads(Path(args.input).read_text(encoding="utf-8"))
        source = args.input
    else:
        with urllib.request.urlopen(args.url, timeout=30) as resp:
            raw = json.load(resp)
        source = args.url

    pruned, before, after = prune(raw)
    OUTPUT.write_text(
        json.dumps(pruned, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"source:  {source}")
    print(f"paths:   {len(pruned.get('paths') or {})}")
    print(f"schemas: {after} kept ({before - after} unreferenced schemas dropped)")
    print(f"wrote:   {OUTPUT}")


if __name__ == "__main__":
    main()

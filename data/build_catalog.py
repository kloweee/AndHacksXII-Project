#!/usr/bin/env python3
"""
Builds data/catalog.json by merging two sources of real, hand-verified
Computer Science catalog data:

  1. data/catalog_scraped.json — real catalog.wm.edu bulletin data (title,
     credits, description, prerequisites, corequisites, COLL flags, track).
  2. data/catalog_overrides.json — hand-verified enrichment for a small
     number of courses not yet in catalog_scraped.json (e.g. math courses
     that are prerequisites for CS courses).

This app now focuses exclusively on Computer Science course planning — it
no longer tracks current-semester section offerings (crn/instructor/meeting
time/seat status), so there is no more three-way merge against a live
schedule scrape and no more "verified: false / exists but unconfirmed"
tier. Every course in the resulting catalog.json is real, hand-verified
data; if a course isn't in this file, the AI is instructed to say so
rather than guess.

Run this whenever data/catalog_scraped.json or data/catalog_overrides.json
changes:
    python3 data/build_catalog.py
"""
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
scraped_file = SCRIPT_DIR / "catalog_scraped.json"
overrides_file = SCRIPT_DIR / "catalog_overrides.json"
output_file = SCRIPT_DIR / "catalog.json"


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def strip_comment(d):
    return {code: data for code, data in d.items() if not code.startswith("_")}


# Courses whose catalog_scraped.json prerequisite list is really ONE
# "any one of these satisfies it" choice, not a list of separately required
# courses. The scrape stores these alternatives as separate array entries,
# but prompts/model_spec.txt tells the model every array entry is required,
# so they must be merged into a single "X or Y or Z" entry (the same format
# the rest of the catalog already uses for alternatives, e.g.
# "CSCI 243 or MATH 214").
ANY_ONE_OF_PREREQS = {
    "CSCI 241",
    "CSCI 243",
    "DATA 101",
    "DATA 201",
    "DATA 209",
}


def normalize_prerequisites(code, prereqs):
    prereqs = list(prereqs or [])
    if code in ANY_ONE_OF_PREREQS and len(prereqs) > 1:
        return [" or ".join(prereqs)]
    return prereqs


def build_entry(code, scraped, overrides):
    """
    scraped (real catalog.wm.edu data) wins on any field it provides;
    overrides fills in courses scraped doesn't have at all.
    """
    department = code.split(" ")[0]

    if code in scraped:
        s = scraped[code]
        return {
            "code": code,
            "title": s.get("title", code),
            "department": department,
            "credits": s.get("credits"),
            "description": s.get("description", ""),
            "prerequisites": normalize_prerequisites(code, s.get("prerequisites", [])),
            "corequisites": s.get("corequisites", []),
            "coll_attribute": s.get("domain", ""),
            "coll_curriculum": s.get("coll_curriculum", ""),
            "track": s.get("track", ""),
        }

    o = overrides[code]
    return {
        "code": code,
        "title": o.get("title", code),
        "department": department,
        "credits": o.get("credits"),
        "description": o.get("description", ""),
        "prerequisites": normalize_prerequisites(code, o.get("prerequisites", [])),
        "corequisites": [],
        "coll_attribute": o.get("coll_attribute", ""),
        "coll_curriculum": "",
        "track": "",
    }


def main():
    scraped = strip_comment(load_json(scraped_file))
    overrides = strip_comment(load_json(overrides_file)) if overrides_file.exists() else {}

    all_codes = set(scraped) | set(overrides)
    catalog = [build_entry(code, scraped, overrides) for code in sorted(all_codes)]

    output_file.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(catalog)} catalog entries ({len(scraped)} from catalog_scraped.json, "
          f"{len(overrides)} from catalog_overrides.json) to {output_file}")


if __name__ == "__main__":
    main()
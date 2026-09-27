"""
wm_cs_catalog_scraper.py

Scrapes William & Mary's Academic Catalog to build a JSON file describing
every course required for the BS in Computer Science (core requirements
plus the General, Cybersecurity, and Artificial Intelligence/Machine
Learning concentration tracks).

Data sources
------------
1. Requirements page (which courses are required, and for which track):
   https://catalog.wm.edu/programs/computer-science-bs-computer-science/index.html

2. Course-description pages (prerequisites, corequisites, credits,
   descriptions, college curriculum / domain tags), one per department
   (CSCI, MATH, DATA, ...):
   https://catalog.wm.edu/undergraduate/courses/<dept>/

The course-description pages list ALL courses in a department (including
ones that aren't part of the CS major), so this script only keeps the
courses that actually showed up on the requirements page.

Output
------
catalog.json - a dict keyed by course code, e.g.:

{
  "CSCI 141": {
    "code": "CSCI 141",
    "title": "Modern Programming Fundamentals",
    "credits": 4,
    "description": "Introduces students to the foundational principles ...",
    "prerequisites": [],
    "corequisites": ["CSCI 141L"],
    "coll_curriculum": "",
    "domain": "NQR",
    "track": "Core"
  },
  ...
}

Requirements: pip install requests beautifulsoup4
"""

import json
import re
import sys
import time

import requests
from bs4 import BeautifulSoup

REQUIREMENTS_URL = "https://catalog.wm.edu/programs/computer-science-bs-computer-science/index.html"
DEPT_COURSE_URL_TMPL = "https://catalog.wm.edu/undergraduate/courses/{dept}/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

REQUEST_TIMEOUT = 30
REQUEST_DELAY = 1.0  # be polite between requests

# ---------------------------------------------------------------------------
# Regexes
# ---------------------------------------------------------------------------

# A course header on a department course-listing page, e.g.:
#   "CSCI 141  Modern Programming Fundamentals  (4 Credits)"
#   "CSCI 120  Elementary Topics CSCI  (1-3 Credits)"
# Anchored to the start of a line so that course codes mentioned inside a
# Prerequisite(s)/Corequisite(s) line don't get mistaken for a new header.
HEADER_RE = re.compile(
    r"^([A-Z]{2,4}\s\d{3}[A-Z]{0,2})\s+(.+?)\s+\((\d+(?:-\d+)?)\s*Credits?\)",
    re.MULTILINE,
)

# A bare course code, used to pull codes out of prerequisite/corequisite text
# such as "CSCI 241 and (CSCI 243 or MATH 214)".
CODE_INLINE_RE = re.compile(r"\b([A-Z]{2,4})\s?(\d{3}[A-Z]{0,2})\b")

# Boilerplate fee sentence that shows up inline at the start of many
# descriptions - stripped out so it doesn't pollute the description field.
FEE_SENTENCE_RE = re.compile(
    r"A \$250 per credit fee will apply for students for whom initial "
    r"enrollment at W&M begins in Fall 2025 or later\.\s*"
)

# Course-search links on the requirements page, e.g. href="/search/?P=CSCI%20141"
SEARCH_LINK_RE = re.compile(r"/search/\?P=", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def get_soup(url):
    resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser")


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


def strip_trailing_footnote(text):
    """Remove a trailing footnote marker digit, e.g. 'Linear Algebra 2' -> 'Linear Algebra'."""
    return re.sub(r"\s+\d$", "", text).strip()


def normalize_code(raw):
    raw = (raw or "").replace("\xa0", " ")
    return re.sub(r"\s+", " ", raw).strip().upper()


def extract_codes(text):
    """Pull every course code mentioned in a prerequisite/corequisite string."""
    if not text:
        return []
    seen = []
    for dept, num in CODE_INLINE_RE.findall(text):
        code = f"{dept} {num}"
        if code not in seen:
            seen.append(code)
    return seen


# ---------------------------------------------------------------------------
# Step 1: scrape the requirements page for the list of required courses
# ---------------------------------------------------------------------------

def determine_track(current_h2, current_subsection):
    """Map the current heading / section-label context to a track name."""
    h2 = (current_h2 or "").lower()
    if "general" in h2:
        return "General"
    if "cybersecurity" in h2:
        return "Cybersecurity"
    if "artificial intelligence" in h2:
        return "AI/ML"

    sub = (current_subsection or "").lower()
    if "core" in sub or "proficiency" in sub:
        return "Core"
    # "Concentration Requirement" section on the main table is just a
    # pointer to the track sections below - no real course rows live there.
    return None


def scrape_required_courses(url=REQUIREMENTS_URL):
    """
    Returns a dict: code -> {"title": str, "hours": str, "tracks": [str, ...]}
    """
    soup = get_soup(url)

    # Prefer the requirements tab container if present, else fall back to
    # the whole document.
    content = soup.find(id=re.compile("requirementstext", re.I)) or soup

    required = {}
    current_h2 = None
    current_subsection = None

    for el in content.find_all(["h2", "tr"]):
        if el.name == "h2":
            current_h2 = clean(el.get_text())
            current_subsection = None
            continue

        cells = el.find_all(["td", "th"])
        if not cells:
            continue

        link = el.find("a", href=SEARCH_LINK_RE)
        if link:
            code = strip_trailing_footnote(normalize_code(link.get_text()))

            # Guard against "note" rows that happen to contain a course link
            # buried inside a full sentence (e.g. a footnote about CSCI 420
            # being eligible for a concentration). A genuine course row's
            # first cell is just the code itself (optionally preceded by
            # "or ").
            first_cell_text = clean(cells[0].get_text())
            first_cell_core = re.sub(r"^or\s+", "", first_cell_text, flags=re.I)
            first_cell_core = strip_trailing_footnote(first_cell_core).upper()
            if first_cell_core != code:
                continue

            cell_texts = [clean(c.get_text()) for c in cells]
            title = strip_trailing_footnote(cell_texts[1]) if len(cell_texts) > 1 else ""
            hours = cell_texts[-1] if cell_texts else ""

            track = determine_track(current_h2, current_subsection)
            if not track:
                continue

            entry = required.setdefault(code, {"title": title, "hours": hours, "tracks": []})
            if not entry["title"]:
                entry["title"] = title
            if not entry["hours"]:
                entry["hours"] = hours
            if track not in entry["tracks"]:
                entry["tracks"].append(track)
        else:
            label = clean(cells[0].get_text())
            if label:
                current_subsection = label

    return required


# ---------------------------------------------------------------------------
# Step 2: scrape department course-listing pages for full course details
# ---------------------------------------------------------------------------

def parse_course_block(block_text):
    """
    Parse everything that follows a course header (up to the next header)
    into description / prerequisites / corequisites / college curriculum /
    domain.
    """
    lines = [l.strip() for l in block_text.split("\n")]
    lines = [l for l in lines if l]

    desc_lines = []
    prereq_text = ""
    coreq_text = ""
    coll_curriculum = ""
    domain = ""

    for line in lines:
        if line.startswith("Prerequisite(s):"):
            prereq_text = line[len("Prerequisite(s):"):].strip()
        elif line.startswith("Corequisite(s):"):
            coreq_text = line[len("Corequisite(s):"):].strip()
        elif line.startswith("College Curriculum:"):
            coll_curriculum = line[len("College Curriculum:"):].strip()
        elif line.startswith("Domain:"):
            domain = line[len("Domain:"):].strip()
        elif line.startswith("Additional fees apply"):
            continue
        else:
            desc_lines.append(line)

    description = " ".join(desc_lines).strip()
    description = FEE_SENTENCE_RE.sub("", description).strip()

    return {
        "description": description,
        "prerequisites": extract_codes(prereq_text),
        "corequisites": extract_codes(coreq_text),
        "coll_curriculum": coll_curriculum,
        "domain": domain,
    }


def parse_dept_page(full_text):
    """Parse a department course-listing page's plain text into a dict of courses."""
    matches = list(HEADER_RE.finditer(full_text))
    courses = {}

    for i, m in enumerate(matches):
        code = normalize_code(m.group(1))
        title = clean(m.group(2))
        credits_raw = m.group(3)
        credits = int(credits_raw) if "-" not in credits_raw else credits_raw

        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(full_text)
        block = full_text[start:end]

        details = parse_course_block(block)
        courses[code] = {
            "title": title,
            "credits": credits,
            **details,
        }

    return courses


_dept_cache = {}


def get_dept_courses(dept):
    """Fetch + parse (and cache) a department's course-listing page."""
    dept = dept.lower()
    if dept in _dept_cache:
        return _dept_cache[dept]

    url = DEPT_COURSE_URL_TMPL.format(dept=dept)
    try:
        soup = get_soup(url)
        text = soup.get_text(separator="\n")
        courses = parse_dept_page(text)
        print(f"  fetched {url} -> {len(courses)} courses parsed")
    except Exception as exc:  # noqa: BLE001 - keep scraping even if one dept fails
        print(f"  WARNING: could not fetch/parse {url}: {exc}", file=sys.stderr)
        courses = {}

    _dept_cache[dept] = courses
    time.sleep(REQUEST_DELAY)
    return courses


# ---------------------------------------------------------------------------
# Step 3: combine everything into the final catalog
# ---------------------------------------------------------------------------

def build_catalog():
    print(f"Scraping requirements page: {REQUIREMENTS_URL}")
    required_courses = scrape_required_courses()
    print(f"  found {len(required_courses)} required courses across all tracks")

    catalog = {}
    for code, info in sorted(required_courses.items()):
        dept = code.split(" ")[0]
        dept_courses = get_dept_courses(dept)
        details = dept_courses.get(code)

        if details is None:
            print(f"  NOTE: '{code}' not found on the {dept} course-listing page; "
                  f"using requirements-page data only.", file=sys.stderr)
            hours = info["hours"]
            try:
                credits = int(hours) if hours and "-" not in hours else (hours or "")
            except ValueError:
                credits = hours
            details = {
                "title": info["title"],
                "credits": credits,
                "description": "",
                "prerequisites": [],
                "corequisites": [],
                "coll_curriculum": "",
                "domain": "",
            }

        title = details["title"] or info["title"]

        catalog[code] = {
            "code": code,
            "title": title,
            "credits": details["credits"],
            "description": details["description"],
            "prerequisites": details["prerequisites"],
            "corequisites": details["corequisites"],
            "coll_curriculum": details["coll_curriculum"],
            "domain": details["domain"],
            "track": ", ".join(info["tracks"]),
        }

    return catalog


def main():
    catalog = build_catalog()

    out_path = "catalog.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    print(f"\nWrote {len(catalog)} courses to {out_path}")


if __name__ == "__main__":
    main()
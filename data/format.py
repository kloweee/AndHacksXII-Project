import json
import os
from pathlib import Path

input_folder = "./data/raw_scraper_output"
output_file = "./data/sections.json"

# file names and their attributes
raw_data = {
    "path_alv.json":"ALV",
    "path_csi.json":"CSI",
    "path_nqr.json":"NQR",
    "path_comp_sci.json":"CSCI",
    "path_data_sci.json":"DATA"
}

# dictionary for all courses
combined = {}

# for each course...
# check if it is already in the dictionary
# if it is, apply new attributes to it
# if it isn't, add it to the list, including the correct properties

def add_course(cur_course, attribute):
    course_key = cur_course["key"]  # actual unique identifier for this course

    if course_key in combined:
        combined[course_key]["attributes"].append(attribute)
    
    else:
        combined[course_key] = {
            "key":cur_course["key"],
            "crn":cur_course["crn"],
            "code":cur_course["code"],
            "title":cur_course["title"],
            "section":cur_course["no"],
            "instructor":cur_course["instr"],
            "meets":cur_course["meets"],
            "status":cur_course["stat"],
            "semester":cur_course["srcdb"],
            "attributes":[attribute]
        }


if __name__=="__main__":
    for filename in raw_data:
        if filename.endswith(".json"):
            filepath = os.path.join(input_folder, filename)
            with open(filepath, "r", encoding="utf-8") as f:
                try:
                    data = json.load(f)
                except json.JSONDecodeError:
                    print(f"Skipping invalid JSON: {filename}")
                    continue

            # get the list of classes
            classes = data["results"]
            for course_dict in classes:
                add_course(course_dict, raw_data[filename])


    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(combined, f, indent=2)

    print(f"Done. Wrote {len(combined)} keys to {output_file}")
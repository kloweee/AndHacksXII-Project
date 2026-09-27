import requests
from bs4 import BeautifulSoup

csci_res = requests.get("https://catalog.wm.edu/undergraduate/courses/csci/")
data_res = requests.get("https://catalog.wm.edu/undergraduate/courses/data/")
output_file = "./data/catalog.json"

# "code": "CSCI 141",
# "title": "Modern Programming Fundamentals",
# "credits": 4,
# "description": "Introduces students to the foundational principles of programming...",
# "prerequisites": [],
# "corequisites": ["CSCI 141L"],
# "coll_curriculum": "",
# "domain": "NQR"



soup = BeautifulSoup(csci_res.content, 'html.parser')
s = soup.find_all('div', class_='courseblock')
for block in s:
    class_code = block.find('span', class_="text col-3 detail-code margin--tiny text--semibold text--huge")
    class_title = block.find('span', class_="text col-8 detail-title margin--tiny text--semibold text--huge")
    class_credits = block.find('span', class_="text detail-hours_html text--semibold")
    print(class_code.text)
    print(class_title.text)
    print(class_credits.text)
    input()

    # <span class="text detail-prerequisites margin--default"><span style="font-style: italic" class="label">Prerequisite(s):</span> <a href="/search/?P=CSCI%20141" title="CSCI&nbsp;141" class="bubblelink code" onclick="return showCourse(this, 'CSCI 141');">CSCI&nbsp;141</a> </span>

    # <span class="text detail-corequisites margin--default"><span class="label"><i>Corequisite(s): </i></span><a href="/search/?P=CSCI%20141" title="CSCI&nbsp;141" class="bubblelink code" onclick="return showCourse(this, 'CSCI 141');">CSCI&nbsp;141</a></span>
# print(soup.prettify())


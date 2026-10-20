"""Independent ZIP and XML round trip for the generated Office files. No packages or network."""
import json
import pathlib
import sys
import xml.etree.ElementTree as ET
import zipfile

root = pathlib.Path(sys.argv[1])
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/package/2006/relationships}'
documents = {}
for suffix in ('docx', 'xlsx'):
    with zipfile.ZipFile(root / ('Exomina-reply.' + suffix)) as archive:
        assert archive.testzip() is None
        names = set(archive.namelist())
        parsed = {name: ET.fromstring(archive.read(name)) for name in names}
        for name, tree in parsed.items():
            if name.endswith('.rels'):
                for rel in tree.findall(R + 'Relationship'):
                    assert rel.get('TargetMode') != 'External'
                    target = rel.get('Target')
                    parent = pathlib.PurePosixPath(name).parent.parent if name != '_rels/.rels' else pathlib.PurePosixPath()
                    assert str(parent / target) in names, (name, target)
        assert not any('vba' in name.lower() or 'external' in name.lower() for name in names)
        documents[suffix] = parsed

word = documents['docx']['word/document.xml']
word_text = ''.join(element.text or '' for element in word.iter(W + 't'))
assert 'Grüße 日本語 🦊' in word_text
assert '<script>alert("text only")</script>' in word_text
assert 'https://example.com/a?q=1&b=2' in word_text
assert word.find('.//' + W + 'b') is not None
assert word.find('.//' + W + 'i') is not None
assert sum(1 for _ in word.iter(W + 'tbl')) == 2
headings = [style for style in word.iter(W + 'pStyle') if style.get(W + 'val', '').startswith('Heading')]

book = documents['xlsx']['xl/workbook.xml']
names = [sheet.get('name') for sheet in book.iter(S + 'sheet')]
assert names == ['Budget & plan', 'Budget & plan (2)']
sheets = [documents['xlsx']['xl/worksheets/sheet1.xml'], documents['xlsx']['xl/worksheets/sheet2.xml']]
cells = {cell.get('r'): cell for cell in sheets[0].iter(S + 'c')}
strings = [element.text or '' for element in documents['xlsx']['xl/sharedStrings.xml'].iter(S + 't')]
def text_value(cell):
    assert cell.get('t') == 's'
    return strings[int(cell.find(S + 'v').text)]
assert cells['B2'].get('t') == 'n' and cells['B2'].find(S + 'v').text == '42'
assert text_value(cells['B3']) == '=1+1'
assert text_value(cells['B4']) == '00123'
assert text_value(cells['B5']) == '9007199254740993'
assert text_value(cells['B6']) == 'Grüße 日本語 🦊'
assert text_value(cells['B7']) == 'a|b'
assert text_value(cells['B8']) == '_x005F_x0041_'
assert all(sheet.find('.//' + S + 'f') is None for sheet in sheets)
assert all(sheet.find(S + 'autoFilter') is not None for sheet in sheets)
assert all(sheet.find('.//' + S + 'pane').get('state') == 'frozen' for sheet in sheets)
last = {cell.get('r'): cell for cell in sheets[1].iter(S + 'c')}
assert 'C2' not in last
assert text_value(last['C3']) == 'retained'
with zipfile.ZipFile(root / 'names.xlsx') as archive:
    names_book = ET.fromstring(archive.read('xl/workbook.xml'))
    assert [sheet.get('name') for sheet in names_book.iter(S + 'sheet')] == ['History table', 'a' * 30]
    first_sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    assert not any(cell.get('r') == 'B2' for cell in first_sheet.iter(S + 'c'))
print(json.dumps({'zipCrcValid': True, 'allXmlValid': True, 'wordHeadings': len(headings), 'wordTables': 2, 'sheetNames': names, 'literalFormulas': True, 'numericCells': True, 'unicodeAndIdentifiers': True, 'noExternalRelationships': True}))

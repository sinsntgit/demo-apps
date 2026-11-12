"""Extract plain text from uploaded training documents."""
import io

MAX_BYTES = 20 * 1024 * 1024
TEXT_EXT = {".txt", ".md", ".sql", ".csv", ".json", ".yaml", ".yml", ".rst", ".html"}
SUPPORTED = TEXT_EXT | {".pdf", ".docx", ".xlsx"}


def extract(filename: str, data: bytes) -> str:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in SUPPORTED:
        raise ValueError(f"Unsupported file type '{ext}'. Supported: {', '.join(sorted(SUPPORTED))}")
    if len(data) > MAX_BYTES:
        raise ValueError("File is larger than 20 MB.")
    if ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join((p.extract_text() or "") for p in reader.pages)
    if ext == ".docx":
        import docx
        d = docx.Document(io.BytesIO(data))
        parts = [p.text for p in d.paragraphs if p.text.strip()]
        for table in d.tables:
            for row in table.rows:
                parts.append(" | ".join(c.text.strip() for c in row.cells))
        return "\n\n".join(parts)
    if ext == ".xlsx":          # e.g. a data dictionary kept in a spreadsheet
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        parts = []
        for ws in wb.worksheets:
            parts.append(f"# {ws.title}")
            for row in ws.iter_rows(values_only=True):
                cells = [str(c) for c in row if c is not None]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n".join(parts)
    return data.decode("utf-8", errors="replace")

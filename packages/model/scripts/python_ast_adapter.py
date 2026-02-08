#!/usr/bin/env python3
import ast
import json
import sys

try:
    import libcst as cst
    from libcst.metadata import MetadataWrapper, PositionProvider
except Exception:
    cst = None
    MetadataWrapper = None
    PositionProvider = None


def line_starts(content):
    starts = []
    offset = 0
    for line in content.splitlines(keepends=True):
        starts.append(offset)
        offset += len(line)
    return starts, offset


def to_offset(starts, total, line, col):
    if not isinstance(line, int) or line <= 0:
        return 0
    index = line - 1
    if index >= len(starts):
        return total
    column = col if isinstance(col, int) and col >= 0 else 0
    return starts[index] + column


def symbol_record(content, starts, total, kind, name, start_line, start_col, end_line, end_col):
    start = to_offset(starts, total, start_line, start_col)
    end = to_offset(starts, total, end_line, end_col)
    if end < start:
        end = start
    return {
        "kind": kind,
        "name": name,
        "start": start,
        "end": end,
        "body": content[start:end],
    }


def parse_top_level_ast(content):
    tree = ast.parse(content)
    starts, total = line_starts(content)
    symbols = []

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = "def"
        elif isinstance(node, ast.ClassDef):
            kind = "class"
        else:
            continue

        name = getattr(node, "name", None)
        if not isinstance(name, str):
            continue

        start_line = getattr(node, "lineno", 1)
        start_col = getattr(node, "col_offset", 0)
        decorators = getattr(node, "decorator_list", None)
        if isinstance(decorators, list) and decorators:
            first = decorators[0]
            start_line = getattr(first, "lineno", start_line)
            start_col = getattr(first, "col_offset", start_col) - 1
            if start_col < 0:
                start_col = 0

        symbols.append(
            symbol_record(
                content,
                starts,
                total,
                kind,
                name,
                start_line,
                start_col,
                getattr(node, "end_lineno", getattr(node, "lineno", 1)),
                getattr(node, "end_col_offset", 0),
            )
        )

    return symbols


def parse_top_level_libcst(content):
    if cst is None or MetadataWrapper is None or PositionProvider is None:
        raise RuntimeError("libcst unavailable")

    module = cst.parse_module(content)
    wrapper = MetadataWrapper(module)
    wrapped_module = wrapper.module
    positions = wrapper.resolve(PositionProvider)

    starts, total = line_starts(content)
    symbols = []

    for stmt in wrapped_module.body:
        if isinstance(stmt, cst.FunctionDef):
            kind = "def"
        elif isinstance(stmt, cst.ClassDef):
            kind = "class"
        else:
            continue

        name = stmt.name.value
        pos = positions.get(stmt)
        if pos is None:
            continue

        start_line = pos.start.line
        start_col = pos.start.column
        decorators = getattr(stmt, "decorators", None)
        if isinstance(decorators, tuple) and decorators:
            dec_pos = positions.get(decorators[0])
            if dec_pos is not None:
                start_line = dec_pos.start.line
                start_col = dec_pos.start.column
        elif isinstance(decorators, list) and decorators:
            dec_pos = positions.get(decorators[0])
            if dec_pos is not None:
                start_line = dec_pos.start.line
                start_col = dec_pos.start.column

        symbols.append(
            symbol_record(
                content,
                starts,
                total,
                kind,
                name,
                start_line,
                start_col,
                pos.end.line,
                pos.end.column,
            )
        )

    return symbols


def parse_top_level(content, parser_mode):
    if parser_mode not in ("auto", "libcst", "ast"):
        return {"ok": False, "error": "unsupported_parser"}

    if parser_mode in ("auto", "libcst"):
        if cst is not None:
            try:
                symbols = parse_top_level_libcst(content)
                return {"ok": True, "parser": "libcst", "symbols": symbols}
            except cst.ParserSyntaxError as error:
                return {
                    "ok": False,
                    "error": "syntax_error",
                    "parser": "libcst",
                    "detail": str(error),
                }
            except Exception as error:
                if parser_mode == "libcst":
                    return {
                        "ok": False,
                        "error": "parse_error",
                        "parser": "libcst",
                        "detail": str(error),
                    }
        elif parser_mode == "libcst":
            return {"ok": False, "error": "parser_unavailable", "parser": "libcst"}

    try:
        symbols = parse_top_level_ast(content)
        return {"ok": True, "parser": "ast", "symbols": symbols}
    except SyntaxError as error:
        return {
            "ok": False,
            "error": "syntax_error",
            "parser": "ast",
            "detail": str(error),
        }
    except Exception as error:
        return {
            "ok": False,
            "error": "parse_error",
            "parser": "ast",
            "detail": str(error),
        }


def main():
    raw = sys.stdin.read()
    payload = {}
    if raw.strip():
        try:
            payload = json.loads(raw)
        except Exception as error:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": "invalid_input",
                        "detail": str(error),
                    }
                )
            )
            return

    action = payload.get("action")
    content = payload.get("content", "")
    parser_mode = payload.get("parser", "auto")
    if not isinstance(content, str):
        content = ""
    if not isinstance(parser_mode, str):
        parser_mode = "auto"
    parser_mode = parser_mode.lower()

    if action != "parse_top_level":
        print(json.dumps({"ok": False, "error": "unsupported_action"}))
        return

    print(json.dumps(parse_top_level(content, parser_mode)))


if __name__ == "__main__":
    main()

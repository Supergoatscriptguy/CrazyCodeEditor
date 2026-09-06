# LSP worker: Jedi completions/hover/goto, pyflakes, black.
import json, ast, os, sys

WORKSPACE = "/workspace"
os.makedirs(WORKSPACE, exist_ok=True)
os.chdir(WORKSPACE)
if sys.path[0] != WORKSPACE:
    sys.path.insert(0, WORKSPACE)

import jedi
from jedi.api.environment import InterpreterEnvironment

jedi.settings.case_insensitive_completion = True
jedi.settings.add_bracket_after_function = False

_env = InterpreterEnvironment()
_project = jedi.Project(WORKSPACE, environment_path=None, added_sys_path=[WORKSPACE])


def _script(code, path):
    full = os.path.join(WORKSPACE, path) if path and not path.startswith("/") else path
    return jedi.Script(code, path=full, project=_project, environment=_env)


_TYPE_MAP = {
    "module": "namespace",
    "class": "class",
    "instance": "variable",
    "function": "function",
    "param": "variable",
    "path": "text",
    "keyword": "keyword",
    "property": "property",
    "statement": "variable",
}


def complete(code, line, col, path):
    s = _script(code, path)
    out = []
    for c in s.complete(line, col):
        try:
            desc = c.description
        except Exception:
            desc = ""
        out.append(
            {
                "name": c.name,
                "type": _TYPE_MAP.get(c.type, "variable"),
                "kind": c.type,
                "desc": desc,
            }
        )
    return out


def detail(code, line, col, path, name):
    """Docstring/signature for one completion item, fetched lazily."""
    s = _script(code, path)
    for c in s.complete(line, col):
        if c.name == name:
            sig = ""
            try:
                sigs = c.get_signatures()
                if sigs:
                    sig = sigs[0].to_string()
            except Exception:
                pass
            try:
                doc = c.docstring(raw=True)
            except Exception:
                doc = ""
            return {"sig": sig, "doc": doc[:2000]}
    return None


def signatures(code, line, col, path):
    s = _script(code, path)
    out = []
    for sig in s.get_signatures(line, col):
        out.append(
            {
                "name": sig.name,
                "label": sig.to_string(),
                "params": [p.name for p in sig.params],
                "index": sig.index,
                "doc": (sig.docstring(raw=True) or "")[:800],
            }
        )
    return out


def hover(code, line, col, path):
    s = _script(code, path)
    names = s.help(line, col)
    if not names:
        names = s.infer(line, col)
    if not names:
        return None
    n = names[0]
    sig = ""
    try:
        sigs = n.get_signatures()
        if sigs:
            sig = sigs[0].to_string()
    except Exception:
        pass
    try:
        doc = n.docstring(raw=True)
    except Exception:
        doc = ""
    return {
        "name": n.name,
        "kind": n.type,
        "desc": n.description,
        "sig": sig,
        "doc": doc[:3000],
        "module": n.module_name,
    }


def goto(code, line, col, path):
    s = _script(code, path)
    out = []
    for n in s.goto(line, col, follow_imports=True):
        p = n.module_path
        out.append(
            {
                "name": n.name,
                "path": str(p) if p else None,
                "line": n.line,
                "col": n.column,
                "kind": n.type,
            }
        )
    return out


# diagnostics
from pyflakes import checker as _pfchecker, messages as _pfm  # noqa: E402

_ERRORS = (
    _pfm.UndefinedName,
    _pfm.UndefinedLocal,
    _pfm.UndefinedExport,
    _pfm.ReturnOutsideFunction,
    _pfm.YieldOutsideFunction,
    _pfm.ContinueOutsideLoop,
    _pfm.BreakOutsideLoop,
    _pfm.DefaultExceptNotLast,
    _pfm.DuplicateArgument,
    _pfm.TooManyExpressionsInStarredAssignment,
    _pfm.TwoStarredExpressions,
    _pfm.ForwardAnnotationSyntaxError,
    _pfm.StringDotFormatExtraPositionalArguments,
    _pfm.StringDotFormatExtraNamedArguments,
    _pfm.StringDotFormatMissingArgument,
    _pfm.StringDotFormatMixingAutomatic,
    _pfm.StringDotFormatInvalidFormat,
    _pfm.PercentFormatInvalidFormat,
    _pfm.FStringMissingPlaceholders,
)


def lint(code, path):
    try:
        tree = ast.parse(code, filename=path)
    except SyntaxError as e:
        return [
            {
                "line": e.lineno or 1,
                "col": max((e.offset or 1) - 1, 0),
                "endLine": e.end_lineno or e.lineno or 1,
                "endCol": max((e.end_offset or (e.offset or 1)) - 1, 0),
                "msg": f"SyntaxError: {e.msg}",
                "severity": "error",
            }
        ]
    except Exception as e:  # e.g. RecursionError, ValueError from null bytes
        return [{"line": 1, "col": 0, "msg": f"{type(e).__name__}: {e}", "severity": "error"}]
    w = _pfchecker.Checker(tree, filename=path)
    out = []
    for m in w.messages:
        out.append(
            {
                "line": m.lineno,
                "col": m.col,
                "msg": m.message % m.message_args,
                "severity": "error" if isinstance(m, _ERRORS) else "warning",
                "code": type(m).__name__,
            }
        )
    out.sort(key=lambda d: (d["line"], d["col"]))
    return out


# formatting
import black  # noqa: E402


def format_code(code, line_length=88):
    try:
        mode = black.Mode(line_length=line_length)
        return {"code": black.format_str(code, mode=mode)}
    except black.InvalidInput as e:
        return {"error": f"Cannot format: {e}"}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


_METHODS = {
    "complete": complete,
    "detail": detail,
    "signatures": signatures,
    "hover": hover,
    "goto": goto,
    "lint": lint,
    "format": format_code,
    "oneline": lambda code, path="main.py": oneline(code, path),  # defined by oneline.py, loaded first
}


def dispatch(method, params_json):
    params = json.loads(params_json)
    try:
        return json.dumps({"result": _METHODS[method](**params)})
    except Exception as e:
        return json.dumps({"error": f"{type(e).__name__}: {e}"})


def warmup():
    src = "import json\nx = json.du"
    try:
        complete(src, 2, 11, "warm.py")
        lint(src, "warm.py")
        format_code("x = { 'a':1 }\n")
    except Exception:
        pass

# Rewrites a module onto one line. Simple statements are joined with ";",
# compound ones become expressions (walrus, conditional expressions,
# comprehensions, lambdas, type()). Anything that can't be expressed is exec()'d.
import ast, textwrap


class _Unsupported(Exception):
    pass


_BINOPS = {
    ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.FloorDiv: "//", ast.Mod: "%", ast.Pow: "**",
    ast.LShift: "<<", ast.RShift: ">>", ast.BitOr: "|", ast.BitXor: "^", ast.BitAnd: "&", ast.MatMult: "@",
}

_SIMPLE = (ast.Expr, ast.Assign, ast.AugAssign, ast.AnnAssign, ast.Import, ast.ImportFrom, ast.Assert, ast.Raise, ast.Delete, ast.Pass, ast.Global, ast.Nonlocal)
_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)


def _contains(stmts, kinds, stop_at=()):
    """True if any statement (not inside nested scopes / stop_at nodes) is one of kinds."""
    stack = list(stmts)
    while stack:
        n = stack.pop()
        if isinstance(n, kinds):
            return True
        if isinstance(n, _SCOPES) or isinstance(n, stop_at):
            continue
        for child in ast.iter_child_nodes(n):
            if isinstance(child, ast.stmt):
                stack.append(child)
            elif isinstance(child, (ast.Yield, ast.YieldFrom, ast.Await)) and (ast.Yield in kinds or ast.Await in kinds):
                return True
            elif isinstance(child, ast.expr):
                for sub in ast.walk(child):
                    if isinstance(sub, kinds) and not isinstance(sub, ast.stmt):
                        return True
    return False


def _has_yield(node):
    for sub in ast.walk(node):
        if isinstance(sub, (ast.Yield, ast.YieldFrom, ast.Await)):
            return True
    return False


class _OneLiner:
    def __init__(self, src):
        self.src = src
        self.fallbacks = []
        self.tmp = 0

    def temp(self):
        self.tmp += 1
        return f"__t{self.tmp}"

    def u(self, node):
        return ast.unparse(node)

    def tuple_of(self, exprs):
        if not exprs:
            return "None"
        if len(exprs) == 1:
            return f"({exprs[0]})"
        return "(" + ", ".join(exprs) + ")"

    def last(self, exprs):
        """Expression that evaluates all of exprs and yields the last one."""
        if not exprs:
            return "None"
        if len(exprs) == 1:
            return f"({exprs[0]})"
        return "(" + ", ".join(exprs) + ")[-1]"

    # assignment targets
    def assign_to(self, target, value):
        if isinstance(target, ast.Name):
            return f"({target.id} := {value})"
        if isinstance(target, ast.Attribute):
            return f"setattr({self.u(target.value)}, {target.attr!r}, {value})"
        if isinstance(target, ast.Subscript):
            return f"{self.u(target.value)}.__setitem__({self.u(target.slice)}, {value})"
        if isinstance(target, (ast.Tuple, ast.List)):
            if any(isinstance(e, ast.Starred) for e in target.elts):
                raise _Unsupported("starred unpacking")
            t = self.temp()
            parts = [f"({t} := tuple({value}))"]
            for i, e in enumerate(target.elts):
                parts.append(self.assign_to(e, f"{t}[{i}]"))
            return self.last(parts)
        raise _Unsupported("assignment target")

    # statements
    def block(self, stmts):
        out = []
        for s in stmts:
            out.extend(self.stmt(s))
        return out

    def stmt(self, s):
        try:
            return self._stmt(s)
        except _Unsupported as e:
            self.fallbacks.append([s.lineno, type(s).__name__, str(e)])
            seg = ast.get_source_segment(self.src, s)
            seg = textwrap.dedent(seg) if seg else self.u(s)
            return [f"exec({seg!r})"]

    def _stmt(self, s):
        if isinstance(s, ast.Expr):
            if _has_yield(s):
                raise _Unsupported("yield/await")
            return [self.u(s.value)]
        if isinstance(s, ast.Assign):
            if _has_yield(s):
                raise _Unsupported("yield/await")
            v = self.u(s.value)
            if len(s.targets) == 1:
                return [self.assign_to(s.targets[0], v)]
            t = self.temp()
            parts = [f"({t} := {v})"] + [self.assign_to(tg, t) for tg in s.targets]
            return [self.last(parts)]
        if isinstance(s, ast.AugAssign):
            op = _BINOPS[type(s.op)]
            tg = s.target
            v = self.u(s.value)
            if isinstance(tg, ast.Name):
                return [f"({tg.id} := {tg.id} {op} ({v}))"]
            if isinstance(tg, ast.Attribute):
                obj = self.u(tg.value)
                return [f"setattr({obj}, {tg.attr!r}, getattr({obj}, {tg.attr!r}) {op} ({v}))"]
            if isinstance(tg, ast.Subscript):
                obj = self.u(tg.value)
                k = self.u(tg.slice)
                return [f"{obj}.__setitem__({k}, {obj}[{k}] {op} ({v}))"]
            raise _Unsupported("augmented assignment target")
        if isinstance(s, ast.AnnAssign):
            if s.value is None:
                return []
            return [self.assign_to(s.target, self.u(s.value))]
        if isinstance(s, ast.Pass):
            return []
        if isinstance(s, ast.If):
            body = self.tuple_of(self.block(s.body))
            orelse = self.tuple_of(self.block(s.orelse)) if s.orelse else "None"
            return [f"({body} if {self.u(s.test)} else {orelse})"]
        if isinstance(s, ast.For):
            if s.orelse:
                raise _Unsupported("for/else")
            if _contains(s.body, (ast.Break, ast.Continue, ast.Return), stop_at=(ast.For, ast.While)):
                raise _Unsupported("break/continue/return inside for")
            it = self.temp()
            parts = [self.assign_to(s.target, it)] + self.block(s.body)
            return [f"[{self.tuple_of(parts)} for {it} in {self.u(s.iter)}]"]
        if isinstance(s, ast.While):
            if s.orelse:
                raise _Unsupported("while/else")
            if _contains(s.body, (ast.Break, ast.Continue, ast.Return), stop_at=(ast.For, ast.While)):
                raise _Unsupported("break/continue/return inside while")
            w = self.temp()
            body = self.tuple_of(self.block(s.body))
            return [f"[{body} for {w} in iter(lambda: bool({self.u(s.test)}), False)]"]
        if isinstance(s, ast.FunctionDef):
            return [f"({s.name} := {self.lambda_for(s)})"]
        if isinstance(s, ast.Return):
            raise _Unsupported("return here")
        if isinstance(s, ast.Import):
            parts = []
            for a in s.names:
                if a.asname:
                    parts.append(f"({a.asname} := __import__('importlib').import_module({a.name!r}))")
                else:
                    parts.append(f"({a.name.split('.')[0]} := __import__({a.name!r}))")
            return parts
        if isinstance(s, ast.ImportFrom):
            if s.level or any(a.name == "*" for a in s.names):
                raise _Unsupported("relative or star import")
            m = self.temp()
            parts = [f"({m} := __import__('importlib').import_module({s.module!r}))"]
            for a in s.names:
                full = f"{s.module}.{a.name}"
                parts.append(f"({a.asname or a.name} := getattr({m}, {a.name!r}) if hasattr({m}, {a.name!r}) else __import__('importlib').import_module({full!r}))")
            return parts
        if isinstance(s, ast.Assert):
            msg = self.u(s.msg) if s.msg else ""
            return [f"({self.u(s.test)} or (_ for _ in ()).throw(AssertionError({msg})))"]
        if isinstance(s, ast.Raise):
            if s.exc is None:
                raise _Unsupported("bare raise")
            return [f"(_ for _ in ()).throw({self.u(s.exc)})"]
        if isinstance(s, ast.Delete):
            parts = []
            for t in s.targets:
                if isinstance(t, ast.Subscript):
                    parts.append(f"{self.u(t.value)}.__delitem__({self.u(t.slice)})")
                elif isinstance(t, ast.Attribute):
                    parts.append(f"delattr({self.u(t.value)}, {t.attr!r})")
                else:
                    raise _Unsupported("del of a name")
            return parts
        if isinstance(s, ast.ClassDef):
            return [f"({s.name} := {self.class_expr(s)})"]
        raise _Unsupported(type(s).__name__)

    # functions
    def lambda_for(self, fn):
        if _has_yield(fn):
            raise _Unsupported("generator/async function")
        if _contains(fn.body, (ast.Global, ast.Nonlocal)):
            raise _Unsupported("global/nonlocal")
        body = self.seq(self.strip_doc(fn.body))
        args = self.u(fn.args)
        lam = f"(lambda {args}: {body})" if args else f"(lambda: {body})"
        for d in reversed(fn.decorator_list):
            lam = f"{self.u(d)}({lam})"
        return lam

    def strip_doc(self, stmts):
        if stmts and isinstance(stmts[0], ast.Expr) and isinstance(stmts[0].value, ast.Constant) and isinstance(stmts[0].value.value, str):
            return list(stmts[1:])
        return list(stmts)

    def seq(self, stmts):
        """Expression evaluating a function body and yielding its return value."""
        acc = []
        for idx, st in enumerate(stmts):
            if isinstance(st, ast.Return):
                ret = self.u(st.value) if st.value is not None else "None"
                return self.last(acc + [ret])
            if isinstance(st, ast.If) and _contains([st], (ast.Return,), stop_at=(ast.For, ast.While)):
                rest = stmts[idx + 1 :]
                a = self.seq(list(st.body) + rest)
                b = self.seq(list(st.orelse) + rest)
                return self.last(acc + [f"({a} if {self.u(st.test)} else {b})"])
            if _contains([st], (ast.Return,), stop_at=()):
                raise _Unsupported("return inside loop/try")
            acc.extend(self.stmt(st))
        return self.last(acc + ["None"])

    def class_expr(self, c):
        if c.keywords:
            raise _Unsupported("class keywords")
        ns = []
        for b in c.body:
            if isinstance(b, ast.FunctionDef):
                ns.append(f"{b.name!r}: {self.lambda_for(b)}")
            elif isinstance(b, ast.Assign) and len(b.targets) == 1 and isinstance(b.targets[0], ast.Name):
                ns.append(f"{b.targets[0].id!r}: {self.u(b.value)}")
            elif isinstance(b, ast.AnnAssign) and isinstance(b.target, ast.Name) and b.value is not None:
                ns.append(f"{b.target.id!r}: {self.u(b.value)}")
            elif isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant) and isinstance(b.value.value, str):
                ns.append(f"'__doc__': {self.u(b.value)}")
            elif isinstance(b, ast.Pass):
                pass
            else:
                raise _Unsupported(f"{type(b).__name__} in class body")
        bases = ", ".join(self.u(b) for b in c.bases)
        if len(c.bases) == 1:
            bases += ","
        expr = f"type({c.name!r}, ({bases}), {{{', '.join(ns)}}})"
        for d in reversed(c.decorator_list):
            expr = f"{self.u(d)}({expr})"
        return expr

    # module
    def module(self, tree):
        parts = []
        for s in tree.body:
            if isinstance(s, _SIMPLE) and not _has_yield(s):
                parts.append(self.u(s))
            else:
                parts.extend(self.stmt(s))
        return "; ".join(parts)


def oneline(code, path="main.py"):
    lines = code.count("\n") + (0 if code.endswith("\n") or not code else 1)
    try:
        tree = ast.parse(code, filename=path)
    except SyntaxError as e:
        return {"error": f"SyntaxError on line {e.lineno}: {e.msg}"}
    ol = _OneLiner(code)
    whole = False
    try:
        out = ol.module(tree)
        compile(out, path, "exec")
    except Exception as e:  # our rewrite produced something invalid: fall back entirely
        whole = True
        out = f"exec({code!r})"
        ol.fallbacks = [[1, "Module", f"{type(e).__name__}: {e}"]]
    out = out.replace("\n", "\\n")  # belt and braces: must be one physical line
    stem = path.rsplit("/", 1)[-1]
    out += f"  # one-lined by CrazyCodeEditor from {stem} ({lines} lines)"
    return {"code": out + "\n", "lines": lines, "chars": len(out), "fallbacks": ol.fallbacks, "whole": whole}

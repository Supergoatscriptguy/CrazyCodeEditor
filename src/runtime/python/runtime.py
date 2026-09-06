# Run worker: script runner, stdin, REPL namespace.
import sys, builtins, traceback, io, json, random, os, types

WORKSPACE = "/workspace"


class _NeedInput(BaseException):
    """Raised (replay mode) when input() is called with no buffered answer."""

    def __init__(self, prompt):
        self.prompt = prompt


class _Stdin(io.TextIOBase):
    def __init__(self):
        self.lines = []
        self.blocking_reader = None  # JS function in SAB mode
        self.in_repl = False

    def readable(self):
        return True

    def _next_line(self):
        sys.stdout.flush()
        if self.lines:
            return self.lines.pop(0)
        if self.blocking_reader is not None:
            line = self.blocking_reader()
            return "" if line is None else str(line)
        if self.in_repl:
            raise RuntimeError(
                "input() is not available in the REPL on this host; run it as a script instead."
            )
        raise _NeedInput("")

    def readline(self, size=-1):
        return self._next_line()

    def read(self, size=-1):
        chunks = []
        while True:
            line = self._next_line()
            if not line:
                break
            chunks.append(line)
        return "".join(chunks)

    def __iter__(self):
        return self

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line


_stdin = _Stdin()
sys.stdin = _stdin
sys.__stdin__ = _stdin


def _input(prompt=""):
    prompt = str(prompt)
    sys.stdout.write(prompt)
    sys.stdout.flush()
    try:
        line = _stdin._next_line()
    except _NeedInput:
        raise _NeedInput(prompt)
    if not line:
        raise EOFError("EOF when reading a line")
    return line.rstrip("\n")


builtins.input = _input

_repl_ns = {"__name__": "__main__", "__builtins__": builtins}


def _reset_user_modules():
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if isinstance(f, str) and f.startswith(WORKSPACE):
            del sys.modules[name]


# plots
_emit_image = None  # JS callback taking PNG bytes; set from the worker


def _crazy_set_image_emitter(fn):
    global _emit_image
    _emit_image = fn


def _crazy_flush_figures():
    """Sends every open matplotlib figure to the UI as PNG and closes it."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None or _emit_image is None:
        return 0
    n = 0
    try:
        nums = plt.get_fignums()
    except Exception:
        return 0
    for num in nums:
        try:
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=100, bbox_inches="tight", facecolor=fig.get_facecolor())
            _emit_image(buf.getvalue())
            n += 1
        except Exception as e:  # keep going; report once
            sys.stderr.write(f"[plot] could not render figure {num}: {e}\n")
    try:
        plt.close("all")
    except Exception:
        pass
    return n


def _crazy_prepare_plots(code=""):
    """If matplotlib is (or is about to be) used, make plt.show() render to the UI."""
    if "matplotlib" not in code and "matplotlib.pyplot" not in sys.modules:
        return
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return
    if getattr(plt, "_crazy_patched", False):
        return

    def _show(*args, **kwargs):
        _crazy_flush_figures()

    plt.show = _show
    plt._crazy_patched = True


# UI-thread watchdog
_time_limit = None  # seconds, only set when Python runs on the UI thread


def _crazy_set_time_limit(seconds):
    global _time_limit
    _time_limit = seconds


def _install_watchdog():
    if not _time_limit:
        return None
    import time

    deadline = time.monotonic() + _time_limit

    def tracer(frame, event, arg):
        # Global trace with no local tracing: only 'call' events, so it is cheap.
        if time.monotonic() > deadline:
            raise KeyboardInterrupt(
                f"stopped after {_time_limit} s: this host runs Python on the UI thread, "
                "so long-running programs freeze the app"
            )
        return None

    sys.settrace(tracer)
    return tracer


def _crazy_run(code, filename, seed, stdin_lines):
    """Runs a script. Returns a JSON string describing the outcome."""
    _stdin.lines = list(stdin_lines)
    _stdin.in_repl = False
    ns = {"__name__": "__main__", "__file__": filename, "__builtins__": builtins}
    random.seed(seed)
    os.chdir(WORKSPACE)
    sys.argv = [filename]
    if sys.path[0] != WORKSPACE:
        sys.path.insert(0, WORKSPACE)
    _reset_user_modules()
    _crazy_prepare_plots(code)
    result = {"ok": True, "exit": 0}
    watchdog = _install_watchdog()
    try:
        compiled = compile(code, filename, "exec")
        exec(compiled, ns)
        _crazy_flush_figures()
    except _NeedInput as e:
        result = {"needInput": e.prompt}
    except SystemExit as e:
        code_ = e.code
        if code_ is None:
            code_ = 0
        elif not isinstance(code_, int):
            sys.stderr.write(str(code_) + "\n")
            code_ = 1
        result = {"ok": code_ == 0, "exit": code_}
    except BaseException as e:
        sys.stdout.flush()
        tb = e.__traceback__
        if tb is not None:
            tb = tb.tb_next  # drop our exec() frame
        sys.stderr.write("".join(traceback.format_exception(type(e), e, tb)))
        result = {"ok": False, "exit": 1}
    finally:
        if watchdog is not None:
            sys.settrace(None)
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        _repl_ns.update({k: v for k, v in ns.items() if k not in ("__builtins__",)})
    return json.dumps(result)


# REPL
from pyodide.console import Console, repr_shorten  # noqa: E402

_repl = None


def _crazy_repl(stdout_cb, stderr_cb):
    global _repl
    _repl = Console(
        _repl_ns,
        stdout_callback=stdout_cb,
        stderr_callback=stderr_cb,
        persistent_stream_redirection=False,
        filename="<repl>",
    )
    return _repl


def _crazy_repl_display(value):
    if value is None:
        return ""
    return repr_shorten(value, limit=2000)


# workspace sync
_synced = {}


def _crazy_write_files(files_json, deleted_json):
    files = json.loads(files_json)
    deleted = json.loads(deleted_json)
    for rel in deleted:
        p = os.path.join(WORKSPACE, rel)
        try:
            if os.path.isdir(p):
                import shutil

                shutil.rmtree(p)
            else:
                os.remove(p)
        except FileNotFoundError:
            pass
        _synced.pop(rel, None)
    for rel, content in files.items():
        p = os.path.join(WORKSPACE, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        _synced[rel] = content


def _crazy_collect_changes():
    """Returns JSON of workspace text files whose content differs from what was synced in."""
    changed = {}
    for root, dirs, files in os.walk(WORKSPACE):
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith(".")]
        for name in files:
            p = os.path.join(root, name)
            rel = os.path.relpath(p, WORKSPACE).replace(os.sep, "/")
            try:
                if os.path.getsize(p) > 2_000_000:
                    continue
                with open(p, "r", encoding="utf-8", newline="") as f:
                    content = f.read()
            except (UnicodeDecodeError, OSError):
                continue
            if _synced.get(rel) != content:
                changed[rel] = content
                _synced[rel] = content
    return json.dumps(changed)

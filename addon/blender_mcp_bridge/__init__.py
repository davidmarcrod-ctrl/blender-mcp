"""MCP Bridge: a localhost socket that lets the blender-mcp server run Python in Blender.

Protocol (one request per connection, newline-terminated JSON both ways):
    request  {"lib": str, "body": str, "args": {...}, "undo": str | null}
    response {"ok": true, "data": ...} | {"ok": false, "error": {"message", "traceback", "line"}}

`lib` is executed first (shared helpers shipped by the MCP server, so updating the server
never requires reinstalling this add-on). `body` is a function body that may use `return`;
it runs as `__mcp_main(args)` on Blender's main thread (bpy is not thread-safe), via a timer.
"""

import ast
import json
import queue
import socket
import threading
import traceback

import bpy

DEFAULT_PORT = 9877
REQUEST_TIMEOUT_S = 600

_server = None
_jobs: "queue.Queue[_Job]" = queue.Queue()


class _Job:
    def __init__(self, payload):
        self.payload = payload
        self.done = threading.Event()
        self.response = None


# --- JSON serialization of Blender values -------------------------------------------

def _to_jsonable(value):
    try:
        import mathutils
        if isinstance(value, mathutils.Matrix):
            return [list(row) for row in value]
        if isinstance(value, (mathutils.Vector, mathutils.Euler, mathutils.Quaternion, mathutils.Color)):
            return list(value)
    except ImportError:
        pass
    if isinstance(value, bpy.types.ID):
        return {"id_type": type(value).__name__, "name": value.name}
    if isinstance(value, bpy.types.bpy_struct):
        return {"struct": type(value).__name__, "path": repr(value)}
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    if hasattr(value, "__len__") and hasattr(value, "__getitem__"):
        try:
            return [value[i] for i in range(len(value))]
        except Exception:
            pass
    return repr(value)


def _dumps(obj):
    return json.dumps(obj, default=_to_jsonable, ensure_ascii=False)


# --- Execution on the main thread ----------------------------------------------------

def _compile_body(body):
    """Wraps a body that may contain top-level `return` into `def __mcp_main(args):`.

    Done at the AST level (not by re-indenting text) so triple-quoted strings in the body
    are preserved exactly and line numbers in tracebacks match the body as sent.
    """
    tree = ast.parse(body, filename="<mcp-body>", mode="exec")
    func = ast.FunctionDef(
        name="__mcp_main",
        args=ast.arguments(posonlyargs=[], args=[ast.arg(arg="args")], kwonlyargs=[],
                           kw_defaults=[], defaults=[]),
        body=tree.body or [ast.Pass()],
        decorator_list=[],
        returns=None,
        type_params=[],
    )
    module = ast.Module(body=[func], type_ignores=[])
    ast.fix_missing_locations(module)
    return compile(module, "<mcp-body>", "exec")


def _execute(payload):
    try:
        namespace = {"bpy": bpy, "__name__": "__mcp__"}
        lib = payload.get("lib") or ""
        if lib:
            exec(compile(lib, "<mcp-lib>", "exec"), namespace)
        exec(_compile_body(payload.get("body") or ""), namespace)
        data = namespace["__mcp_main"](payload.get("args") or {})
        undo = payload.get("undo")
        if undo:
            try:
                bpy.ops.ed.undo_push(message=undo)
            except Exception:
                pass  # no undo stack in this context (e.g. background mode)
        text = _dumps({"ok": True, "data": data})
    except BaseException as e:  # noqa: BLE001 -- report everything, incl. SystemExit from user code
        line = None
        for frame in traceback.extract_tb(e.__traceback__):
            if frame.filename == "<mcp-body>":
                line = frame.lineno
        if isinstance(e, SyntaxError) and e.filename == "<mcp-body>":
            line = e.lineno
        text = _dumps({
            "ok": False,
            "error": {
                "message": f"{type(e).__name__}: {e}",
                "traceback": traceback.format_exc(limit=8),
                "line": line,
            },
        })
    return text


def _drain_jobs():
    while True:
        try:
            job = _jobs.get_nowait()
        except queue.Empty:
            break
        job.response = _execute(job.payload)
        job.done.set()
    return 0.02


# --- Socket server -------------------------------------------------------------------

class _Server:
    def __init__(self, port):
        self.port = port
        self.sock = None
        self.thread = None
        self.running = False

    def start(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", self.port))
        self.sock.listen(8)
        self.sock.settimeout(0.5)
        self.running = True
        self.thread = threading.Thread(target=self._accept_loop, name="mcp-bridge", daemon=True)
        self.thread.start()
        if not bpy.app.timers.is_registered(_drain_jobs):
            bpy.app.timers.register(_drain_jobs, persistent=True)

    def stop(self):
        self.running = False
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        if self.thread:
            self.thread.join(timeout=2)
        if bpy.app.timers.is_registered(_drain_jobs):
            bpy.app.timers.unregister(_drain_jobs)

    def _accept_loop(self):
        while self.running:
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        with conn:
            conn.settimeout(30)
            buf = b""
            try:
                while not buf.endswith(b"\n"):
                    chunk = conn.recv(1 << 16)
                    if not chunk:
                        return
                    buf += chunk
                payload = json.loads(buf.decode("utf-8"))
            except Exception as e:  # noqa: BLE001
                conn.sendall((_dumps({"ok": False, "error": {"message": f"Bad request: {e}"}}) + "\n").encode())
                return
            if payload.get("ping"):
                info = {"blender": bpy.app.version_string, "file": bpy.data.filepath}
                conn.sendall((_dumps({"ok": True, "data": info}) + "\n").encode())
                return
            job = _Job(payload)
            _jobs.put(job)
            if not job.done.wait(REQUEST_TIMEOUT_S):
                job.response = _dumps({"ok": False, "error": {"message": "Timed out waiting for Blender's main thread"}})
            conn.settimeout(None)
            conn.sendall((job.response + "\n").encode("utf-8"))


def start_server(port=None):
    global _server
    if _server and _server.running:
        return _server.port
    port = port or _prefs().port
    _server = _Server(port)
    _server.start()
    print(f"[MCP Bridge] listening on 127.0.0.1:{port}")
    return port


def stop_server():
    global _server
    if _server:
        _server.stop()
        _server = None
        print("[MCP Bridge] stopped")


def is_running():
    return bool(_server and _server.running)


# --- UI ------------------------------------------------------------------------------

def _prefs():
    return bpy.context.preferences.addons[__package__].preferences


class MCPBRIDGE_Preferences(bpy.types.AddonPreferences):
    bl_idname = __package__

    port: bpy.props.IntProperty(name="Port", default=DEFAULT_PORT, min=1024, max=65535)
    auto_start: bpy.props.BoolProperty(name="Start automatically with Blender", default=True)

    def draw(self, context):
        col = self.layout.column()
        col.prop(self, "port")
        col.prop(self, "auto_start")


class MCPBRIDGE_OT_start(bpy.types.Operator):
    bl_idname = "mcp_bridge.start"
    bl_label = "Start MCP Bridge"

    def execute(self, context):
        try:
            port = start_server()
        except OSError as e:
            self.report({"ERROR"}, f"Could not start MCP Bridge: {e}")
            return {"CANCELLED"}
        self.report({"INFO"}, f"MCP Bridge on 127.0.0.1:{port}")
        return {"FINISHED"}


class MCPBRIDGE_OT_stop(bpy.types.Operator):
    bl_idname = "mcp_bridge.stop"
    bl_label = "Stop MCP Bridge"

    def execute(self, context):
        stop_server()
        return {"FINISHED"}


class MCPBRIDGE_PT_panel(bpy.types.Panel):
    bl_label = "MCP Bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "MCP"

    def draw(self, context):
        layout = self.layout
        if is_running():
            layout.label(text=f"Running on port {_server.port}", icon="LINKED")
            layout.operator("mcp_bridge.stop", icon="PAUSE")
        else:
            layout.label(text="Stopped", icon="UNLINKED")
            layout.operator("mcp_bridge.start", icon="PLAY")


_classes = (MCPBRIDGE_Preferences, MCPBRIDGE_OT_start, MCPBRIDGE_OT_stop, MCPBRIDGE_PT_panel)


def _auto_start():
    try:
        if _prefs().auto_start and not bpy.app.background:
            start_server()
    except OSError as e:
        print(f"[MCP Bridge] auto-start failed: {e}")
    return None


def register():
    for cls in _classes:
        bpy.utils.register_class(cls)
    # Deferred: preferences aren't fully available during register at startup.
    bpy.app.timers.register(_auto_start, first_interval=0.5)


def unregister():
    stop_server()
    for cls in reversed(_classes):
        bpy.utils.unregister_class(cls)

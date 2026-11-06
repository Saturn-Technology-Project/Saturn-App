"""Holds one Jupyter kernel for a notebook open in Saturn, and speaks JSON lines: commands on standard input, events on
standard output. Run by Saturn with the project's Python. The kernel ends when this program does, and this program
ends when asked to or when Saturn closes its standard input."""
import sys

# Run with -c, Python looks in the project's folder first, where a file named queue.py must not replace the real one.
sys.path[:] = [entry for entry in sys.path if entry != ""]

import collections
import importlib.util
import json
import os
import platform
import queue
import signal
import threading

# How long a new kernel gets to answer, and how long a stopped one gets to end by itself.
READY_SECONDS = 120
SHUTDOWN_SECONDS = 2
# How often waiting stops to look at commands and at whether the kernel is alive.
POLL_SECONDS = 0.1

# Events have a stream of their own. Whatever else writes to standard output, a kernel's library included, goes to
# standard error, so it cannot break a line of the protocol.
EVENTS = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)


def say(**event):
    """Sends one event. If Saturn is gone there is nobody to tell, and standard input closing ends this program."""
    try:
        EVENTS.write(json.dumps(event) + "\n")
        EVENTS.flush()
    except (OSError, ValueError):
        pass


def read_commands(commands):
    """Queues what Saturn asks for. When Saturn goes, its pipe closes, and that asks for a stop."""
    for line in sys.stdin:
        try:
            commands.put(json.loads(line))
        except ValueError:
            continue
    commands.put({"op": "stop"})


def output_of(message):
    """A kernel's message as a notebook's stored output, or nothing when it is not one."""
    kind = message["msg_type"]
    content = message["content"]
    if kind == "stream":
        return {"output_type": "stream", "name": content.get("name", "stdout"), "text": content.get("text", "")}
    if kind == "display_data":
        return {"output_type": "display_data", "data": content.get("data", {}), "metadata": content.get("metadata", {})}
    if kind == "execute_result":
        return {
            "output_type": "execute_result",
            "data": content.get("data", {}),
            "metadata": content.get("metadata", {}),
            "execution_count": content.get("execution_count"),
        }
    if kind == "error":
        return {
            "output_type": "error",
            "ename": content.get("ename", ""),
            "evalue": content.get("evalue", ""),
            "traceback": content.get("traceback", []),
        }
    return None


class Holder:
    """One kernel and the cells waiting for it. Everything happens on the main thread, between waits."""

    def __init__(self, manager, client, commands):
        self.manager = manager
        self.client = client
        self.commands = commands
        self.pending = collections.deque()
        self.stopping = False
        self.restarting = False
        self.dead = False

    def obey(self, command, running):
        """Does what one command asks. Stopping and restarting only take effect once the running cell is let go."""
        action = command.get("op")
        if action == "run":
            self.pending.append(command)
        elif action == "interrupt":
            if not self.dead:
                self.manager.interrupt_kernel()
        elif action == "restart":
            self.restarting = True
        elif action == "stop":
            self.stopping = True
        if not running:
            self.settle()

    def skip_pending(self):
        """Lets go of the cells still waiting: they follow a cell that did not finish."""
        while self.pending:
            say(event="finished", cell=self.pending.popleft().get("cell"), status="skipped", count=None)

    def settle(self):
        """Carries out a restart asked for."""
        if not self.restarting or self.stopping:
            return
        self.restarting = False
        self.skip_pending()
        try:
            self.manager.restart_kernel(now=True)
            self.client.wait_for_ready(timeout=READY_SECONDS)
        except Exception as error:  # noqa: BLE001 - whatever stops a kernel from starting is the answer
            say(event="failed", message=f"The kernel could not restart: {error}")
            self.dead = True
            self.stopping = True
            return
        self.dead = False
        say(event="restarted")

    def run_cell(self, cell, code):
        """Runs one cell and passes on what it produces, until the kernel is idle again or the cell is let go."""
        say(event="started", cell=cell)
        identity = self.client.execute(code, allow_stdin=False, stop_on_error=True)
        status = "ok"
        while True:
            self.obey_waiting()
            if self.stopping or self.restarting:
                self.finish(cell, "aborted", None)
                return
            try:
                message = self.client.get_iopub_msg(timeout=POLL_SECONDS)
            except queue.Empty:
                if not self.manager.is_alive():
                    self.dead = True
                    self.finish(cell, "dead", None)
                    say(event="dead")
                    return
                continue
            if message["parent_header"].get("msg_id") != identity:
                continue
            kind = message["msg_type"]
            if kind == "status" and message["content"].get("execution_state") == "idle":
                break
            if kind == "clear_output":
                say(event="clear", cell=cell, wait=bool(message["content"].get("wait")))
                continue
            output = output_of(message)
            if output is not None:
                if kind == "error":
                    status = "error"
                say(event="output", cell=cell, output=output)
        count, status = self.reply_of(identity, status)
        self.finish(cell, status, count)

    def reply_of(self, identity, status):
        """The cell's execution count and how it ended, from the kernel's reply to it."""
        while True:
            try:
                reply = self.client.get_shell_msg(timeout=SHUTDOWN_SECONDS)
            except queue.Empty:
                return None, status
            if reply["parent_header"].get("msg_id") == identity:
                content = reply["content"]
                return content.get("execution_count"), content.get("status", status)

    def finish(self, cell, status, count):
        """Says how a cell ended. Cells waiting after one that did not finish do not run, as in Jupyter."""
        say(event="finished", cell=cell, status=status, count=count)
        if status != "ok":
            self.skip_pending()

    def obey_waiting(self):
        """Does whatever has been asked while a cell runs."""
        while True:
            try:
                command = self.commands.get_nowait()
            except queue.Empty:
                return
            self.obey(command, running=True)

    def run(self):
        """Works through commands until asked to stop."""
        while not self.stopping:
            if self.pending:
                next_cell = self.pending.popleft()
                if self.dead:
                    self.finish(next_cell.get("cell"), "dead", None)
                else:
                    self.run_cell(next_cell.get("cell"), next_cell.get("code", ""))
                self.settle()
                continue
            try:
                self.obey(self.commands.get(timeout=1), running=False)
            except queue.Empty:
                if not self.dead and not self.manager.is_alive():
                    self.dead = True
                    say(event="dead")
        self.skip_pending()

    def stop(self):
        """Ends the kernel and what it started: asked first when it is idle and alive, else at once."""
        self.client.stop_channels()
        self.manager.shutdown_wait_time = SHUTDOWN_SECONDS
        self.manager.shutdown_kernel(now=self.dead)


def main():
    """Starts the kernel in the notebook's folder, with this Python, and holds it until asked to stop."""
    missing = [name for name in ("jupyter_client", "ipykernel") if importlib.util.find_spec(name) is None]
    if missing:
        say(event="missing", packages=missing)
        return
    commands = queue.SimpleQueue()
    signal.signal(signal.SIGTERM, lambda *_: commands.put({"op": "stop"}))
    threading.Thread(target=read_commands, args=(commands,), daemon=True).start()
    try:
        from jupyter_client.kernelspec import KernelSpec
        from jupyter_client.manager import KernelManager

        manager = KernelManager()
        # Named here rather than looked up by name, since a kernel spec named python3 in the person's own Jupyter
        # folder could start another Python than this project's.
        manager._kernel_spec = KernelSpec(
            argv=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            display_name="Python",
            language="python",
        )
        manager.start_kernel(cwd=sys.argv[1], env=dict(os.environ))
        client = manager.client()
        client.start_channels()
        client.wait_for_ready(timeout=READY_SECONDS)
    except Exception as error:  # noqa: BLE001 - whatever stops a kernel from starting is the answer
        say(event="failed", message=f"The kernel could not start: {error}")
        return
    say(event="ready", python=sys.executable, version=platform.python_version())
    holder = Holder(manager, client, commands)
    try:
        holder.run()
    finally:
        holder.stop()


if __name__ == "__main__":
    main()

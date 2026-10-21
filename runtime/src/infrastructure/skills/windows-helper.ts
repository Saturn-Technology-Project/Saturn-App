/**
 * The Windows desktop helper: C# compiled once by Windows PowerShell 5.1 (Add-Type, so C# 5: no string interpolation,
 * no `out _`, no `?.`) and then serving JSON requests on stdin, one per line, with one JSON reply per line on stdout.
 *
 * - Input: SendInput (mouse, wheel, virtual keys, and KEYEVENTF_UNICODE for typing any text).
 * - Screenshots: GDI+ CopyFromScreen, scaled to the canvas and saved as JPEG.
 * - Windows and apps: EnumWindows, SetForegroundWindow (with AttachThreadInput to get past the foreground lock),
 *   DWM frame bounds.
 * - The element tree: UI Automation (System.Windows.Automation), the Windows counterpart of macOS accessibility.
 *
 * The process is per-monitor DPI aware, so screen sizes, window frames, cursor positions and screenshots all use
 * physical pixels.
 */
export const WINDOWS_HELPER_SOURCE = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class SaturnDesktop
{
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder buffer, int length, out int needed);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000, WHEEL = 0x0800, HWHEEL = 0x1000;
    const uint KEYUP = 0x0002, UNICODE = 0x0004, EXTENDED = 0x0001;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 100 };

    public static void Serve()
    {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.AutoFlush = true;
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        stdout.WriteLine("{\"ready\":true}");
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            object id = null;
            var reply = new Dictionary<string, object>();
            try
            {
                var request = Json.Deserialize<Dictionary<string, object>>(line);
                id = request.ContainsKey("id") ? request["id"] : null;
                reply["result"] = Dispatch(Str(request, "op"), request);
                reply["ok"] = true;
            }
            catch (Exception error)
            {
                var inner = error;
                while (inner.InnerException != null) inner = inner.InnerException;
                reply["ok"] = false;
                reply["error"] = inner.Message;
            }
            reply["id"] = id;
            stdout.WriteLine(Json.Serialize(reply));
        }
    }

    static object Dispatch(string op, Dictionary<string, object> r)
    {
        switch (op)
        {
            case "locked": return Locked();
            case "display": return Display();
            case "capture": return Capture(Int(r, "x"), Int(r, "y"), Int(r, "width"), Int(r, "height"), Int(r, "canvasWidth"), Int(r, "canvasHeight"));
            case "apps": return Apps();
            case "launch": Process.Start(new ProcessStartInfo(Str(r, "target")) { UseShellExecute = true }); return null;
            case "activate": Activate(Int(r, "pid")); return null;
            case "frame": return Frame(Int(r, "pid"));
            case "mouse": Mouse(Str(r, "kind"), Int(r, "x"), Int(r, "y"), Int(r, "toX"), Int(r, "toY"), Str(r, "button"), Int(r, "count")); return null;
            case "scroll": Scroll(Int(r, "x"), Int(r, "y"), Int(r, "dx"), Int(r, "dy")); return null;
            case "key": Key(Ints(r, "modifiers"), Int(r, "vk"), Str(r, "char"), r.ContainsKey("extended") && (bool)r["extended"]); return null;
            case "type": TypeText(Str(r, "text")); return null;
            case "tree": return Tree(Int(r, "pid"), Ints(r, "root"), Int(r, "limit"), Int(r, "depth"));
            case "action": Act(Int(r, "pid"), Ints(r, "path"), Str(r, "action")); return null;
            case "setValue": SetValue(Int(r, "pid"), Ints(r, "path"), Str(r, "value"), r.ContainsKey("focusOnly") && (bool)r["focusOnly"]); return null;
            default: throw new Exception("Unknown operation " + op);
        }
    }

    static string Str(Dictionary<string, object> r, string key) { return r.ContainsKey(key) && r[key] != null ? Convert.ToString(r[key]) : ""; }
    static int Int(Dictionary<string, object> r, string key) { return r.ContainsKey(key) && r[key] != null ? Convert.ToInt32(r[key]) : 0; }
    static int[] Ints(Dictionary<string, object> r, string key)
    {
        if (!r.ContainsKey(key) || r[key] == null) return new int[0];
        var list = new List<int>();
        foreach (var item in (IEnumerable)r[key]) list.Add(Convert.ToInt32(item));
        return list.ToArray();
    }

    // The input desktop is "Default" while the user is signed in and unlocked; the lock screen is "Winlogon".
    static bool Locked()
    {
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
        if (desktop == IntPtr.Zero) return true;
        try
        {
            var name = new StringBuilder(256);
            int needed;
            GetUserObjectInformation(desktop, 2, name, 512, out needed);
            return !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        }
        finally { CloseDesktop(desktop); }
    }

    static Dictionary<string, object> Display()
    {
        return new Dictionary<string, object> { { "width", GetSystemMetrics(0) }, { "height", GetSystemMetrics(1) } };
    }

    static string Capture(int x, int y, int width, int height, int canvasWidth, int canvasHeight)
    {
        if (width <= 0 || height <= 0) throw new Exception("Nothing to capture: the region is empty");
        using (var shot = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            using (var scaled = new Bitmap(canvasWidth, canvasHeight, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(scaled))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.DrawImage(shot, 0, 0, canvasWidth, canvasHeight);
                }
                var jpeg = ImageCodecInfo.GetImageEncoders().First(e => e.MimeType == "image/jpeg");
                var options = new EncoderParameters(1);
                options.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
                using (var memory = new MemoryStream())
                {
                    scaled.Save(memory, jpeg, options);
                    return Convert.ToBase64String(memory.ToArray());
                }
            }
        }
    }

    // Top-level visible windows with a title, unowned (not dialogs or tool windows of another window).
    static List<IntPtr> TopWindows()
    {
        var found = new List<IntPtr>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
        {
            if (IsWindowVisible(hWnd) && GetWindow(hWnd, 4) == IntPtr.Zero && GetWindowTextLength(hWnd) > 0) found.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static IntPtr WindowOf(int pid)
    {
        foreach (var hWnd in TopWindows())
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if ((int)owner == pid) return hWnd;
        }
        try { return Process.GetProcessById(pid).MainWindowHandle; } catch { return IntPtr.Zero; }
    }

    static List<Dictionary<string, object>> Apps()
    {
        uint front;
        GetWindowThreadProcessId(GetForegroundWindow(), out front);
        var pids = new HashSet<int>();
        foreach (var hWnd in TopWindows())
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            pids.Add((int)owner);
        }
        var apps = new List<Dictionary<string, object>>();
        foreach (var pid in pids)
        {
            try
            {
                var process = Process.GetProcessById(pid);
                string path = "", name = process.ProcessName;
                try
                {
                    path = process.MainModule.FileName;
                    var description = process.MainModule.FileVersionInfo.FileDescription;
                    if (!string.IsNullOrWhiteSpace(description)) name = description;
                }
                catch { }
                apps.Add(new Dictionary<string, object> {
                    { "name", name }, { "pid", pid }, { "bundle_id", path }, { "process", process.ProcessName },
                    { "window_title", process.MainWindowTitle }, { "frontmost", pid == (int)front } });
            }
            catch { }
        }
        return apps;
    }

    static void Activate(int pid)
    {
        IntPtr hWnd = WindowOf(pid);
        if (hWnd == IntPtr.Zero) throw new Exception("The app has no open window");
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        uint ignored;
        uint frontThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
        uint thisThread = GetCurrentThreadId();
        bool attached = frontThread != thisThread && AttachThreadInput(thisThread, frontThread, true);
        SetForegroundWindow(hWnd);
        BringWindowToTop(hWnd);
        if (attached) AttachThreadInput(thisThread, frontThread, false);
        if (GetForegroundWindow() != hWnd)
        {
            // Windows only lets the process that received the last input take the foreground: a tap of Alt counts.
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(hWnd);
        }
        Thread.Sleep(250);
        if (GetForegroundWindow() != hWnd) throw new Exception("Windows did not bring the app to the front");
    }

    static Dictionary<string, object> Frame(int pid)
    {
        IntPtr hWnd = WindowOf(pid);
        if (hWnd == IntPtr.Zero) throw new Exception("The app has no open window");
        RECT r;
        if (DwmGetWindowAttribute(hWnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(hWnd, out r);
        return new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "width", r.Right - r.Left }, { "height", r.Bottom - r.Top } };
    }

    static void Send(List<INPUT> inputs)
    {
        if (inputs.Count == 0) return;
        uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Count)
            throw new Exception("Windows blocked the input (error " + Marshal.GetLastWin32Error() + "). The app may be running as administrator, which Saturn cannot control unless it runs as administrator too.");
    }

    static INPUT MouseInput(uint flags, int dx, int dy, uint data)
    {
        var input = new INPUT { type = INPUT_MOUSE };
        input.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
        return input;
    }

    // Absolute moves are in 0..65535 across the virtual desktop.
    static INPUT MoveTo(int x, int y)
    {
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = Math.Max(1, GetSystemMetrics(78) - 1), height = Math.Max(1, GetSystemMetrics(79) - 1);
        return MouseInput(MOVE | ABSOLUTE | VIRTUALDESK, (int)Math.Round((x - left) * 65535.0 / width), (int)Math.Round((y - top) * 65535.0 / height), 0);
    }

    static void Mouse(string kind, int x, int y, int toX, int toY, string button, int count)
    {
        uint down = 0x0002, up = 0x0004;
        if (button == "right") { down = 0x0008; up = 0x0010; }
        if (button == "middle") { down = 0x0020; up = 0x0040; }
        SetCursorPos(x, y);
        Send(new List<INPUT> { MoveTo(x, y) });
        if (kind == "move") return;
        if (kind == "click")
        {
            count = Math.Max(1, Math.Min(3, count));
            for (int i = 0; i < count; i++)
            {
                Send(new List<INPUT> { MouseInput(down, 0, 0, 0), MouseInput(up, 0, 0, 0) });
                if (i < count - 1) Thread.Sleep(40);
            }
            return;
        }
        Send(new List<INPUT> { MouseInput(down, 0, 0, 0) });
        for (int i = 1; i <= 12; i++)
        {
            Thread.Sleep(15);
            Send(new List<INPUT> { MoveTo(x + (toX - x) * i / 12, y + (toY - y) * i / 12) });
        }
        Send(new List<INPUT> { MouseInput(up, 0, 0, 0) });
    }

    // Wheel ticks of 120: positive dy scrolls up (wheel away from the user); positive dx scrolls left, as on macOS.
    static void Scroll(int x, int y, int dx, int dy)
    {
        SetCursorPos(x, y);
        Send(new List<INPUT> { MoveTo(x, y) });
        for (int i = 0; i < Math.Max(Math.Abs(dx), Math.Abs(dy)); i++)
        {
            var inputs = new List<INPUT>();
            if (i < Math.Abs(dy)) inputs.Add(MouseInput(WHEEL, 0, 0, (uint)(Math.Sign(dy) * 120)));
            if (i < Math.Abs(dx)) inputs.Add(MouseInput(HWHEEL, 0, 0, (uint)(-Math.Sign(dx) * 120)));
            Send(inputs);
            Thread.Sleep(20);
        }
    }

    static INPUT KeyInput(ushort vk, ushort scan, uint flags)
    {
        var input = new INPUT { type = INPUT_KEYBOARD };
        input.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
        return input;
    }

    static void Key(int[] modifiers, int vk, string ch, bool extended)
    {
        var mods = new List<int>(modifiers);
        if (vk == 0)
        {
            if (string.IsNullOrEmpty(ch)) throw new Exception("No key given");
            short scan = VkKeyScan(ch[0]);
            if (scan == -1) throw new Exception("The keyboard layout has no key for \"" + ch + "\"");
            vk = scan & 0xff;
            int shift = (scan >> 8) & 0xff;
            if ((shift & 1) != 0 && !mods.Contains(0x10)) mods.Add(0x10);
            if ((shift & 2) != 0 && !mods.Contains(0x11)) mods.Add(0x11);
            if ((shift & 4) != 0 && !mods.Contains(0x12)) mods.Add(0x12);
        }
        var inputs = new List<INPUT>();
        foreach (var mod in mods) inputs.Add(KeyInput((ushort)mod, 0, mod == 0x5B ? EXTENDED : 0));
        inputs.Add(KeyInput((ushort)vk, 0, extended ? EXTENDED : 0));
        inputs.Add(KeyInput((ushort)vk, 0, (extended ? EXTENDED : 0) | KEYUP));
        for (int i = mods.Count - 1; i >= 0; i--) inputs.Add(KeyInput((ushort)mods[i], 0, (mods[i] == 0x5B ? EXTENDED : 0) | KEYUP));
        Send(inputs);
    }

    // Unicode input types any text (Chinese, emoji) regardless of the keyboard layout; line breaks are Return.
    static void TypeText(string text)
    {
        var inputs = new List<INPUT>();
        foreach (char c in text)
        {
            if (c == '\r') continue;
            if (c == '\n') { inputs.Add(KeyInput(0x0D, 0, 0)); inputs.Add(KeyInput(0x0D, 0, KEYUP)); continue; }
            if (c == '\t') { inputs.Add(KeyInput(0x09, 0, 0)); inputs.Add(KeyInput(0x09, 0, KEYUP)); continue; }
            inputs.Add(KeyInput(0, c, UNICODE));
            inputs.Add(KeyInput(0, c, UNICODE | KEYUP));
        }
        for (int start = 0; start < inputs.Count; start += 200)
        {
            Send(inputs.GetRange(start, Math.Min(200, inputs.Count - start)));
            Thread.Sleep(10);
        }
    }

    static AutomationElement Element(int pid, int[] path)
    {
        IntPtr hWnd = WindowOf(pid);
        if (hWnd == IntPtr.Zero) throw new Exception("The app has no open window");
        AutomationElement element = AutomationElement.FromHandle(hWnd);
        var walker = TreeWalker.ControlViewWalker;
        foreach (int index in path)
        {
            AutomationElement child = walker.GetFirstChild(element);
            for (int i = 0; i < index && child != null; i++) child = walker.GetNextSibling(child);
            if (child == null) throw new Exception("This element is gone; read computer_app_state again.");
            element = child;
        }
        return element;
    }

    static bool Has(AutomationElement element, AutomationProperty available)
    {
        try { return (bool)element.GetCurrentPropertyValue(available); } catch { return false; }
    }

    static Dictionary<string, object> Node(AutomationElement element, int[] path, int depth)
    {
        string role = "Unknown", name = "", value = "";
        bool settable = false;
        var actions = new List<string>();
        try { role = element.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { }
        try { name = element.Current.Name ?? ""; } catch { }
        if (Has(element, AutomationElement.IsValuePatternAvailableProperty))
        {
            try
            {
                var pattern = (ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern);
                value = pattern.Current.Value ?? "";
                settable = !pattern.Current.IsReadOnly;
            }
            catch { }
        }
        else if (Has(element, AutomationElement.IsTextPatternAvailableProperty))
        {
            // Documents and rich edits (Notepad's text area, for one) expose their text through TextPattern only.
            try
            {
                value = ((TextPattern)element.GetCurrentPattern(TextPattern.Pattern)).DocumentRange.GetText(400) ?? "";
                settable = element.Current.IsKeyboardFocusable && element.Current.IsEnabled;
            }
            catch { }
        }
        if (Has(element, AutomationElement.IsTogglePatternAvailableProperty))
        {
            actions.Add("AXToggle");
            try { if (value.Length == 0) value = ((TogglePattern)element.GetCurrentPattern(TogglePattern.Pattern)).Current.ToggleState.ToString(); } catch { }
        }
        if (Has(element, AutomationElement.IsExpandCollapsePatternAvailableProperty)) { actions.Add("AXExpand"); actions.Add("AXCollapse"); }
        if (Has(element, AutomationElement.IsSelectionItemPatternAvailableProperty)) actions.Add("AXSelect");
        if (Has(element, AutomationElement.IsScrollItemPatternAvailableProperty)) actions.Add("AXScrollToVisible");
        if (value.Length > 200) value = value.Substring(0, 200);
        return new Dictionary<string, object> {
            { "path", path }, { "depth", depth }, { "role", role }, { "name", name }, { "value", value },
            { "actions", actions }, { "settable", settable }, { "omitted", 0 } };
    }

    // Breadth-first, a level at a time, up to limit elements.
    static List<Dictionary<string, object>> Tree(int pid, int[] root, int limit, int depth)
    {
        if (limit <= 0) limit = 250;
        if (depth <= 0) depth = 12;
        var walker = TreeWalker.ControlViewWalker;
        var nodes = new List<Dictionary<string, object>>();
        var level = new List<KeyValuePair<AutomationElement, int[]>> { new KeyValuePair<AutomationElement, int[]>(Element(pid, root), root) };
        int levelDepth = 0;
        while (level.Count > 0 && nodes.Count < limit && levelDepth < depth)
        {
            var next = new List<KeyValuePair<AutomationElement, int[]>>();
            foreach (var parent in level)
            {
                if (nodes.Count >= limit) break;
                AutomationElement child = null;
                try { child = walker.GetFirstChild(parent.Key); } catch { }
                int index = 0;
                while (child != null)
                {
                    if (nodes.Count >= limit)
                    {
                        int more = 0;
                        while (child != null) { more++; try { child = walker.GetNextSibling(child); } catch { child = null; } }
                        nodes[nodes.Count - 1]["omitted"] = (int)nodes[nodes.Count - 1]["omitted"] + more;
                        break;
                    }
                    var path = parent.Value.Concat(new[] { index }).ToArray();
                    nodes.Add(Node(child, path, levelDepth + 1));
                    next.Add(new KeyValuePair<AutomationElement, int[]>(child, path));
                    index++;
                    try { child = walker.GetNextSibling(child); } catch { child = null; }
                }
            }
            level = next;
            levelDepth++;
        }
        return nodes;
    }

    static object Pattern(AutomationElement element, AutomationPattern pattern)
    {
        object found;
        return element.TryGetCurrentPattern(pattern, out found) ? found : null;
    }

    static void Act(int pid, int[] path, string action)
    {
        var element = Element(pid, path);
        object p;
        switch (action)
        {
            case "AXPress":
                if ((p = Pattern(element, InvokePattern.Pattern)) != null) { ((InvokePattern)p).Invoke(); return; }
                if ((p = Pattern(element, TogglePattern.Pattern)) != null) { ((TogglePattern)p).Toggle(); return; }
                if ((p = Pattern(element, SelectionItemPattern.Pattern)) != null) { ((SelectionItemPattern)p).Select(); return; }
                if ((p = Pattern(element, ExpandCollapsePattern.Pattern)) != null)
                {
                    var expand = (ExpandCollapsePattern)p;
                    if (expand.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) expand.Expand(); else expand.Collapse();
                    return;
                }
                break;
            case "AXToggle":
                if ((p = Pattern(element, TogglePattern.Pattern)) != null) { ((TogglePattern)p).Toggle(); return; }
                break;
            case "AXExpand":
                if ((p = Pattern(element, ExpandCollapsePattern.Pattern)) != null) { ((ExpandCollapsePattern)p).Expand(); return; }
                break;
            case "AXCollapse":
                if ((p = Pattern(element, ExpandCollapsePattern.Pattern)) != null) { ((ExpandCollapsePattern)p).Collapse(); return; }
                break;
            case "AXSelect":
                if ((p = Pattern(element, SelectionItemPattern.Pattern)) != null) { ((SelectionItemPattern)p).Select(); return; }
                break;
            case "AXScrollToVisible":
                if ((p = Pattern(element, ScrollItemPattern.Pattern)) != null) { ((ScrollItemPattern)p).ScrollIntoView(); return; }
                break;
            case "AXFocus":
                element.SetFocus();
                return;
            case "AXShowMenu":
                var bounds = element.Current.BoundingRectangle;
                Mouse("click", (int)(bounds.Left + bounds.Width / 2), (int)(bounds.Top + bounds.Height / 2), 0, 0, "right", 1);
                return;
        }
        throw new Exception("This element does not support " + action.Replace("AX", "") + ". Click it instead.");
    }

    static void SetValue(int pid, int[] path, string value, bool focusOnly)
    {
        var element = Element(pid, path);
        try { element.SetFocus(); } catch { }
        if (focusOnly) return;
        object p = Pattern(element, ValuePattern.Pattern);
        if (p != null && !((ValuePattern)p).Current.IsReadOnly) { ((ValuePattern)p).SetValue(value); return; }
        if (Pattern(element, TextPattern.Pattern) != null && element.Current.IsKeyboardFocusable)
        {
            // A text-only control: replace its contents the way a person would, select all and type.
            Thread.Sleep(100);
            Key(new int[] { 0x11 }, 0, "a", false);
            if (value.Length == 0) Key(new int[0], 0x2E, "", true); else TypeText(value);
            return;
        }
        throw new Exception("This element has no settable value. Click it and use computer_type instead.");
    }
}
`;

/** Windows PowerShell 5.1 script that compiles the helper and hands stdin/stdout to it. */
export const WINDOWS_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Web.Extensions, UIAutomationClient, UIAutomationTypes, WindowsBase
$source = [System.IO.File]::ReadAllText($args[0])
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Core, System.Drawing, System.Web.Extensions, UIAutomationClient, UIAutomationTypes, WindowsBase
[SaturnDesktop]::Serve()
`;
